// A headless copy of every agent terminal's screen.
//
// The raw pty stream is not text a program can read back: a TUI like
// Claude Code or htop redraws the same rows over and over with cursor moves,
// so "strip the escape codes" yields every intermediate frame glued
// together. @xterm/headless is xterm.js without a renderer — the same parser
// a visible terminal uses — so its buffer holds exactly what the user sees,
// scrollback included. Used to replay a screen to a client that attaches.
//
// Parsed lazily: each agent keeps only the last RING_CHARS of raw output plus the DEC
// private modes it set (a cheap scan); the headless terminal is built from
// that the first time something reads the screen, kept up to date while it
// is read ("hot"), and dropped again after HOT_IDLE_MS without a reader.
//
// Also the host's notion of "is this terminal doing
// something right now": when output last arrived and when input was last
// submitted.
import xtermHeadless, { type Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { observePtys } from './events.js'

// A CommonJS package: its named exports are reached through the default one.
const { Terminal } = xtermHeadless

/** DEC private modes (`CSI ? n h/l`) in effect — copy-on-write, so ring entries can share one. */
type Modes = ReadonlyMap<number, boolean>

interface RingEntry {
  data: string
  /** Modes in effect just before `data` — what a replay starting here re-applies first. */
  before: Modes
  /** The mode scan's unfinished sequence at that point (its end opens `data`). */
  carry: string
}

interface Hot {
  term: HeadlessTerminal
  /**
   * Turns the buffer back into an ANSI stream that reproduces it — how a
   * second view of this terminal (a client attaching) joins with the
   * exact screen the agent shows instead of a blank one that only fills in
   * from the next byte of output.
   */
  serializer: SerializeAddon
  /**
   * Chunks written but not parsed yet (xterm parses in batches), oldest
   * first — what a snapshot taken now does not show (`mirrorSnapshot`'s
   * `pending`).
   */
  unparsed: string[]
  lastUsedAt: number
  timer: ReturnType<typeof setTimeout> | null
  disposed: boolean
}

interface Mirror {
  generation: number
  cols: number
  rows: number
  lastOutputAt: number
  lastSubmitAt: number
  spawnedAt: number
  ring: RingEntry[]
  ringChars: number
  /** Some output fell off the front of the ring: a replay must start at a safe boundary. */
  trimmed: boolean
  modes: Modes
  /** An escape sequence split across chunks, waiting for its end (mode scan only). */
  carry: string
  hot: Hot | null
}

/**
 * Enough for a reader asking for the last few hundred lines.
 */
const SCROLLBACK_LINES = 1000
/** Raw output kept per agent for a replay (UTF-16 chars). */
export const RING_CHARS = 256 * 1024
/** Small chunks are merged into ring entries of about this size. */
const ENTRY_CHARS = 16 * 1024
/** A parsed screen nobody read for this long is dropped (rebuilt from the ring on the next read). */
export const HOT_IDLE_MS = 30_000
/** Longest escape sequence the mode scan waits for across a chunk boundary. */
const MAX_CARRY = 64

const mirrors = new Map<string, Mirror>()

// `CSI ? Pm h|l` (DECSET/DECRST), RIS (`ESC c`), DECSTR (`CSI ! p`).
// eslint-disable-next-line no-control-regex -- real ESC bytes
const MODE_SEQUENCE = /\x1b\[\?([\d;]*)([hl])|\x1bc|\x1b\[!p/g
// A complete sequence at the start of a string — anything else after the
// last ESC may still be waiting for its end.
// eslint-disable-next-line no-control-regex -- real ESC bytes
const COMPLETE_ESCAPE = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|[^[])/
/** What xterm.js's soft reset (DECSTR) puts back: its CoreService modes. */
const SOFT_RESET_MODES = [1, 6, 7, 12, 45, 66, 1004, 2004, 2026]

/** `modes` after the complete mode sequences in `text`; the same object when none changed. */
export function applyModeSequences(modes: Modes, text: string): Modes {
  if (!text.includes('\x1b')) return modes
  let next: Map<number, boolean> | null = null
  const writable = (): Map<number, boolean> => (next ??= new Map(modes))
  for (const match of text.matchAll(MODE_SEQUENCE)) {
    if (match[0] === '\x1bc') {
      next = new Map()
    } else if (match[0] === '\x1b[!p') {
      const map = writable()
      for (const mode of SOFT_RESET_MODES) map.delete(mode)
    } else {
      const on = match[2] === 'h'
      const map = writable()
      for (const param of match[1].split(';')) {
        if (param !== '') map.set(Number(param), on)
      }
    }
  }
  return next ?? modes
}

/** The modes as sequences a fresh terminal can be given first. */
function modePreamble(modes: Modes): string {
  let out = ''
  for (const [mode, on] of modes) out += `\x1b[?${mode}${on ? 'h' : 'l'}`
  return out
}

/** Feeds the mode scan one chunk, holding back an escape sequence that has not ended yet. */
function scanModes(mirror: Mirror, chunk: string): void {
  if (mirror.carry === '' && !chunk.includes('\x1b')) return
  let text = mirror.carry + chunk
  mirror.carry = ''
  const lastEsc = text.lastIndexOf('\x1b')
  if (lastEsc !== -1 && text.length - lastEsc < MAX_CARRY) {
    const tail = text.slice(lastEsc)
    if (!COMPLETE_ESCAPE.test(tail)) {
      mirror.carry = tail
      text = text.slice(0, lastEsc)
    }
  }
  mirror.modes = applyModeSequences(mirror.modes, text)
}

function appendToRing(mirror: Mirror, chunk: string): void {
  // The state at this chunk's start, for an entry that begins here: a mode
  // sequence split across the boundary is the carry plus the entry's head.
  const before = mirror.modes
  const carry = mirror.carry
  scanModes(mirror, chunk)
  if (chunk.length > RING_CHARS) {
    // One chunk bigger than the whole ring: keep its tail, with the modes
    // its dropped head set.
    const cut = chunk.length - RING_CHARS
    mirror.ring = [
      {
        data: chunk.slice(cut),
        before: applyModeSequences(before, carry + chunk.slice(0, cut)),
        carry: ''
      }
    ]
    mirror.ringChars = RING_CHARS
    mirror.trimmed = true
    return
  }
  const last = mirror.ring[mirror.ring.length - 1]
  // Merging keeps `before` right: it describes the entry's start.
  if (last && last.data.length < ENTRY_CHARS) last.data += chunk
  else mirror.ring.push({ data: chunk, before, carry })
  mirror.ringChars += chunk.length
  while (mirror.ring.length > 1 && mirror.ringChars - mirror.ring[0].data.length >= RING_CHARS) {
    mirror.ringChars -= mirror.ring.shift()!.data.length
    mirror.trimmed = true
  }
}

/**
 * The ring as one stream a fresh terminal reproduces the screen from: the
 * modes in effect at its start, then the output. When the front was cut
 * off it may begin inside an escape sequence, so it starts after the first
 * line break instead (the modes of the skipped part included).
 */
export function replayText(mirror: Pick<Mirror, 'ring' | 'trimmed'>): string {
  const ring = mirror.ring
  if (ring.length === 0) return ''
  let start = 0
  let head = ring[0].data
  let before = ring[0].before
  if (mirror.trimmed) {
    let newline = head.indexOf('\n')
    while (newline === -1 && start + 1 < ring.length) {
      start += 1
      head = ring[start].data
      before = ring[start].before
      newline = head.indexOf('\n')
    }
    if (newline !== -1) {
      before = applyModeSequences(before, head.slice(0, newline + 1))
      head = head.slice(newline + 1)
    }
  }
  let text = modePreamble(before) + head
  for (let i = start + 1; i < ring.length; i++) text += ring[i].data
  return text
}

function disposeHot(mirror: Mirror): void {
  const hot = mirror.hot
  if (!hot) return
  mirror.hot = null
  hot.disposed = true
  if (hot.timer) clearTimeout(hot.timer)
  hot.term.dispose()
}

function dispose(agentId: string): void {
  const mirror = mirrors.get(agentId)
  if (!mirror) return
  mirrors.delete(agentId)
  disposeHot(mirror)
}

function scheduleCooling(mirror: Mirror, hot: Hot, delay: number): void {
  hot.timer = setTimeout(() => {
    hot.timer = null
    if (hot.disposed) return
    const idle = Date.now() - hot.lastUsedAt
    if (idle >= HOT_IDLE_MS) disposeHot(mirror)
    else scheduleCooling(mirror, hot, HOT_IDLE_MS - idle)
  }, delay)
  hot.timer.unref?.()
}

/** The parsed screen, built from the ring if nobody read it lately. */
function heat(mirror: Mirror): Hot {
  if (mirror.hot) {
    mirror.hot.lastUsedAt = Date.now()
    return mirror.hot
  }
  const term = new Terminal({
    cols: mirror.cols,
    rows: mirror.rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true
  })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)
  const hot: Hot = {
    term,
    serializer,
    unparsed: [],
    lastUsedAt: Date.now(),
    timer: null,
    disposed: false
  }
  // Not in `unparsed`: every reader waits for it before looking anyway.
  const replay = replayText(mirror)
  if (replay !== '') term.write(replay)
  mirror.hot = hot
  scheduleCooling(mirror, hot, HOT_IDLE_MS)
  return hot
}

/** Resolves once everything written to `hot` so far is on its buffer; false if it was dropped meanwhile. */
async function settled(hot: Hot): Promise<boolean> {
  if (hot.disposed) return false
  await new Promise<void>((resolve) => hot.term.write('', resolve))
  return !hot.disposed
}

observePtys({
  onSpawn(agentId, generation, { cols, rows }) {
    dispose(agentId)
    mirrors.set(agentId, {
      generation,
      cols,
      rows,
      lastOutputAt: Date.now(),
      lastSubmitAt: 0,
      spawnedAt: Date.now(),
      ring: [],
      ringChars: 0,
      trimmed: false,
      modes: new Map(),
      carry: '',
      hot: null
    })
  },
  onData(agentId, generation, chunk) {
    const mirror = mirrors.get(agentId)
    if (!mirror || mirror.generation !== generation) return
    appendToRing(mirror, chunk)
    mirror.lastOutputAt = Date.now()
    const hot = mirror.hot
    if (hot) {
      hot.unparsed.push(chunk)
      // Callbacks fire in write order, each right after its chunk is parsed.
      hot.term.write(chunk, () => void hot.unparsed.shift())
    }
  },
  onExit(agentId, generation) {
    if (mirrors.get(agentId)?.generation === generation) dispose(agentId)
  },
  onResize(agentId, cols, rows) {
    const mirror = mirrors.get(agentId)
    if (!mirror) return
    mirror.cols = cols
    mirror.rows = rows
    mirror.hot?.term.resize(cols, rows)
  },
  onSubmit(agentId) {
    const mirror = mirrors.get(agentId)
    if (mirror) mirror.lastSubmitAt = Date.now()
  }
})

/**
 * The last `lines` lines of what the agent shows (scrollback included, soft-
 * wrapped rows joined back into one line), or null when no process runs
 * behind it. Async because xterm parses writes in batches: an empty write's
 * callback fires once everything written before it is on the buffer.
 */
export async function screenText(agentId: string, lines: number): Promise<string | null> {
  const mirror = mirrors.get(agentId)
  if (!mirror) return null
  const hot = heat(mirror)
  if (!(await settled(hot))) return null
  const buffer = hot.term.buffer.active
  // From the bottom up, and only as far as needed: callers want the last few
  // dozen lines (an agent waiting on another polls this), and walking and
  // stringifying the whole scrollback — a thousand rows — to throw all but
  // those away was most of the cost. A logical line is a row plus the rows
  // wrapped onto it, so wrapped rows are gathered until the row they
  // continue; blank lines below the last text are skipped, as before.
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

export interface TerminalActivity {
  lastOutputAt: number
  lastSubmitAt: number
}

/** When this agent's process last printed and last got submitted input; null when none runs. */
export function terminalActivity(agentId: string): TerminalActivity | null {
  const mirror = mirrors.get(agentId)
  return mirror ? { lastOutputAt: mirror.lastOutputAt, lastSubmitAt: mirror.lastSubmitAt } : null
}

/**
 * What the program in the agent asked of its terminal, for typing into it
 * (agentTerminal/promptDelivery.ts): whether it turned bracketed paste on
 * (a paste then stays one prompt, line breaks and all), and when it started.
 * From the mode scan over every chunk so far — no parser needed.
 */
export async function terminalModes(
  agentId: string
): Promise<{ bracketedPaste: boolean; spawnedAt: number } | null> {
  const mirror = mirrors.get(agentId)
  if (!mirror) return null
  return { bracketedPaste: mirror.modes.get(2004) === true, spawnedAt: mirror.spawnedAt }
}

/** Scrollback sent to a joining view — enough to scroll back through a turn, not the whole buffer. */
const JOIN_SCROLLBACK_LINES = 400

/**
 * Everything a second view needs to join this terminal: its generation, its
 * real size, and the screen plus some scrollback as one ANSI string. `null`
 * when nothing is running. The headless buffer is written asynchronously, so
 * this waits for pending writes first — otherwise the join would miss the
 * last chunk that is also about to arrive as a live event, or show it twice.
 * Output that came in while it waited may still be unparsed when the screen
 * is serialized: that is `pending` (taken at the same instant), so a caller
 * that held the output meanwhile (the workspace recorder) loses nothing.
 */
export async function mirrorSnapshot(agentId: string): Promise<{
  generation: number
  cols: number
  rows: number
  data: string
  pending: string
} | null> {
  const mirror = mirrors.get(agentId)
  if (!mirror) return null
  const hot = heat(mirror)
  if (!(await settled(hot))) return null
  if (mirrors.get(agentId) !== mirror) return null
  return {
    generation: mirror.generation,
    cols: hot.term.cols,
    rows: hot.term.rows,
    data: hot.serializer.serialize({ scrollback: JOIN_SCROLLBACK_LINES }),
    pending: hot.unparsed.join('')
  }
}

/** Whether this agent's screen is parsed right now (tests). */
export function isMirrorHot(agentId: string): boolean {
  return mirrors.get(agentId)?.hot != null
}
