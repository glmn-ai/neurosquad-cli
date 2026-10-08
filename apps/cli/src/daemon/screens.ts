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

// CommonJS packages: their exports are reached through the default one.
const { Terminal } = xtermHeadless
const { SerializeAddon } = serializeModule as unknown as typeof import('@xterm/addon-serialize')

const SCROLLBACK = 2000
/** Scrollback sent to a joining client. */
const JOIN_SCROLLBACK = 500

interface Screen {
  generation: number
  term: HeadlessTerminal
  serializer: InstanceType<typeof SerializeAddon>
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
    const screen: Screen = { generation, term, serializer }
    term.onData((data) => {
      if (this.screens.get(agentId) === screen) this.reply(agentId, data)
    })
    this.screens.set(agentId, screen)
  }

  write(agentId: string, generation: number, chunk: string): void {
    const screen = this.screens.get(agentId)
    if (screen && screen.generation === generation) screen.term.write(chunk)
  }

  resize(agentId: string, cols: number, rows: number): void {
    const screen = this.screens.get(agentId)
    if (!screen) return
    try {
      screen.term.resize(cols, rows)
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
