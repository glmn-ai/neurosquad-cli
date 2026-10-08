// One agent's screen: an @xterm/headless terminal fed with the pty's output.
//
// xterm is the parser the desktop's cards use, so its buffer holds exactly
// what a real terminal would show — scrollback, the alternate screen of
// full-screen TUIs, wide and combining characters — and `snapshot()` copies
// the visible part into a flat cell grid for the tile renderer.
//
// Terminal queries. Programs ask the terminal questions and wait for the
// answer on their stdin: device attributes (DA), the cursor position (CPR),
// the default colours (OSC 10/11/12), palette entries (OSC 4). xterm answers
// DA and CPR itself; the colour queries are answered here from `colors`.
// Every answer goes out through `onReply` — and only from the view that owns
// the agent (`owner: true`). A second view of the same pty (a mirror in
// another client, a tile next to the attach view) parsed the same question;
// if it answered too, the second answer would land in the agent's input as
// literal text ("^[[12;1R" in Claude Code's prompt — seen on the desktop).
// So there is exactly one owner per agent, and an owner never answers a
// question asked by a process that has since been replaced (`respawn()`).
//
// The owner's size must be the pty's size (a CPR answer is a position in
// *its* grid). Tiles smaller than the agent's terminal therefore never
// resize the view — the renderer crops instead of reflowing.

import xtermHeadless, { type IDisposable, type Terminal as HeadlessTerminal } from '@xterm/headless'
import serializePkg from '@xterm/addon-serialize'
import unicode11Pkg from '@xterm/addon-unicode11'
import graphemesPkg from '@xterm/addon-unicode-graphemes'
import { DEFAULT_COLOR, PALETTE, RGB, paletteToRgb, parseHexColor, x11Rgb } from './color.js'
import {
  ATTR_BLINK,
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_INVERSE,
  ATTR_INVISIBLE,
  ATTR_ITALIC,
  ATTR_OVERLINE,
  ATTR_STRIKETHROUGH,
  ATTR_UNDERLINE,
  createGrid,
  ensureGridSize,
  type Grid
} from './grid.js'

const { Terminal } = xtermHeadless
const { SerializeAddon } = serializePkg
const { Unicode11Addon } = unicode11Pkg
const { UnicodeGraphemesAddon } = graphemesPkg

type SerializeAddonInstance = InstanceType<typeof SerializeAddon>

/**
 * How character widths are measured — must match the host terminal, or wide
 * characters drift. `'graphemes'` (Unicode 15 + grapheme clusters: ZWJ
 * emoji, flags and VS16 emoji are one 2-wide cell) matches Windows Terminal
 * 1.22+, iTerm2, WezTerm, kitty, Ghostty, foot; `'11'` matches older
 * terminals that measure code point by code point; `'6'` is xterm.js's
 * built-in legacy table. The renderer re-anchors the cursor after every wide
 * or clustered cell, so a disagreement costs at most that one cell.
 */
export type UnicodeMode = 'graphemes' | '11' | '6'

/** The colours the owner reports when a program asks (OSC 10/11/12/4). `#rrggbb`. */
export interface ReplyColors {
  foreground?: string
  background?: string
  cursor?: string
  /** Up to 16 entries overriding xterm's default ANSI colours (also used for OSC 4). */
  palette?: readonly string[]
}

export interface TermViewOptions {
  cols: number
  rows: number
  /** Scrollback lines kept for the normal screen (default 1000). */
  scrollback?: number
  /**
   * Whether this view answers terminal queries (see the file comment).
   * Exactly one view per agent may be the owner; default false (a mirror).
   */
  owner?: boolean
  unicode?: UnicodeMode
  colors?: ReplyColors
}

/** Input-related modes the program set — what attach mode mirrors onto the host terminal. */
export interface TermModes {
  bracketedPaste: boolean
  sendFocus: boolean
  applicationCursorKeys: boolean
  applicationKeypad: boolean
  mouseTracking: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  /** Mouse report encoding: 1006 (SGR), 1015 (urxvt), 1005 (UTF-8) or default. */
  mouseEncoding: 'default' | 'sgr' | 'urxvt' | 'utf8'
  cursorVisible: boolean
  alternateScreen: boolean
  /** Synchronized output (`CSI ? 2026 h`): the program is mid-frame. */
  synchronizedOutput: boolean
}

export interface SnapshotOptions {
  /** Lines scrolled up from the live screen (normal screen only; default 0). */
  scrollOffset?: number
}

