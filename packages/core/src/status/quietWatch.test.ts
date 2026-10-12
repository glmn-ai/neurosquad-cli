import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  QuietWatch,
  lastScreenLine,
  normalizeScreenLine,
  quietPromptHint,
  screenChanged
} from './quietWatch.js'

const { Terminal } = xtermHeadless

/** The recorded sample streams of packages/term-view (fake harnesses, deterministic). */
function cast(kind: string): { cols: number; rows: number; events: string[] } {
  const file = fileURLToPath(
    new URL(`../../../term-view/fixtures/${kind}.cast.gz`, import.meta.url)
  )
  const lines = gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean)
  const header = JSON.parse(lines[0]!) as { width: number; height: number }
  const events = lines
    .slice(1)
    .map((line) => JSON.parse(line) as [number, string, string])
    .filter((event) => event[1] === 'o')
    .map((event) => event[2])
  return { cols: header.width, rows: header.height, events }
}

/** Replays a stream into a headless terminal; `visit` sees each event with the visible rows after it. */
async function replay(
  kind: string,
  visit: (data: string, lines: string[], index: number) => void
): Promise<void> {
  const { cols, rows, events } = cast(kind)
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 })
  try {
    for (const [index, data] of events.entries()) {
      await new Promise<void>((resolve) => term.write(data, resolve))
      const buffer = term.buffer.active
      const lines: string[] = []
      for (let y = 0; y < rows; y++)
        lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
      visit(data, lines, index)
    }
  } finally {
    term.dispose()
  }
}

describe('screenChanged', () => {
  const screen = (...status: string[]): string[] => [
    '⏺ Bash(git push)',
    '  ⎿  Running…',
    '',
    ...status,
    '╭────────╮',
    '│ >      │',
    '╰────────╯'
  ]

  it('ignores a turning spinner, a counting timer and a rotating verb', () => {
    const base = screen('✻ Pondering… (4m 58s · esc to interrupt)')
    expect(screenChanged(base, screen('✽ Pondering… (4m 59s · esc to interrupt)'))).toBe(false)
    expect(screenChanged(base, screen('✶ Pondering… (5m 0s · esc to interrupt)'))).toBe(false)
    expect(screenChanged(base, screen('· Ruminating… (1h 2m 3s · esc to interrupt)'))).toBe(false)
    expect(screenChanged(base, screen('⠙ Pondering… (05:01 · esc to interrupt)'))).toBe(false)
    expect(screenChanged(base, screen('| Pondering…... (12s · esc to interrupt)'))).toBe(false)
  })

  it('counts new lines, moving counters and a different screen', () => {
    const base = screen('✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)')
    // tokens streaming: a number that moves is progress
    expect(
      screenChanged(base, screen('✻ Pondering… (13s · ↑ 1.4k tokens · esc to interrupt)'))
    ).toBe(true)
    // a prompt printed on a line of its own
    expect(
      screenChanged(base, [
        ...base.slice(0, 2),
        "Password for 'https://git.example.com':",
        ...base.slice(3)
      ])
    ).toBe(true)
    // the screen scrolled
    expect(screenChanged(base, [...base.slice(1), 'next'])).toBe(true)
    // a resize
    expect(screenChanged(base, base.slice(1))).toBe(true)
    // three lines with small changes are not one animation
    const many = ['a b', 'c d', 'e f', 'g h']
    expect(screenChanged(many, ['a X', 'c Y', 'e Z', 'g h'])).toBe(true)
    expect(screenChanged(many, ['a X', 'c Y', 'e f', 'g h'])).toBe(false)
  })

  it('leaves letters and words alone when normalizing', () => {
    expect(normalizeScreenLine('build step - done in 12s')).toBe(
      normalizeScreenLine('build step / done in 99s')
    )
    expect(normalizeScreenLine('step-by-step 50%')).not.toBe(
      normalizeScreenLine('step-by-step 60%')
    )
  })
})

