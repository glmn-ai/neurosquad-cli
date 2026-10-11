// A headless copy of each running agent's screen, kept by the daemon so a
// client that connects later (the dashboard, `nsq attach`) starts from exactly
// what the agent shows, then follows the live output without a gap or a
// duplicated chunk.
//
// Joining: the client is marked "joining" and every chunk from then on is
// buffered for it; an empty write is queued behind everything written so far,
// and when xterm has parsed up to it the screen is serialized. Chunks written
// after that marker are exactly the ones the snapshot does not contain, and
// they are the buffered ones — sent right after the snapshot.
import xtermHeadless, { type Terminal as HeadlessTerminal } from '@xterm/headless'
import serializeModule from '@xterm/addon-serialize'
import graphemesModule from '@xterm/addon-unicode-graphemes'
import type { IBufferCell } from '@xterm/headless'
import { paletteToRgb } from '@neurosquad/term-view'
import {
  RUN_CURSOR,
  RUN_WIDE,
  type PhoneScreenRun,
  type PhoneScreenStyle,
  type PhoneStyledScreen
} from '@neurosquad/remote'

// CommonJS packages: their exports are reached through the default one.
const { Terminal } = xtermHeadless
const { SerializeAddon } = serializeModule as unknown as typeof import('@xterm/addon-serialize')
const { UnicodeGraphemesAddon } =
  graphemesModule as unknown as typeof import('@xterm/addon-unicode-graphemes')

const SCROLLBACK = 2000
/** Scrollback sent to a joining client. */
const JOIN_SCROLLBACK = 500

interface Screen {
  generation: number
  term: HeadlessTerminal
  serializer: InstanceType<typeof SerializeAddon>
  /** Bumped whenever the contents may have changed (output parsed, a resize). */
  version: number
  /** DECTCEM: the program shows its cursor. */
  cursorVisible: boolean
}