export interface TermView {
  readonly cols: number
  readonly rows: number
  /** Bumped whenever parsed output, a resize or a scroll may have changed the screen. */
  readonly version: number
  /** Whether this view answers terminal queries. */
  readonly owner: boolean
  /** Feeds pty output; `done` runs once it is parsed. */
  write(data: string | Uint8Array, done?: () => void): void
  /** Resizes the screen; returns false (and does nothing) when cols/rows are unchanged. */
  resize(cols: number, rows: number): boolean
  /** Copies the visible screen into `into` (reused when its size matches) or a new grid. */
  snapshot(into?: Grid, options?: SnapshotOptions): Grid
  /** The screen as an ANSI stream that reproduces it — the attach replay. */
  serialize(options?: { scrollback?: number; excludeModes?: boolean }): string
  /** The last `count` non-blank lines up to the cursor, as plain text. */
  recentLines(count: number): string[]
  modes(): TermModes
  /** Hands the "answers queries" role to this view (true) or takes it away (false). */
  setOwner(owner: boolean): void
  /**
   * The pty was replaced (restart, reconnect): answers to questions the old
   * process asked — still being parsed — are dropped, and the screen is reset
   * when `reset` is true.
   */
  respawn(reset?: boolean): void
  /** Waits until everything written so far is parsed. */
  flush(): Promise<void>
  /** Answers to terminal queries, for the pty's stdin. Fires only while this view is the owner. */
  onReply(listener: (data: string) => void): IDisposable
  /** Output was parsed (or the view resized/reset); the screen may differ from the last snapshot. */
  onChange(listener: () => void): IDisposable
  onTitle(listener: (title: string) => void): IDisposable
  onBell(listener: () => void): IDisposable
  /** The underlying terminal, for addons the caller adds. Don't write to it directly. */
  readonly terminal: HeadlessTerminal
  dispose(): void
}

const DEFAULT_SCROLLBACK = 1000
const DEFAULT_FOREGROUND = 0xd4d4d4
const DEFAULT_BACKGROUND = 0x1e1e1e

class Emitter<T> {
  private listeners: Array<(value: T) => void> = []
  on(listener: (value: T) => void): IDisposable {
    this.listeners.push(listener)
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener)
      }
    }
  }
  emit(value: T): void {
    for (const listener of this.listeners) {
      try {
        listener(value)
      } catch {
        // A listener's bug must not break parsing for everyone else.
      }
    }
  }
  clear(): void {
    this.listeners = []
  }
}

function resolveColors(colors: ReplyColors | undefined): {
  foreground: number
  background: number
  cursor: number
  palette: number[]
} {
  const palette: number[] = []
  for (let i = 0; i < 256; i++) palette.push(paletteToRgb(i))
  colors?.palette?.slice(0, 16).forEach((hex, i) => {
    const rgb = parseHexColor(hex)
    if (rgb !== undefined) palette[i] = rgb
  })
  const foreground = parseHexColor(colors?.foreground ?? '') ?? DEFAULT_FOREGROUND
  return {
    foreground,
    background: parseHexColor(colors?.background ?? '') ?? DEFAULT_BACKGROUND,
    cursor: parseHexColor(colors?.cursor ?? '') ?? foreground,
    palette
  }
}

function paramList(params: (number | number[])[]): number[] {
  const list: number[] = []
  for (const p of params) list.push(Array.isArray(p) ? (p[0] ?? 0) : p)
  return list
}

