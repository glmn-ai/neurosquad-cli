import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  detectColorLevel,
  detectGraphicsFromEnv,
  detectUnicode,
  parseProbeReplies,
  queryGraphics,
  wrapForTmux,
  type Env,
  type TerminalFacts
} from './capabilities.js'

const tty = (env: Env, extra: Partial<TerminalFacts> = {}): TerminalFacts => ({
  env,
  isTTY: true,
  platform: 'linux',
  ...extra
})

describe('detectColorLevel', () => {
  it('reads COLORTERM and TERM', () => {
    expect(detectColorLevel(tty({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }))).toBe(3)
    expect(detectColorLevel(tty({ TERM: 'xterm-256color', COLORTERM: '24bit' }))).toBe(3)
    expect(detectColorLevel(tty({ TERM: 'xterm-256color' }))).toBe(2)
    expect(detectColorLevel(tty({ TERM: 'screen-256color' }))).toBe(2)
    expect(detectColorLevel(tty({ TERM: 'xterm' }))).toBe(1)
    expect(detectColorLevel(tty({ TERM: 'linux' }))).toBe(1)
    expect(detectColorLevel(tty({ TERM: 'dumb' }))).toBe(0)
    expect(detectColorLevel(tty({}))).toBe(0)
  })

  it('knows truecolor terminals by name', () => {
    expect(detectColorLevel(tty({ TERM: 'xterm-kitty' }))).toBe(3)
    expect(detectColorLevel(tty({ TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }))).toBe(3)
    expect(detectColorLevel(tty({ TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' }))).toBe(3)
    expect(detectColorLevel(tty({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }))).toBe(
      2
    )
  })

  it('honours NO_COLOR, but FORCE_COLOR wins', () => {
    expect(
      detectColorLevel(tty({ TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' }))
    ).toBe(0)
    expect(detectColorLevel(tty({ TERM: 'xterm-256color', NO_COLOR: '' }))).toBe(2)
    expect(detectColorLevel(tty({ TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '1' }))).toBe(
      2
    )
    expect(
      detectColorLevel(tty({ TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '0' }))
    ).toBe(0)
    expect(detectColorLevel(tty({ FORCE_COLOR: '3' }))).toBe(3)
  })

  it('gives a pipe no colour unless forced', () => {
    expect(
      detectColorLevel({
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        isTTY: false,
        platform: 'linux'
      })
    ).toBe(0)
    expect(detectColorLevel({ env: { FORCE_COLOR: '2' }, isTTY: false, platform: 'linux' })).toBe(2)
    expect(detectColorLevel({ env: { FORCE_COLOR: '' }, isTTY: false, platform: 'linux' })).toBe(1)
  })

  it('tells Windows Terminal and conhost generations apart', () => {
    expect(
      detectColorLevel(tty({ WT_SESSION: 'abc' }, { platform: 'win32', osRelease: '10.0.19045' }))
    ).toBe(3)
    expect(detectColorLevel(tty({}, { platform: 'win32', osRelease: '10.0.19045' }))).toBe(3)
    expect(detectColorLevel(tty({}, { platform: 'win32', osRelease: '10.0.10586' }))).toBe(2)
    expect(detectColorLevel(tty({}, { platform: 'win32', osRelease: '6.1.7601' }))).toBe(1)
  })

  it('lets NSQ_COLOR override everything', () => {
    expect(detectColorLevel(tty({ COLORTERM: 'truecolor', NSQ_COLOR: '16' }))).toBe(1)
    expect(detectColorLevel(tty({ NO_COLOR: '1', NSQ_COLOR: '256' }))).toBe(2)
    expect(detectColorLevel(tty({ COLORTERM: 'truecolor', NSQ_COLOR: 'none' }))).toBe(0)
  })
})

describe('detectUnicode', () => {
  it('is on for modern terminals, off for the Linux console and legacy conhost', () => {
    expect(
      detectUnicode({ env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, platform: 'linux' })
    ).toBe(true)
    expect(detectUnicode({ env: { TERM: 'linux' }, platform: 'linux' })).toBe(false)
    expect(detectUnicode({ env: { TERM: 'xterm', LANG: 'C' }, platform: 'linux' })).toBe(false)
    expect(detectUnicode({ env: { WT_SESSION: 'x' }, platform: 'win32' })).toBe(true)
    expect(detectUnicode({ env: { TERM_PROGRAM: 'vscode' }, platform: 'win32' })).toBe(true)
    expect(detectUnicode({ env: {}, platform: 'win32' })).toBe(false)
    expect(detectUnicode({ env: { NSQ_GLYPHS: 'unicode' }, platform: 'win32' })).toBe(true)
    expect(
      detectUnicode({ env: { NSQ_GLYPHS: 'ascii', TERM: 'xterm-kitty' }, platform: 'linux' })
    ).toBe(false)
  })
})

describe('detectGraphicsFromEnv', () => {
  it('knows kitty, ghostty, iTerm2, WezTerm, foot', () => {
    expect(detectGraphicsFromEnv({ TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' }).protocol).toBe(
      'kitty'
    )
    expect(detectGraphicsFromEnv({ TERM_PROGRAM: 'ghostty' }).protocol).toBe('kitty')
    expect(detectGraphicsFromEnv({ TERM_PROGRAM: 'iTerm.app' }).protocol).toBe('iterm2')
    expect(detectGraphicsFromEnv({ TERM_PROGRAM: 'WezTerm' }).protocol).toBe('iterm2')
    expect(detectGraphicsFromEnv({ TERM: 'foot' }).protocol).toBe('sixel')
  })

  it('says "probe" for terminals only Device Attributes can tell', () => {
    const wt = detectGraphicsFromEnv({ WT_SESSION: 'x' })
    expect(wt).toMatchObject({ protocol: 'none', source: 'unknown' })
    expect(detectGraphicsFromEnv({ TERM_PROGRAM: 'Apple_Terminal' }).source).toBe('env')
  })

  it('draws nothing inside tmux unless passthrough is allowed, and never kitty there', () => {
    const env = {
      TMUX: '/tmp/tmux-1/default,1,0',
      TERM: 'tmux-256color',
      LC_TERMINAL: 'iTerm2',
      KITTY_WINDOW_ID: '3'
    }
    expect(detectGraphicsFromEnv(env)).toMatchObject({
      protocol: 'none',
      source: 'disabled',
      tmux: true
    })
    expect(detectGraphicsFromEnv(env, { tmuxPassthrough: true })).toMatchObject({
      protocol: 'iterm2',
      tmux: true
    })
    expect(
      detectGraphicsFromEnv({ TMUX: 'x', KITTY_WINDOW_ID: '1' }, { tmuxPassthrough: true }).protocol
    ).toBe('none')
  })

  it('is off in screen, zellij and with NSQ_IMAGES=0', () => {
    expect(
      detectGraphicsFromEnv({ STY: '1.pts', TERM: 'screen', TERM_PROGRAM: 'iTerm.app' }).protocol
    ).toBe('none')
    expect(detectGraphicsFromEnv({ ZELLIJ: '0', TERM: 'xterm-kitty' }).protocol).toBe('none')
    expect(detectGraphicsFromEnv({ NSQ_IMAGES: '0', TERM: 'xterm-kitty' }).source).toBe('disabled')
  })

  it('wraps for tmux by doubling ESC', () => {
    expect(wrapForTmux('\x1b_Ga=T\x1b\\')).toBe('\x1bPtmux;\x1b\x1b_Ga=T\x1b\x1b\\\x1b\\')
  })
})

describe('parseProbeReplies', () => {
  it('finds kitty, sixel, cell size and leaves user input in rest', () => {
    const r = parseProbeReplies('a\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1b[?62;4;22cb')
    expect(r).toMatchObject({
      protocol: 'kitty',
      cellPx: { width: 10, height: 20 },
      answered: true,
      rest: 'ab',
      done: true
    })
  })

  it('sixel from DA1 attribute 4', () => {
    expect(parseProbeReplies('\x1b[?65;1;4;9c').protocol).toBe('sixel')
    expect(parseProbeReplies('\x1b[?65;1;9c').protocol).toBe('none')
  })

  it('a kitty error reply is not support', () => {
    expect(parseProbeReplies('\x1b_Gi=31;ENOTSUPPORTED\x1b\\\x1b[?1;2c').protocol).toBe('none')
  })

  it('is not done before Device Attributes arrives', () => {
    expect(parseProbeReplies('\x1b_Gi=31;OK\x1b\\').done).toBe(false)
  })
})

class FakeInput extends EventEmitter {
  isTTY = true
  isRaw = false
  rawCalls: boolean[] = []
  setRawMode(on: boolean): void {
    this.isRaw = on
    this.rawCalls.push(on)
  }
  resume(): void {}
  pause(): void {}
}

describe('queryGraphics', () => {
  it('resolves with what the terminal answered and restores raw mode', async () => {
    const input = new FakeInput()
    const written: string[] = []
    const p = queryGraphics(input, {
      write: (d: string) => {
        written.push(d)
        // Reply synchronously: deterministic, never races the probe's timeout.
        input.emit('data', Buffer.from('\x1b[?62;4c'))
      }
    })
    const r = await p
    expect(written.join('')).toContain('\x1b_Gi=31')
    expect(r).toMatchObject({ protocol: 'sixel', answered: true })
    expect(input.rawCalls).toEqual([true, false])
    expect(input.listenerCount('data')).toBe(0)
  })

  it('keeps a stream that was already flowing flowing', async () => {
    const input = new FakeInput() as FakeInput & { readableFlowing: boolean | null }
    input.readableFlowing = true
    let paused = false
    input.pause = () => {
      paused = true
    }
    const r = await queryGraphics(input, {
      write: () => {
        input.emit('data', '\x1b[?62c')
      }
    })
    expect(r.answered).toBe(true)
    expect(paused).toBe(false)
  })

  it('gives up after the timeout without throwing', async () => {
    vi.useFakeTimers()
    try {
      const input = new FakeInput()
      const p = queryGraphics(input, { write: () => undefined }, { timeoutMs: 100 })
      vi.advanceTimersByTime(101)
      await expect(p).resolves.toMatchObject({ protocol: 'none', answered: false })
      expect(input.isRaw).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing when stdin is not a TTY', async () => {
    const input = new FakeInput()
    input.isTTY = false
    const write = vi.fn()
    await expect(queryGraphics(input, { write })).resolves.toMatchObject({ protocol: 'none' })
    expect(write).not.toHaveBeenCalled()
  })

  it('survives a write that throws', async () => {
    const input = new FakeInput()
    const r = await queryGraphics(input, {
      write: () => {
        throw new Error('EPIPE')
      }
    })
    expect(r.protocol).toBe('none')
    expect(input.isRaw).toBe(false)
  })
})
