// Raw terminal input → key, mouse and paste events. Every event keeps the
// bytes it came from (`seq`), so input meant for an agent is passed through
// unchanged.

export interface KeyEvent {
  type: 'key'
  /** `a`, `A`, `enter`, `escape`, `up`, `f1`, `pageup`, `space`… */
  name: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  seq: string
}

export interface MouseEvent {
  type: 'mouse'
  /** 0 left, 1 middle, 2 right; `wheelup` / `wheeldown`. */
  button: number | 'wheelup' | 'wheeldown'
  action: 'down' | 'up' | 'move'
  /** 0-based cell coordinates. */
  x: number
  y: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  seq: string
}

export interface PasteEvent {
  type: 'paste'
  text: string
  seq: string
}

export interface FocusEvent {
  type: 'focus'
  focused: boolean
  seq: string
}

export type InputEvent = KeyEvent | MouseEvent | PasteEvent | FocusEvent

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const CSI_NAMES: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
  Z: 'tab'
}

const TILDE_NAMES: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
  '11': 'f1',
  '12': 'f2',
  '13': 'f3',
  '14': 'f4',
  '15': 'f5',
  '17': 'f6',
  '18': 'f7',
  '19': 'f8',
  '20': 'f9',
  '21': 'f10',
  '23': 'f11',
  '24': 'f12'
}

function key(
  name: string,
  seq: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}
): KeyEvent {
  return {
    type: 'key',
    name,
    seq,
    ctrl: mods.ctrl ?? false,
    alt: mods.alt ?? false,
    shift: mods.shift ?? false
  }
}

/** xterm modifier parameter (1 + shift + 2·alt + 4·ctrl). */
function modsOf(param: string | undefined): { ctrl: boolean; alt: boolean; shift: boolean } {
  const m = Math.max(0, Number(param ?? '1') - 1)
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0 }
}

/** One plain character (or control byte) as a key. */
function charKey(ch: string, alt: boolean, seq: string): KeyEvent {
  const code = ch.charCodeAt(0)
  if (ch === '\r' || ch === '\n') return key('enter', seq, { alt })
  if (ch === '\t') return key('tab', seq, { alt })
  if (ch === '\x7f' || ch === '\b') return key('backspace', seq, { alt })
  if (ch === '\x1b') return key('escape', seq, { alt })
  if (ch === ' ') return key('space', seq, { alt })
  if (ch === '\x00') return key('space', seq, { ctrl: true, alt })
  if (code < 32) {
    // Ctrl+letter, Ctrl+] (0x1d) and friends.
    const name = code <= 26 ? String.fromCharCode(code + 96) : String.fromCharCode(code + 64)
    return key(name, seq, { ctrl: true, alt })
  }
  return key(ch, seq, { alt, shift: ch !== ch.toLowerCase() })
}

/** Stateful: a sequence split across chunks (a paste, an escape) is completed by the next chunk. */
export class InputParser {
  private pending = ''
  private pasting: string | null = null