export function createTermView(options: TermViewOptions): TermView {
  const term = new Terminal({
    cols: options.cols,
    rows: options.rows,
    scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
    allowProposedApi: true
  })
  let serializer: SerializeAddonInstance | null = null
  const unicode = options.unicode ?? 'graphemes'
  if (unicode === '11') {
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
  } else if (unicode === 'graphemes') {
    term.loadAddon(new UnicodeGraphemesAddon())
    term.unicode.activeVersion = '15-graphemes'
  }

  const colors = resolveColors(options.colors)
  let owner = options.owner ?? false
  let version = 0
  let disposed = false

  // Which pty generation the text being parsed came from (see `respawn`).
  let generation = 0
  const pendingGenerations: number[] = []

  const replyEmitter = new Emitter<string>()
  const changeEmitter = new Emitter<void>()
  const titleEmitter = new Emitter<string>()
  const bellEmitter = new Emitter<void>()

  // DEC private modes xterm does not expose: cursor visibility, mouse encoding.
  let cursorVisible = true
  let mouseEncoding: TermModes['mouseEncoding'] = 'default'

  const sendReply = (data: string): void => {
    if (!owner || disposed) return
    const asking = pendingGenerations[0] ?? generation
    if (asking !== generation) return
    replyEmitter.emit(data)
  }

  const disposables: IDisposable[] = []
  // In a headless terminal nobody types: onData carries only xterm's own answers.
  disposables.push(term.onData(sendReply))
  disposables.push(term.onBinary(sendReply))
  disposables.push(term.onTitleChange((title) => titleEmitter.emit(title)))
  disposables.push(term.onBell(() => bellEmitter.emit()))
  disposables.push(
    term.onWriteParsed(() => {
      version++
      changeEmitter.emit()
    })
  )

  const setDecModes = (params: (number | number[])[], on: boolean): boolean => {
    for (const mode of paramList(params)) {
      if (mode === 25) cursorVisible = on
      else if (mode === 1006) mouseEncoding = on ? 'sgr' : 'default'
      else if (mode === 1015) mouseEncoding = on ? 'urxvt' : 'default'
      else if (mode === 1005) mouseEncoding = on ? 'utf8' : 'default'
    }
    return false // let xterm apply them too
  }
  disposables.push(
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (p) => setDecModes(p, true))
  )
  disposables.push(
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (p) => setDecModes(p, false))
  )
  const resetModes = (): boolean => {
    cursorVisible = true
    mouseEncoding = 'default'
    return false
  }
  disposables.push(term.parser.registerEscHandler({ final: 'c' }, resetModes)) // RIS
  disposables.push(term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, resetModes)) // DECSTR

  // OSC 10/11/12: `?` asks for the colour; several `;?` ask for the following ones too.
  const dynamicColor = (index: number): number =>
    index === 10 ? colors.foreground : index === 11 ? colors.background : colors.cursor
  for (const ident of [10, 11, 12]) {
    disposables.push(
      term.parser.registerOscHandler(ident, (data) => {
        const parts = data.split(';')
        if (!parts.every((p) => p === '?')) return false
        let answer = ''
        parts.forEach((_, i) => {
          const which = ident + i
          if (which <= 12) answer += `\x1b]${which};${x11Rgb(dynamicColor(which))}\x1b\\`
        })
        if (answer) sendReply(answer)
        return true
      })
    )
  }
  // OSC 4;index;? (pairs may repeat): palette queries. Setting entries is left to xterm.
  disposables.push(
    term.parser.registerOscHandler(4, (data) => {
      const parts = data.split(';')
      if (parts.length < 2 || parts.length % 2 !== 0) return false
      let answer = ''
      for (let i = 0; i < parts.length; i += 2) {
        if (parts[i + 1] !== '?') return false
        const index = Number(parts[i])
        if (!Number.isInteger(index) || index < 0 || index > 255) return false
        answer += `\x1b]4;${index};${x11Rgb(colors.palette[index])}\x1b\\`
      }
      sendReply(answer)
      return true
    })
  )

  const cell = term.buffer.active.getNullCell()

  const view: TermView = {
    get cols() {
      return term.cols
    },
    get rows() {
      return term.rows
    },
    get version() {
      return version
    },
    get owner() {
      return owner
    },
    get terminal() {
      return term
    },

    write(data, done) {
      if (disposed) return
      pendingGenerations.push(generation)
      term.write(data, () => {
        pendingGenerations.shift()
        done?.()
      })
    },

    resize(cols, rows) {
      if (disposed) return false
      cols = Math.max(1, Math.floor(cols))
      rows = Math.max(1, Math.floor(rows))
      if (cols === term.cols && rows === term.rows) return false
      term.resize(cols, rows)
      version++
      changeEmitter.emit()
      return true
    },

    snapshot(into, snapshotOptions) {
      const cols = term.cols
      const rows = term.rows
      const grid = into ? ensureGridSize(into, cols, rows) : createGrid(cols, rows)
      const buffer = term.buffer.active
      const scrollOffset = Math.max(0, Math.floor(snapshotOptions?.scrollOffset ?? 0))
      const top =
        buffer.type === 'alternate' ? buffer.baseY : Math.max(0, buffer.baseY - scrollOffset)
      const { chars, widths, fg, bg, attrs } = grid
      for (let y = 0; y < rows; y++) {
        const line = buffer.getLine(top + y)
        let i = y * cols
        if (!line) {
          for (let x = 0; x < cols; x++, i++) {
            chars[i] = ''
            widths[i] = 1
            fg[i] = DEFAULT_COLOR
            bg[i] = DEFAULT_COLOR
            attrs[i] = 0
          }
          continue
        }
        for (let x = 0; x < cols; x++, i++) {
          line.getCell(x, cell)
          chars[i] = cell.getChars()
          widths[i] = cell.getWidth()
          if (cell.isAttributeDefault()) {
            fg[i] = DEFAULT_COLOR
            bg[i] = DEFAULT_COLOR
            attrs[i] = 0
            continue
          }
          fg[i] = cell.isFgDefault()
            ? DEFAULT_COLOR
            : (cell.isFgRGB() ? RGB : PALETTE) | cell.getFgColor()
          bg[i] = cell.isBgDefault()
            ? DEFAULT_COLOR
            : (cell.isBgRGB() ? RGB : PALETTE) | cell.getBgColor()
          let a = 0
          if (cell.isBold()) a |= ATTR_BOLD
          if (cell.isDim()) a |= ATTR_DIM
          if (cell.isItalic()) a |= ATTR_ITALIC
          if (cell.isUnderline()) a |= ATTR_UNDERLINE
          if (cell.isBlink()) a |= ATTR_BLINK
          if (cell.isInverse()) a |= ATTR_INVERSE
          if (cell.isInvisible()) a |= ATTR_INVISIBLE
          if (cell.isStrikethrough()) a |= ATTR_STRIKETHROUGH
          if (cell.isOverline()) a |= ATTR_OVERLINE
          attrs[i] = a
        }
      }
      grid.cursor.x = buffer.cursorX
      grid.cursor.y = buffer.baseY + buffer.cursorY - top
      grid.cursor.visible = cursorVisible
      grid.alternate = buffer.type === 'alternate'
      grid.top = top
      grid.version = version
      return grid
    },

    serialize(serializeOptions) {
      serializer ??= (() => {
        const addon = new SerializeAddon()
        term.loadAddon(addon)
        return addon
      })()
      return serializer.serialize({
        scrollback: serializeOptions?.scrollback,
        excludeModes: serializeOptions?.excludeModes
      })
    },

    recentLines(count) {
      const buffer = term.buffer.active
      const lines: string[] = []
      const cursorLine = buffer.baseY + buffer.cursorY
      let last = Math.min(buffer.length - 1, buffer.baseY + term.rows - 1)
      // Below the cursor there may be leftovers of a cleared TUI; start at the last non-blank line.
      while (last > cursorLine && !buffer.getLine(last)?.translateToString(true).trim()) last--
      for (let y = last; y >= 0 && lines.length < count; y--) {
        const text = buffer.getLine(y)?.translateToString(true) ?? ''
        if (text.trim()) lines.unshift(text)
      }
      return lines
    },

    modes() {
      const m = term.modes
      return {
        bracketedPaste: m.bracketedPasteMode,
        sendFocus: m.sendFocusMode,
        applicationCursorKeys: m.applicationCursorKeysMode,
        applicationKeypad: m.applicationKeypadMode,
        mouseTracking: m.mouseTrackingMode,
        mouseEncoding,
        cursorVisible,
        alternateScreen: term.buffer.active.type === 'alternate',
        synchronizedOutput: m.synchronizedOutputMode
      }
    },

    setOwner(next) {
      owner = next
    },

    respawn(reset = false) {
      generation++
      if (reset) {
        // Through the parser, behind anything still queued: RIS of the old screen.
        pendingGenerations.push(generation)
        term.write('\x1bc', () => void pendingGenerations.shift())
      }
    },

    flush() {
      return new Promise<void>((resolve) => {
        if (disposed) resolve()
        else term.write('', resolve)
      })
    },

    onReply: (listener) => replyEmitter.on(listener),
    onChange: (listener) => changeEmitter.on(() => listener()),
    onTitle: (listener) => titleEmitter.on(listener),
    onBell: (listener) => bellEmitter.on(() => listener()),

    dispose() {
      if (disposed) return
      disposed = true
      for (const d of disposables) d.dispose()
      replyEmitter.clear()
      changeEmitter.clear()
      titleEmitter.clear()
      bellEmitter.clear()
      term.dispose()
    }
  }
  return view
}
