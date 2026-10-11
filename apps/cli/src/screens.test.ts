import { describe, expect, it } from 'vitest'
import { RUN_CURSOR, RUN_WIDE, type PhoneStyledScreen } from '@neurosquad/remote'
import { Screens } from './daemon/screens.js'

const E = '\x1b['

/** Writes `output` and waits until it is parsed (the screen's version moved). */
async function write(screens: Screens, output: string) {
  const before = screens.styled('a', 100)!.version
  screens.write('a', 1, output)
  for (let i = 0; i < 200; i++) {
    if (screens.styled('a', 100)!.version !== before) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the write was not parsed')
}

async function screenOf(output: string, cols = 60, rows = 10) {
  const screens = new Screens()
  screens.spawn('a', 1, cols, rows)
  await write(screens, output)
  return screens
}

/** Every run with its resolved style and flags, for asserting. */
function runs(screen: PhoneStyledScreen) {
  return screen.lines.map((line) =>
    line.map(([text, style, flags = 0]) => ({ text, ...screen.styles[style], flags }))
  )
}

describe('styled screens for the phone page', () => {
  it('colours (16 as theme slots, 256 and truecolor as #rrggbb) and attributes', async () => {
    const screens = await screenOf(
      [
        `${E}31mRED${E}0m ${E}91mBR${E}0m ${E}42;30mON${E}0m`,
        `${E}38;5;208mORANGE${E}0m ${E}38;2;255;105;180mPINK${E}0m ${E}48;2;20;40;120mBG${E}0m`,
        `${E}1mB${E}2mD${E}0m${E}3mI${E}4mU${E}0m${E}7mV${E}9mS${E}0m`
      ].join('\r\n')
    )
    const got = screens.styled('a', 100)!
    const lines = runs(got.screen!)
    expect(lines[0]).toEqual([
      { text: 'RED', fg: 'p1', flags: 0 },
      { text: ' ', flags: 0 },
      { text: 'BR', fg: 'p9', flags: 0 },
      { text: ' ', flags: 0 },
      { text: 'ON', fg: 'p0', bg: 'p2', flags: 0 }
    ])
    expect(lines[1]).toEqual([
      { text: 'ORANGE', fg: '#ff8700', flags: 0 },
      { text: ' ', flags: 0 },
      { text: 'PINK', fg: '#ff69b4', flags: 0 },
      { text: ' ', flags: 0 },
      { text: 'BG', bg: '#142878', flags: 0 }
    ])
    expect(lines[2].map(({ text, flags: _flags, ...style }) => [text, style])).toEqual([
      ['B', { bold: true }],
      ['D', { bold: true, dim: true }],
      ['I', { italic: true }],
      ['U', { italic: true, underline: true }],
      ['V', { inverse: true }],
      ['S', { inverse: true, strike: true }],
      // The cursor, after the last line's text.
      [' ', {}]
    ])
    expect(got.screen!.cols).toBe(60)
    // The style table holds each style once, the default first.
    expect(got.screen!.styles[0]).toEqual({})
    expect(new Set(got.screen!.styles.map((s) => JSON.stringify(s))).size).toBe(
      got.screen!.styles.length
    )
  })

  it('wide characters are runs of their own; box drawing stays text', async () => {
    const screens = await screenOf('┌─┐\r\n│中🚀│\r\n└─┘\x1b[?25l')
    const lines = runs(screens.styled('a', 100)!.screen!)
    expect(lines[0]).toEqual([{ text: '┌─┐', flags: 0 }])
    expect(lines[1]).toEqual([
      { text: '│', flags: 0 },
      { text: '中', flags: RUN_WIDE },
      { text: '🚀', flags: RUN_WIDE },
      { text: '│', flags: 0 }
    ])
  })

  it('the cursor: its own run where it is, after the text, and gone when hidden', async () => {
    const screens = await screenOf('> type here\x1b[2D')
    let lines = runs(screens.styled('a', 100)!.screen!)
    expect(lines[0]).toEqual([
      { text: '> type he', flags: 0 },
      { text: 'r', flags: RUN_CURSOR },
      { text: 'e', flags: 0 }
    ])
    await write(screens, '\r\n$ ')
    lines = runs(screens.styled('a', 100)!.screen!)
    expect(lines[1]).toEqual([
      { text: '$ ', flags: 0 },
      { text: ' ', flags: RUN_CURSOR }
    ])
    await write(screens, '\x1b[?25l')
    lines = runs(screens.styled('a', 100)!.screen!)
    expect(lines.flat().some((run) => run.flags & RUN_CURSOR)).toBe(false)
    // A soft reset (DECSTR) and a full one (RIS) show it again.
    await write(screens, '\x1b[!p')
    lines = runs(screens.styled('a', 100)!.screen!)
    expect(lines.flat().some((run) => run.flags & RUN_CURSOR)).toBe(true)
    await write(screens, '\x1b[?25l\x1bc')
    lines = runs(screens.styled('a', 100)!.screen!)
    expect(lines.flat().some((run) => run.flags & RUN_CURSOR)).toBe(true)
  })

  it('a version per change: unchanged screens are not sent again', async () => {
    const screens = await screenOf('hello')
    const first = screens.styled('a', 100)!
    expect(first.screen).toBeDefined()
    expect(screens.styled('a', 100, first.version)).toEqual({ version: first.version })
    await write(screens, ' world')
    const next = screens.styled('a', 100, first.version)!
    expect(next.version).toBeGreaterThan(first.version)
    expect(next.screen?.lines[0]).toEqual([
      ['hello world', 0],
      [' ', 0, RUN_CURSOR]
    ])
    screens.resize('a', 40, 10)
    expect(screens.styled('a', 100, next.version)!.screen?.cols).toBe(40)
    expect(screens.styled('nobody', 100)).toBeNull()
  })

  it('a respawned screen never reuses a version a client still holds', async () => {
    const screens = await screenOf('old process')
    const held = screens.styled('a', 100)!.version
    screens.spawn('a', 2, 60, 10)
    // A fresh, idle screen: nothing written yet, and still not "unchanged" for the old version.
    const fresh = screens.styled('a', 100, held)!
    expect(fresh.version).not.toBe(held)
    expect(fresh.screen).toBeDefined()
  })

  it('scrollback up to `lines`, blank screen rows below the text dropped', async () => {
    const screens = await screenOf(
      Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'),
      40,
      10
    )
    const lines = screens.styled('a', 12)!.screen!.lines
    expect(lines.length).toBe(12)
    expect(lines.at(-1)?.[0]?.[0]).toBe('line 29')
    const short = await screenOf('one line')
    expect(short.styled('a', 100)!.screen!.lines.length).toBe(1)
  })

  it('markup in the output is just text in a run', async () => {
    const screens = await screenOf('<img src=x onerror="alert(1)"><script>x</script>')
    expect(screens.styled('a', 100)!.screen!.lines[0]).toEqual([
      ['<img src=x onerror="alert(1)"><script>x</script>', 0],
      [' ', 0, RUN_CURSOR]
    ])
  })
})
