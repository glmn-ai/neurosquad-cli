/**
 * What the terminal can do: colour depth, Unicode, inline images. Pure functions over an `env`
 * snapshot (plus platform facts) so every rule is unit-testable; nothing here touches the real
 * process unless you call the `*FromProcess` helpers.
 */
import type { ColorLevel } from './color.js'

export type Env = Readonly<Record<string, string | undefined>>

export interface TerminalFacts {
  env: Env
  /** Is the output a TTY? Non-TTY output gets no colour unless `FORCE_COLOR` says otherwise. */
  isTTY: boolean
  /** `process.platform`. */
  platform: NodeJS.Platform
  /** `os.release()` — on Windows, `10.0.<build>`; used to tell conhost's capabilities apart. */
  osRelease?: string
}

const TRUECOLOR_TERMS =
  /^(xterm-kitty|xterm-ghostty|wezterm|alacritty|foot(-extra)?|contour|rio|xterm-direct|tmux-direct)$/
const TRUECOLOR_PROGRAMS = new Set([
  'iTerm.app',
  'WezTerm',
  'ghostty',
  'vscode',
  'Hyper',
  'Tabby',
  'rio',
  'WarpTerminal'
])

function windowsBuild(osRelease: string | undefined): number | undefined {
  const m = /^10\.0\.(\d+)/.exec(osRelease ?? '')
  return m ? Number(m[1]) : undefined
}

/** `FORCE_COLOR` as a level, or undefined if unset. `''`/`true`/`1` = 16 colours. */
function forcedLevel(env: Env): ColorLevel | undefined {
  const v = env.FORCE_COLOR
  if (v === undefined) return undefined
  const s = v.trim().toLowerCase()
  if (s === '' || s === 'true' || s === '1') return 1
  if (s === 'false' || s === '0') return 0
  if (s === '2') return 2
  if (s === '3') return 3
  return 1
}

/**
 * Colour depth, in this order:
 * 1. `FORCE_COLOR` wins (0/false … 3), even over a pipe — it is how CI and tests ask for colour.
 * 2. `NO_COLOR` (any non-empty value, https://no-color.org) → none.
 * 3. Not a TTY, or `TERM=dumb` → none.
 * 4. `COLORTERM=truecolor|24bit`, known truecolor terminals and Windows Terminal / modern conhost → 24-bit.
 * 5. `*-256color` → 256; any other known colour `TERM` (or Windows) → 16.
 * The result is then capped by `FORCE_COLOR` only when it was given; `NSQ_COLOR=16|256|truecolor|none`
 * is our own explicit override and beats everything.
 */