const hex = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`

/** A cell's colour on the phone's wire: a theme slot for the 16 colours, else #rrggbb. */
function cellColor(cell: IBufferCell, layer: 'fg' | 'bg'): string | undefined {
  const fg = layer === 'fg'
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return undefined
  const value = fg ? cell.getFgColor() : cell.getBgColor()
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return hex(value & 0xffffff)
  return value < 16 ? `p${value}` : hex(paletteToRgb(value & 0xff))
}

function cellStyle(cell: IBufferCell): PhoneScreenStyle {
  const fg = cellColor(cell, 'fg')
  const bg = cellColor(cell, 'bg')
  return {
    ...(fg ? { fg } : {}),
    ...(bg ? { bg } : {}),
    ...(cell.isBold() ? { bold: true as const } : {}),
    ...(cell.isDim() ? { dim: true as const } : {}),
    ...(cell.isItalic() ? { italic: true as const } : {}),
    ...(cell.isUnderline() ? { underline: true as const } : {}),
    ...(cell.isInverse() ? { inverse: true as const } : {}),
    ...(cell.isStrikethrough() ? { strike: true as const } : {}),
    ...(cell.isInvisible() ? { invisible: true as const } : {})
  }
}

export interface ScreenJoin {
  generation: number
  cols: number
  rows: number
  data: string
}

export class Screens {
  private readonly screens = new Map<string, Screen>()
  /**
   * Screen versions come from one sequence for every terminal: a respawned agent's new screen
   * never reuses a version a phone still holds (which would read as "unchanged").
   */
  private versionSeq = 0

  /**
   * `reply` receives the terminal's answers to the agent's queries (device
   * attributes, cursor position, colours): the daemon's screen is the one
   * that answers, so an agent gets them whether or not a client is attached.
   * Clients' own views stay silent.
   */
  constructor(private readonly reply: (agentId: string, data: string) => void = () => {}) {}

  spawn(agentId: string, generation: number, cols: number, rows: number): void {
    this.dispose(agentId)
    const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
    const serializer = new SerializeAddon()
    term.loadAddon(serializer)
    // Character widths as the dashboard's views measure them (emoji and CJK two cells, grapheme
    // clusters one character), so the phone page lays out a line as the agent drew it.
    term.loadAddon(new UnicodeGraphemesAddon())
    term.unicode.activeVersion = '15-graphemes'
    const screen: Screen = {
      generation,
      term,
      serializer,
      version: ++this.versionSeq,
      cursorVisible: true
    }
    // DECTCEM (CSI ? 25 h / l): seen, then left to xterm.
    for (const final of ['h', 'l'] as const) {
      term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.some((p) => p === 25)) screen.cursorVisible = final === 'h'
        return false
      })
    }
    // A reset (RIS, DECSTR) shows the cursor again, as in term-view.
    const shown = (): boolean => {
      screen.cursorVisible = true
      return false
    }
    term.parser.registerEscHandler({ final: 'c' }, shown)
    term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, shown)
    term.onData((data) => {
      if (this.screens.get(agentId) === screen) this.reply(agentId, data)
    })
    this.screens.set(agentId, screen)
  }

  write(agentId: string, generation: number, chunk: string): void {
    const screen = this.screens.get(agentId)
    if (screen && screen.generation === generation) {
      screen.term.write(chunk, () => {
        screen.version = ++this.versionSeq
      })
    }
  }

  resize(agentId: string, cols: number, rows: number): void {
    const screen = this.screens.get(agentId)
    if (!screen) return
    try {
      screen.term.resize(cols, rows)
      screen.version = ++this.versionSeq
    } catch {
      // a disposed terminal
    }
  }

  dispose(agentId: string): void {
    const screen = this.screens.get(agentId)
    if (!screen) return
    this.screens.delete(agentId)
    screen.term.dispose()
  }

  has(agentId: string): boolean {
    return this.screens.has(agentId)
  }

  /**
   * Serializes the screen once everything written so far is parsed. The
   * caller must buffer chunks from the moment it calls this (synchronously)
   * and send them after the result.
   */
  join(agentId: string): Promise<ScreenJoin | null> {
    const screen = this.screens.get(agentId)
    if (!screen) return Promise.resolve(null)
    return new Promise((resolve) => {
      screen.term.write('', () => {
        if (this.screens.get(agentId) !== screen) {
          resolve(null)
          return
        }
        resolve({
          generation: screen.generation,
          cols: screen.term.cols,
          rows: screen.term.rows,
          data: screen.serializer.serialize({ scrollback: JOIN_SCROLLBACK })
        })
      })
    })
  }

  /**
   * The last `lines` lines with their styles (the phone page's terminal view), or only the
   * version when it is still `since`. Lines are runs of cells with one style; a wide character
   * is a run of its own, and so is the cell under a visible cursor.
   */
  styled(
    agentId: string,
    lines: number,
    since?: number
  ): { version: number; screen?: PhoneStyledScreen } | null {
    const screen = this.screens.get(agentId)
    if (!screen) return null
    const version = screen.version
    if (since === version) return { version }
    const term = screen.term
    const buffer = term.buffer.active
    const styles: PhoneScreenStyle[] = [{}]
    const styleIds = new Map<string, number>([['{}', 0]])
    const styleId = (style: PhoneScreenStyle): number => {
      const key = JSON.stringify(style)
      let id = styleIds.get(key)
      if (id === undefined) {
        id = styles.length
        styles.push(style)
        styleIds.set(key, id)
      }
      return id
    }
    const cursorRow = buffer.baseY + buffer.cursorY
    const showCursor = screen.cursorVisible
    const cell = buffer.getNullCell()
    const out: PhoneScreenRun[][] = []
    const first = Math.max(0, buffer.length - lines)
    let lastUsed = -1
    for (let y = first; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      const runs: PhoneScreenRun[] = []
      const cursorHere = showCursor && y === cursorRow
      if (line) {
        // Trailing blank, unstyled cells are dropped (the cursor's cell is kept).
        let end = line.length
        while (end > 0) {
          const c = line.getCell(end - 1, cell)
          if (!c) break
          const blank =
            (c.getChars() === '' || c.getChars() === ' ') && c.isBgDefault() && !c.isInverse()
          if (!blank || (cursorHere && end - 1 <= buffer.cursorX)) break
          end -= 1
        }
        let text = ''
        let style = -1
        const flush = (): void => {
          if (text) runs.push([text, style])
          text = ''
        }
        for (let x = 0; x < end; x++) {
          const c = line.getCell(x, cell)
          if (!c) break
          const width = c.getWidth()
          if (width === 0) continue
          const id = styleId(cellStyle(c))
          const chars = c.getChars() || ' '
          const isCursor = cursorHere && x === buffer.cursorX
          if (width === 2 || isCursor) {
            flush()
            runs.push([chars, id, (width === 2 ? RUN_WIDE : 0) | (isCursor ? RUN_CURSOR : 0)])
            continue
          }
          if (id !== style) {
            flush()
            style = id
          }
          text += chars
        }
        flush()
      }
      if (cursorHere && !runs.some((run) => ((run[2] ?? 0) & RUN_CURSOR) !== 0)) {
        // The cursor past the end of the text: blank cells up to it, then the cursor.
        const used = runs.reduce(
          (n, run) => n + ((run[2] ?? 0) & RUN_WIDE ? 2 : [...run[0]].length),
          0
        )
        if (buffer.cursorX > used) runs.push([' '.repeat(buffer.cursorX - used), 0])
        runs.push([' ', 0, RUN_CURSOR])
      }
      if (runs.length) lastUsed = out.length
      out.push(runs)
    }
    // Blank lines under the last one used (the empty rest of the screen) are not sent.
    out.length = lastUsed + 1
    return {
      version,
      screen: {
        cols: term.cols,
        lines: out,
        styles,
        ...(buffer.type === 'alternate' ? { alternate: true as const } : {})
      }
    }
  }

  /** The last `lines` non-empty lines of plain text (the dashboard's preview, `nsq peek`). */
  tail(agentId: string, lines: number): string[] {
    const screen = this.screens.get(agentId)
    if (!screen) return []
    const buffer = screen.term.buffer.active
    const out: string[] = []
    for (let y = buffer.length - 1; y >= 0 && out.length < lines; y--) {
      const text = buffer.getLine(y)?.translateToString(true).trimEnd() ?? ''
      if (out.length === 0 && !text.trim()) continue
      out.push(text)
    }
    return out.reverse()
  }
}