describe('screenChanged on recorded harness streams', () => {
  it('claude: the live region redrawn ~12×/s is animation, a history entry is output', async () => {
    let base: string[] | null = null
    let live = 0
    let history = 0
    await replay('claude', (data, lines, index) => {
      // the welcome, the first live region, and the newline the session ends with
      if (!base || index <= 1 || data === '\r\n') {
        base = lines
        return
      }
      const changed = screenChanged(base, lines)
      // A redraw that also moves a finished paragraph or a tool call into history has a ⏺.
      if (data.includes('⏺')) {
        history += 1
        expect(changed, `event ${index}`).toBe(true)
      } else {
        live += 1
        expect(changed, `event ${index}`).toBe(false)
      }
      if (changed) base = lines
    })
    expect(live).toBeGreaterThan(30)
    expect(history).toBeGreaterThan(5)
  })

  it('codex: the status line ticking is animation; streamed text and diffs are output', async () => {
    let base: string[] | null = null
    let ticks = 0
    let changes = 0
    let edits = 0
    await replay('codex', (data, lines, index) => {
      if (!base) {
        base = lines
        return
      }
      const changed = screenChanged(base, lines)
      // eslint-disable-next-line no-control-regex -- real escape sequences
      if (/^\r\x1b\[2K\x1b\[38;5;45m•\x1b\[0m \x1b\[1mWorking\x1b\[0m [^\r\n]*$/.test(data)) {
        ticks += 1
        expect(changed, `event ${index}`).toBe(false)
      }
      if (data.includes('• Edited')) {
        edits += 1
        expect(changed, `event ${index}`).toBe(true)
      }
      if (changed) {
        changes += 1
        base = lines
      }
    })
    expect(ticks).toBeGreaterThan(5)
    expect(edits).toBeGreaterThan(1)
    expect(changes).toBeGreaterThan(edits)
  })

  it('opencode: a full-screen TUI streaming messages keeps changing', async () => {
    let base: string[] | null = null
    let changes = 0
    let events = 0
    await replay('opencode', (_data, lines) => {
      events += 1
      if (!base) {
        base = lines
        return
      }
      if (screenChanged(base, lines)) {
        changes += 1
        base = lines
      }
    })
    // a new message every third frame (the token counter moves on every one)
    expect(changes).toBeGreaterThan(events / 4)
  })

  it('a frozen claude screen stays quiet however long its spinner turns', async () => {
    // The last screen of the recording, then only its live region redrawn (spinner, verb, timer)
    // — what Claude Code shows while a command it runs waits for a password.
    const frames: string[][] = []
    await replay('claude', (_data, lines) => frames.push(lines))
    const last = frames[frames.length - 1]!
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴']
    const verbs = ['Thinking', 'Reading', 'Editing', 'Running']
    const statusRow = last.findIndex((line) => line.includes('esc to interrupt'))
    const watch = new QuietWatch()
    watch.watch('a', 0)
    watch.observe('a', last, 0)
    for (let tick = 1; tick <= 6000; tick++) {
      const now = tick * 100
      const frame = [...last]
      if (statusRow >= 0)
        frame[statusRow] = frame[statusRow]!.replace(
          /^\S+ \S+… \(\d+s/,
          `${spinner[tick % spinner.length]} ${verbs[tick % verbs.length]}… (${Math.floor(now / 1000)}s`
        )
      expect(watch.observe('a', frame, now).changed).toBe(false)
    }
    expect(watch.due('a', 600_000, 300_000, last)).toBeDefined()
  })
})

describe('quietPromptHint', () => {
  it.each([
    ["Password for 'https://me@github.com':"],
    ["Enter passphrase for key '/home/me/.ssh/id_ed25519':"],
    ['[sudo] password for me:'],
    ['Are you sure you want to continue connecting (yes/no/[fingerprint])?'],
    ['Do you want to continue? [Y/n]'],
    ['Proceed (y/N)?'],
    ["Username for 'https://github.com':"],
    ['Press Enter to continue'],
    ['? Overwrite existing files?']
  ])('sees %s', (line) => {
    expect(quietPromptHint(['$ git push', line])).toBe(line)
  })

  it('looks only at the last few non-empty lines, newest first', () => {
    expect(quietPromptHint(['Password:', 'a', 'b', 'c', ''])).toBeUndefined()
    expect(quietPromptHint(['Continue? [y/N]', 'Password:', ''])).toBe('Password:')
  })

  it('is not fooled by a spinner line or ordinary output', () => {
    expect(
      quietPromptHint(['✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)'])
    ).toBeUndefined()
    expect(
      quietPromptHint(['Compiling 120 files', 'Listening on http://localhost:3000'])
    ).toBeUndefined()
  })
})

describe('lastScreenLine', () => {
  it('is the last non-empty line, as plain words, cut', () => {
    expect(lastScreenLine(['one', '  two \u0007 words  ', '', '   '])).toBe('two words')
    expect(lastScreenLine([])).toBeUndefined()
    expect(lastScreenLine(['x'.repeat(400)])!.length).toBe(300)
  })
})

describe('QuietWatch', () => {
  const screen = ['$ git push', "Password for 'https://git.example.com':"]

  it('flags a working agent once its screen was still for the threshold, once', () => {
    const watch = new QuietWatch()
    watch.watch('a', 1000)
    watch.observe('a', screen, 1000)
    expect(watch.due('a', 1000 + 299_999, 300_000, screen)).toBeUndefined()
    const flag = watch.due('a', 1000 + 300_000, 300_000, screen)
    expect(flag).toEqual({
      since: 1000,
      at: 301_000,
      line: "Password for 'https://git.example.com':",
      asking: "Password for 'https://git.example.com':"
    })
    expect(watch.due('a', 1000 + 400_000, 300_000, screen)).toBeUndefined()
    expect(watch.flag('a')).toBe(flag)
  })

  it('a threshold of 0 never flags', () => {
    const watch = new QuietWatch()
    watch.watch('a', 0)
    expect(watch.due('a', 10 ** 9, 0, screen)).toBeUndefined()
  })

  it('real output restarts the clock and ends the episode', () => {
    const watch = new QuietWatch()
    watch.watch('a', 0)
    watch.observe('a', screen, 0)
    const flag = watch.due('a', 300_000, 300_000, screen)!
    const result = watch.observe('a', [...screen, 'Everything up-to-date'], 310_000)
    expect(result).toEqual({ changed: true, ended: flag })
    expect(watch.flag('a')).toBeUndefined()
    expect(watch.due('a', 500_000, 300_000, screen)).toBeUndefined()
    expect(watch.due('a', 610_000, 300_000, screen)).toBeDefined()
  })

  it('input or a hook restarts the clock too', () => {
    const watch = new QuietWatch()
    watch.watch('a', 0)
    const flag = watch.due('a', 300_000, 300_000, screen)!
    expect(watch.touch('a', 305_000)).toBe(flag)
    expect(watch.due('a', 400_000, 300_000, screen)).toBeUndefined()
    // the screen after the input is the new baseline, not a change
    expect(watch.observe('a', [...screen, '****'], 306_000).changed).toBe(false)
    expect(watch.due('a', 605_000, 300_000, screen)).toBeDefined()
  })

  it('is not watching an agent that does not work (idle, finished, needs you, exited)', () => {
    const watch = new QuietWatch()
    expect(watch.due('a', 10 ** 9, 1, screen)).toBeUndefined()
    watch.watch('a', 0)
    const flag = watch.due('a', 300_000, 300_000, screen)
    expect(watch.unwatch('a')).toBe(flag)
    expect(watch.watching('a')).toBe(false)
    expect(watch.due('a', 10 ** 9, 1, screen)).toBeUndefined()
    expect(watch.touch('a', 0)).toBeUndefined()
    expect(watch.observe('a', screen, 0)).toEqual({ changed: false })
  })

  it('watching again keeps the running clock', () => {
    const watch = new QuietWatch()
    watch.watch('a', 0)
    watch.watch('a', 200_000)
    expect(watch.due('a', 300_000, 300_000, screen)).toBeDefined()
  })
})