  feed(chunk: string): InputEvent[] {
    let data = this.pending + chunk
    this.pending = ''
    const out: InputEvent[] = []
    while (data.length > 0) {
      if (this.pasting !== null) {
        const end = data.indexOf(PASTE_END)
        if (end === -1) {
          this.pasting += data
          return out
        }
        const text = this.pasting + data.slice(0, end)
        out.push({ type: 'paste', text, seq: PASTE_START + text + PASTE_END })
        this.pasting = null
        data = data.slice(end + PASTE_END.length)
        continue
      }
      if (data.startsWith(PASTE_START)) {
        this.pasting = ''
        data = data.slice(PASTE_START.length)
        continue
      }
      if (data[0] !== '\x1b') {
        const ch = String.fromCodePoint(data.codePointAt(0) ?? 0)
        out.push(charKey(ch, false, ch))
        data = data.slice(ch.length)
        continue
      }
      // An escape sequence, or Escape itself.
      if (data.length === 1) {
        // Escape, or the start of a sequence whose rest is still on the way:
        // held until the next chunk or `flush()`.
        this.pending = data
        return out
      }
      const next = data[1]
      if (next === '[') {
        // eslint-disable-next-line no-control-regex -- real escape sequences
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data)
        if (mouse) {
          out.push(this.mouse(mouse))
          data = data.slice(mouse[0].length)
          continue
        }
        // eslint-disable-next-line no-control-regex -- real escape sequences
        const csi = /^\x1b\[([0-9;:?]*)([\x20-\x2f]*)([\x40-\x7e])/.exec(data)
        if (!csi) {
          // Incomplete: wait for the rest (bounded).
          if (data.length < 32) {
            this.pending = data
            return out
          }
          out.push(key('escape', '\x1b'))
          data = data.slice(1)
          continue
        }
        const [seq, params, , final] = csi
        data = data.slice(seq.length)
        const parts = params.split(';')
        if (final === 'I' || final === 'O') {
          out.push({ type: 'focus', focused: final === 'I', seq })
        } else if (final === '~') {
          const name = TILDE_NAMES[parts[0]]
          out.push(key(name ?? `csi${params}~`, seq, modsOf(parts[1])))
        } else if (final === 'Z') {
          out.push(key('tab', seq, { shift: true }))
        } else if (CSI_NAMES[final]) {
          out.push(key(CSI_NAMES[final], seq, modsOf(parts[1])))
        } else if (final === 'u') {
          // CSI u (kitty keyboard / modifyOtherKeys): codepoint;mods
          const code = Number(parts[0])
          const mods = modsOf(parts[1])
          const ch = String.fromCodePoint(code)
          out.push(
            code === 13
              ? key('enter', seq, mods)
              : code === 27
                ? key('escape', seq, mods)
                : key(ch.toLowerCase(), seq, mods)
          )
        } else {
          out.push(key(`csi${params}${final}`, seq))
        }
        continue
      }
      if (next === 'O') {
        if (data.length < 3) {
          this.pending = data
          return out
        }
        const seq = data.slice(0, 3)
        data = data.slice(3)
        out.push(key(CSI_NAMES[seq[2]] ?? `ss3${seq[2]}`, seq))
        continue
      }
      // Alt + a character (or Alt + Escape).
      const ch = String.fromCodePoint(data.codePointAt(1) ?? 0)
      const seq = `\x1b${ch}`
      out.push(charKey(ch, true, seq))
      data = data.slice(1 + ch.length)
    }
    return out
  }

  /** Whether an escape sequence is waiting for its end. */
  get waiting(): boolean {
    return this.pending.length > 0
  }

  /** A lone Escape held back as a possible sequence start: give it up. */
  flush(): InputEvent[] {
    if (!this.pending) return []
    const data = this.pending
    this.pending = ''
    // An unfinished sequence that never completed: Escape, then the rest as typed.
    const events: InputEvent[] = [key('escape', '\x1b'), ...this.feed(data.slice(1))]
    this.pending = ''
    return events
  }

  private mouse(m: RegExpExecArray): MouseEvent {
    const code = Number(m[1])
    const x = Number(m[2]) - 1
    const y = Number(m[3]) - 1
    const release = m[4] === 'm'
    const motion = (code & 32) !== 0
    const wheel = (code & 64) !== 0
    const low = code & 3
    return {
      type: 'mouse',
      button: wheel ? (low === 0 ? 'wheelup' : 'wheeldown') : low,
      action: release ? 'up' : motion ? 'move' : 'down',
      x,
      y,
      shift: (code & 4) !== 0,
      alt: (code & 8) !== 0,
      ctrl: (code & 16) !== 0,
      seq: m[0]
    }
  }
}

/** A mouse event re-encoded (SGR) at another position — for forwarding into an agent's terminal. */
export function encodeMouse(event: MouseEvent, x: number, y: number): string {
  let code =
    event.button === 'wheelup' ? 64 : event.button === 'wheeldown' ? 65 : (event.button as number)
  if (event.action === 'move') code |= 32
  if (event.shift) code |= 4
  if (event.alt) code |= 8
  if (event.ctrl) code |= 16
  return `\x1b[<${code};${x + 1};${y + 1}${event.action === 'up' ? 'm' : 'M'}`
}

/** Cursor keys in the form an agent that turned on application cursor mode expects. */
export function applicationCursor(seq: string): string {
  // eslint-disable-next-line no-control-regex -- real escape sequences
  const m = /^\x1b\[([ABCDHF])$/.exec(seq)
  return m ? `\x1bO${m[1]}` : seq
}
