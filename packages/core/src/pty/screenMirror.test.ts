import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { emitPtyData, emitPtyExit, emitPtyResize, emitPtySpawn } from './events.js'
import {
  applyModeSequences,
  HOT_IDLE_MS,
  isMirrorHot,
  mirrorSnapshot,
  RING_CHARS,
  screenText,
  terminalModes
} from './screenMirror.js'

let next = 0
function spawn(cols = 80, rows = 24): string {
  const id = `mirror-test-${++next}`
  emitPtySpawn(id, 1, { cols, rows })
  return id
}

/** What the old always-on mirror held: one terminal fed every chunk. */
async function reference(
  chunks: string[],
  cols = 80,
  rows = 24
): Promise<{ term: Terminal; serializer: SerializeAddon }> {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)
  for (const chunk of chunks) term.write(chunk)
  await new Promise<void>((resolve) => term.write('', resolve))
  return { term, serializer }
}

function lastLines(term: Terminal, lines: number): string {
  const buffer = term.buffer.active
  const out: string[] = []
  let parts: string[] = []
  for (let y = buffer.length - 1; y >= 0 && out.length < lines; y--) {
    const line = buffer.getLine(y)
    if (!line) continue
    parts.push(line.translateToString(true))
    if (line.isWrapped && y > 0) continue
    const text = parts.reverse().join('').trimEnd()
    parts = []
    if (out.length === 0 && text.trim() === '') continue
    out.push(text)
  }
  return out.reverse().join('\n')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('mode scan', () => {
  it('tracks bracketed paste across chunk boundaries', async () => {
    const id = spawn()
    expect((await terminalModes(id))?.bracketedPaste).toBe(false)
    emitPtyData(id, 1, 'hello \x1b[?20')
    expect((await terminalModes(id))?.bracketedPaste).toBe(false)
    emitPtyData(id, 1, '04h world')
    expect((await terminalModes(id))?.bracketedPaste).toBe(true)
    emitPtyData(id, 1, '\x1b')
    emitPtyData(id, 1, '[?2004l')
    expect((await terminalModes(id))?.bracketedPaste).toBe(false)
    emitPtyData(id, 1, '\x1b[?1;2004h')
    expect((await terminalModes(id))?.bracketedPaste).toBe(true)
    // Not parsed for that.
    expect(isMirrorHot(id)).toBe(false)
    emitPtyData(id, 1, '\x1bc')
    expect((await terminalModes(id))?.bracketedPaste).toBe(false)
  })

  it('agrees with xterm on a mixed stream', async () => {
    const chunks = ['\x1b[?2004h', 'a\x1b[!p', 'b\x1b[?1049h\x1b[?2004', 'h\x1b[?1049l', 'c']
    const id = spawn()
    for (const chunk of chunks) emitPtyData(id, 1, chunk)
    const { term } = await reference(chunks)
    expect((await terminalModes(id))?.bracketedPaste).toBe(term.modes.bracketedPasteMode)
  })

  it('keeps unchanged mode maps identical (no allocation per chunk)', () => {
    const modes = new Map([[2004, true]])
    expect(applyModeSequences(modes, 'plain \x1b[31mred')).toBe(modes)
    expect(applyModeSequences(modes, '\x1b[?2004l').get(2004)).toBe(false)
  })
})

describe('lazy screen', () => {
  it('snapshot and screen text equal the always-parsed terminal for a sample stream', async () => {
    const chunks: string[] = []
    for (let i = 0; i < 400; i++) {
      chunks.push(`\x1b[3${i % 8}mline ${i}\x1b[0m ${'x'.repeat(i % 90)}\r\n`)
      if (i % 50 === 0) chunks.push('\x1b[2;5Hcursor\x1b[K\x1b[24;1H')
    }
    chunks.push('\x1b[?2004h\x1b[?1h> prompt')
    const id = spawn()
    for (const chunk of chunks) emitPtyData(id, 1, chunk)
    expect(isMirrorHot(id)).toBe(false)

    const { term, serializer } = await reference(chunks)
    const snap = await mirrorSnapshot(id)
    expect(snap?.data).toBe(serializer.serialize({ scrollback: 400 }))
    expect(snap?.pending).toBe('')
    expect(await screenText(id, 300)).toBe(lastLines(term, 300))
    expect(isMirrorHot(id)).toBe(true)

    // Kept up to date while hot.
    emitPtyData(id, 1, '\r\nmore')
    term.write('\r\nmore')
    await new Promise<void>((resolve) => term.write('', resolve))
    expect(await screenText(id, 50)).toBe(lastLines(term, 50))
  })

  it('a stream longer than the ring still reads back its last lines and modes', async () => {
    const chunks: string[] = ['\x1b[?2004h\x1b[?1h']
    let total = 0
    for (let i = 0; total < RING_CHARS * 2; i++) {
      // Chunk boundaries inside escape sequences, on purpose.
      const line = `\x1b[1;3${i % 8}mrow ${i} ${'-'.repeat(60)}\x1b[0m\r\n`
      chunks.push(line.slice(0, 3), line.slice(3))
      total += line.length
    }
    const id = spawn()
    for (const chunk of chunks) emitPtyData(id, 1, chunk)
    const { term, serializer } = await reference(chunks)
    expect(await screenText(id, 300)).toBe(lastLines(term, 300))
    expect((await terminalModes(id))?.bracketedPaste).toBe(true)
    // Modes set before the ring's start are re-applied (DECCKM shows in the serialized modes).
    const snap = await mirrorSnapshot(id)
    expect(snap?.data.endsWith(serializer.serialize({ scrollback: 400 }).slice(-2000))).toBe(true)
    expect(snap?.data).toContain('\x1b[?1h')
  })

  it('follows resizes and drops the parsed screen after a quiet spell', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const id = spawn(80, 24)
    emitPtyData(id, 1, 'hello')
    emitPtyResize(id, 100, 30)
    const reading = mirrorSnapshot(id)
    await vi.advanceTimersByTimeAsync(10)
    const snap = await reading
    expect(snap).toMatchObject({ cols: 100, rows: 30 })
    expect(isMirrorHot(id)).toBe(true)
    await vi.advanceTimersByTimeAsync(HOT_IDLE_MS + 10)
    expect(isMirrorHot(id)).toBe(false)
    // Rebuilt on the next read.
    const again = screenText(id, 5)
    await vi.advanceTimersByTimeAsync(10)
    expect(await again).toBe('hello')
  })

  it('forgets an exited process', async () => {
    const id = spawn()
    emitPtyData(id, 1, 'bye')
    emitPtyExit(id, 1)
    expect(await screenText(id, 5)).toBeNull()
    expect(await terminalModes(id)).toBeNull()
  })
})