export function detectColorLevel(facts: TerminalFacts): ColorLevel {
  const { env, platform } = facts
  const own = env.NSQ_COLOR?.trim().toLowerCase()
  if (own === 'none' || own === '0') return 0
  if (own === '16') return 1
  if (own === '256') return 2
  if (own === 'truecolor' || own === '24bit') return 3

  const forced = forcedLevel(env)
  if (forced === 0) return 0
  if (forced === undefined && env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0
  if (forced === undefined && !facts.isTTY) return 0

  const detected = detectFromTerminal(facts)
  if (forced !== undefined) return Math.max(forced, detected) as ColorLevel
  return detected

  function detectFromTerminal({ env: e }: TerminalFacts): ColorLevel {
    const term = e.TERM ?? ''
    if (term === 'dumb') return 0
    const colorterm = (e.COLORTERM ?? '').toLowerCase()
    if (colorterm === 'truecolor' || colorterm === '24bit') return 3
    if (e.KITTY_WINDOW_ID || e.WT_SESSION || e.GHOSTTY_RESOURCES_DIR) return 3
    if (TRUECOLOR_TERMS.test(term)) return 3
    if (e.TERM_PROGRAM && TRUECOLOR_PROGRAMS.has(e.TERM_PROGRAM)) return 3
    if (e.CI && (e.GITHUB_ACTIONS || e.GITEA_ACTIONS)) return 3
    if (e.ConEmuANSI === 'ON') return 3
    if (platform === 'win32') {
      // Windows 10 1607 (build 14931+) conhost speaks 24-bit; 10586+ speaks 256.
      const build = windowsBuild(facts.osRelease)
      if (build === undefined) return 1
      if (build >= 14931) return 3
      if (build >= 10586) return 2
      return 1
    }
    if (e.TERM_PROGRAM === 'Apple_Terminal') return 2
    if (/-256(color)?$/i.test(term)) return 2
    if (
      /^(screen|xterm|vt1[02]0|vt220|rxvt|tmux|konsole|putty|ansi|cygwin|linux)|color/i.test(term)
    )
      return 1
    if (e.COLORTERM) return 1
    return 0
  }
}

/**
 * Can the terminal draw non-ASCII glyphs (box drawing, braille spinners, ✔)? False for the Linux
 * console and for legacy Windows consoles without a modern host; `NSQ_GLYPHS=ascii|unicode` overrides.
 */
export function detectUnicode(facts: Pick<TerminalFacts, 'env' | 'platform'>): boolean {
  const { env, platform } = facts
  const own = env.NSQ_GLYPHS?.trim().toLowerCase()
  if (own === 'ascii') return false
  if (own === 'unicode') return true
  if (env.TERM === 'linux') return false
  if (platform !== 'win32') {
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
    // An explicit non-UTF-8 locale (e.g. `C`, `POSIX`, `en_US.ISO-8859-1`) on a Unix console.
    if (locale && !/utf-?8/i.test(locale) && locale !== 'C.UTF-8') {
      return Boolean(env.TERM_PROGRAM || env.KITTY_WINDOW_ID || env.WT_SESSION)
    }
    return true
  }
  return Boolean(
    env.WT_SESSION ||
    env.TERMINUS_SUBLIME ||
    env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'Terminus-Sublime' ||
    env.TERM_PROGRAM === 'vscode' ||
    env.TERM_PROGRAM === 'WezTerm' ||
    env.TERM === 'xterm-256color' ||
    env.TERM === 'alacritty' ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
  )
}

/**
 * Does the terminal draw East Asian "ambiguous" characters (●, ○, box drawing, blocks) two cells
 * wide? Some CJK setups do (e.g. a CJK locale with a CJK font and "ambiguous = wide" set), and then
 * every border made of `─` doubles in width. We cannot measure it without a cursor query, so it is
 * opt-in: `NSQ_AMBIGUOUS_WIDE=1`. When on, use `glyphs: 'ascii'`-safe sets (see `glyphSet`).
 */
export function detectAmbiguousWide(env: Env): boolean {
  const v = env.NSQ_AMBIGUOUS_WIDE?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

// ---- inline images ----------------------------------------------------------------------------

export type GraphicsProtocol = 'kitty' | 'iterm2' | 'sixel' | 'none'

export interface GraphicsSupport {
  protocol: GraphicsProtocol
  /** `env` = known terminal; `query` = it answered our probe; `unknown` = worth probing. */
  source: 'env' | 'query' | 'unknown' | 'disabled'
  /** Escape sequences must be wrapped for tmux passthrough (see `wrapForTmux`). */
  tmux: boolean
  /** Why — for a `--debug` line. */
  reason: string
}

export interface GraphicsEnvOptions {
  /**
   * The user enabled `set -g allow-passthrough on` in tmux. Without it tmux swallows image escapes,
   * so inside tmux we draw no images unless this is set. Kitty's protocol needs Unicode placeholders
   * through tmux, which we do not implement — inside tmux only iTerm2 and sixel are used.
   */
  tmuxPassthrough?: boolean
}

/** Inline-image support judged from the environment alone (no I/O). */
export function detectGraphicsFromEnv(env: Env, opts: GraphicsEnvOptions = {}): GraphicsSupport {
  const off = env.NSQ_IMAGES?.trim().toLowerCase()
  if (off === '0' || off === 'false' || off === 'none') {
    return { protocol: 'none', source: 'disabled', tmux: false, reason: 'NSQ_IMAGES=0' }
  }
  const term = env.TERM ?? ''
  const program = env.TERM_PROGRAM ?? ''
  const inTmux = Boolean(env.TMUX) || /^tmux/.test(term) || program === 'tmux'
  const inScreen = !inTmux && (Boolean(env.STY) || /^screen/.test(term))
  if (inScreen) return { protocol: 'none', source: 'disabled', tmux: false, reason: 'GNU screen' }
  if (env.ZELLIJ !== undefined)
    return { protocol: 'none', source: 'disabled', tmux: false, reason: 'zellij' }
  if (inTmux && !opts.tmuxPassthrough) {
    return { protocol: 'none', source: 'disabled', tmux: true, reason: 'tmux without passthrough' }
  }

  const found = (protocol: GraphicsProtocol, reason: string): GraphicsSupport => ({
    protocol,
    source: 'env',
    tmux: inTmux,
    reason
  })

  // Outer-terminal hints that survive inside tmux: LC_TERMINAL (iTerm2), KITTY_WINDOW_ID.
  if (!inTmux && (env.KITTY_WINDOW_ID || term === 'xterm-kitty')) return found('kitty', 'kitty')
  if (!inTmux && (program === 'ghostty' || term === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR)) {
    return found('kitty', 'ghostty')
  }
  if (program === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return found('iterm2', 'iTerm2')
  if (program === 'WezTerm') return found('iterm2', 'WezTerm (iTerm2 protocol is on by default)')
  if (/^foot/.test(term) || term === 'mlterm' || program === 'mlterm')
    return found('sixel', term || program)
  if (program === 'Apple_Terminal') {
    return {
      protocol: 'none',
      source: 'env',
      tmux: inTmux,
      reason: 'Terminal.app has no image protocol'
    }
  }
  if (term === 'linux' || term === 'dumb') {
    return { protocol: 'none', source: 'env', tmux: inTmux, reason: `TERM=${term}` }
  }
  // Windows Terminal (1.22+ draws sixel), VS Code (images behind a setting), Konsole, xterm -ti vt340:
  // only an answer to Device Attributes can tell.
  return { protocol: 'none', source: 'unknown', tmux: inTmux, reason: 'probe with queryGraphics()' }
}

/** Wraps an escape sequence for tmux's DCS passthrough (`allow-passthrough on`). */
export function wrapForTmux(seq: string): string {
  return `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`
}

/** Minimal duplex the probe needs — `process.stdin`/`process.stdout` fit it. */
export interface ProbeInput {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?(mode: boolean): unknown
  resume?(): unknown
  pause?(): unknown
}
export interface ProbeOutput {
  write(data: string): unknown
}

export interface ProbeResult {
  protocol: GraphicsProtocol
  /** Cell size in pixels if the terminal reported it (`CSI 16 t`). */
  cellPx?: { width: number; height: number }
  /** True if the terminal answered at all (Device Attributes). */
  answered: boolean
  /** Bytes that arrived during the probe but were not replies — feed them to your input handler. */
  rest: string
}

/** The kitty probe: query support for a 1×1 RGB image without storing it (`a=q`). */
export const KITTY_PROBE = '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\'
/** Report cell size in pixels. */
export const CELL_SIZE_PROBE = '\x1b[16t'
/** Primary Device Attributes — every terminal answers, so it terminates the probe early. */
export const DA1_PROBE = '\x1b[c'

/** Parses whatever the terminal sent back; exported for tests. */
export function parseProbeReplies(
  data: string
): Omit<ProbeResult, 'rest'> & { rest: string; done: boolean } {
  let rest = data
  let kitty = false
  let sixel = false
  let answered = false
  let cellPx: ProbeResult['cellPx']
  // eslint-disable-next-line no-control-regex
  const kittyRe = /\x1b_Gi=31;([^\x1b]*)\x1b\\/
  const k = kittyRe.exec(rest)
  if (k) {
    kitty = k[1].startsWith('OK')
    rest = rest.replace(k[0], '')
  }
  // eslint-disable-next-line no-control-regex
  const cellRe = /\x1b\[6;(\d+);(\d+)t/
  const c = cellRe.exec(rest)
  if (c) {
    cellPx = { height: Number(c[1]), width: Number(c[2]) }
    rest = rest.replace(c[0], '')
  }
  // eslint-disable-next-line no-control-regex
  const daRe = /\x1b\[\?([\d;]*)c/
  const d = daRe.exec(rest)
  if (d) {
    answered = true
    sixel = d[1].split(';').includes('4')
    rest = rest.replace(d[0], '')
  }
  const protocol: GraphicsProtocol = kitty ? 'kitty' : sixel ? 'sixel' : 'none'
  return { protocol, cellPx, answered, rest, done: answered }
}

/**
 * Asks the terminal what it can draw: kitty graphics query + cell size + Device Attributes, and
 * waits at most `timeoutMs` (default 150 ms). Never throws and never blocks startup — call it
 * without awaiting before the first frame and switch logos on when it resolves. Run it before your
 * TUI installs its own stdin handler; bytes typed meanwhile come back in `rest`.
 */
export function queryGraphics(
  input: ProbeInput,
  output: ProbeOutput,
  opts: { timeoutMs?: number; tmux?: boolean } = {}
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 150
  return new Promise((resolve) => {
    if (!input.isTTY) {
      resolve({ protocol: 'none', answered: false, rest: '' })
      return
    }
    let buffer = ''
    let settled = false
    const wasRaw = input.isRaw === true
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        input.off('data', onData)
        if (!wasRaw) input.setRawMode?.(false)
        input.pause?.()
      } catch {
        // A closed TTY is not our problem to report here.
      }
      const parsed = parseProbeReplies(buffer)
      resolve({
        protocol: parsed.protocol,
        cellPx: parsed.cellPx,
        answered: parsed.answered,
        rest: parsed.rest
      })
    }
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('latin1')
      if (parseProbeReplies(buffer).done) finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    try {
      if (!wasRaw) input.setRawMode?.(true)
      input.on('data', onData)
      input.resume?.()
      const probe = KITTY_PROBE + CELL_SIZE_PROBE + DA1_PROBE
      output.write(opts.tmux ? wrapForTmux(KITTY_PROBE) + CELL_SIZE_PROBE + DA1_PROBE : probe)
    } catch {
      finish()
    }
  })
}

/** Is this an SSH session? Used to drop animations to static frames over remote links. */
export function isRemoteSession(env: Env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)
}
