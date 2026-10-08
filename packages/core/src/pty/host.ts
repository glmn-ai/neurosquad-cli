// Owns the live pseudo-terminals of agents: spawn, input, resize, kill, and
// the two start-up chores every host needs — answering a folder-trust prompt
// and recovering from a resume of a session the harness never saved.
//
// Every spawn, chunk of output, resize, submit and exit is published on
// ./events.ts, which the status hub and the screen mirror observe.
import type { IPty, IWindowsPtyForkOptions } from 'node-pty'
import {
  emitPtyData,
  emitPtyExit,
  emitPtyInput,
  emitPtyInterrupt,
  emitPtyResize,
  emitPtySpawn,
  emitPtySubmit
} from './events.js'
import { trackPtyExit } from './ptyExits.js'
import { ensureSpawnHelperExecutable } from './spawnHelper.js'
import { isInheritedSessionEnvKey } from './inheritedEnv.js'
import { submitsInput } from './input.js'
import { stripAnsi } from './plainText.js'

type NodePty = typeof import('node-pty')

let nodePty: NodePty | null = null

/** node-pty is loaded on first use (a host that never spawns does not need the addon). */
async function loadPty(): Promise<NodePty> {
  if (!nodePty) {
    const mod = (await import('node-pty')) as NodePty & { default?: NodePty }
    nodePty = mod.default ?? mod
  }
  return nodePty
}

/** The parent environment without the markers of a Claude Code session it may run inside. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isInheritedSessionEnvKey(key)) continue
    out[key] = value
  }
  return out
}

export interface SpawnRequest {
  agentId: string
  harness: string
  command: string
  args: string[]
  cwd: string
  /** Spread over the cleaned parent environment. */
  env: Record<string, string>
  cols: number
  rows: number
  useConptyDll?: boolean
  trustPrompt?: { marker: string; keys: string }
  /** Printed by a resumed launch whose session does not exist. */
  sessionNotFound?: readonly string[]
}

export interface SpawnHandlers {
  /**
   * A resumed launch printed its "session not found" line: the process is
   * killed and the host relaunches fresh (returns the fresh request, or null
   * to just let it exit).
   */
  onSessionNotFound?(): SpawnRequest | null
}

/** Startup chores are only looked for this long after the spawn. */
const MARKER_SCAN_WINDOW_MS = 120_000
const MARKER_SCAN_OVERLAP = 2048
const KEY_DELAY_MS = 200
/** Enter is sent this long after a programmatic prompt's text (a burst with `\r` reads as a line break). */
export const SUBMIT_KEY_DELAY_MS = 200

interface Live {
  pty: IPty
  generation: number
  cols: number
  rows: number
}

export class PtyHost {
  private readonly live = new Map<string, Live>()
  private readonly generations = new Map<string, number>()
  private shuttingDown = false

  isRunning(agentId: string): boolean {
    return this.live.has(agentId)
  }

  generationOf(agentId: string): number | undefined {
    return this.live.get(agentId)?.generation
  }

  sizeOf(agentId: string): { cols: number; rows: number } | undefined {
    const live = this.live.get(agentId)
    return live ? { cols: live.cols, rows: live.rows } : undefined
  }

  pidOf(agentId: string): number | undefined {
    return this.live.get(agentId)?.pty.pid
  }

  async spawn(
    request: SpawnRequest,
    handlers: SpawnHandlers = {},
    forceGeneration?: number
  ): Promise<number> {
    if (this.shuttingDown) throw new Error('shutting down: no new terminals start')
    const pty = await loadPty()
    ensureSpawnHelperExecutable()
    const generation = forceGeneration ?? (this.generations.get(request.agentId) ?? 0) + 1
    this.generations.set(request.agentId, generation)
    const cols = request.cols > 0 ? request.cols : 80
    const rows = request.rows > 0 ? request.rows : 24
    const options: IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols,
      rows,
      // Forward slashes: node-pty's ConPTY start rejects some backslash cwds.
      cwd: process.platform === 'win32' ? request.cwd.replaceAll('\\', '/') : request.cwd,
      env: { ...cleanEnv(), COLORTERM: 'truecolor', ...request.env }
    }
    let proc: IPty
    const plain = (): IPty => trackPtyExit(pty.spawn(request.command, request.args, options))
    if (request.useConptyDll && process.platform === 'win32') {
      try {
        proc = trackPtyExit(
          pty.spawn(request.command, request.args, { ...options, useConptyDll: true })
        )
      } catch {
        proc = plain()
      }
    } else proc = plain()
    const live: Live = { pty: proc, generation, cols, rows }
    this.live.set(request.agentId, live)
    emitPtySpawn(request.agentId, generation, { harness: request.harness, cols, rows })

    let trustHandled = request.trustPrompt === undefined
    let recoveryHandled = false
    const notFound = request.sessionNotFound?.map((marker) => marker.replace(/\s/g, '')) ?? []
    let recent = ''
    const deadline = Date.now() + MARKER_SCAN_WINDOW_MS
    proc.onData((chunk) => {
      if (recoveryHandled) return
      const armed = (!trustHandled || notFound.length > 0) && Date.now() < deadline
      if (armed) {
        const scan = recent + chunk
        recent = scan.slice(-MARKER_SCAN_OVERLAP)
        const text = stripAnsi(scan).replace(/\s+/g, ' ')
        if (!trustHandled && request.trustPrompt && text.includes(request.trustPrompt.marker)) {
          trustHandled = true
          const keys = request.trustPrompt.keys
          // A beat later: the prompt may not read keys the instant it is drawn.
          setTimeout(() => {
            if (this.live.get(request.agentId)?.pty === proc) proc.write(keys)
          }, KEY_DELAY_MS)
        }
        if (notFound.length > 0) {
          const compact = text.replace(/\s/g, '')
          if (notFound.some((marker) => compact.includes(marker))) {
            recoveryHandled = true
            try {
              proc.kill()
            } catch {
              // already gone
            }
            const fresh = handlers.onSessionNotFound?.() ?? null
            if (this.live.get(request.agentId)?.pty === proc) this.live.delete(request.agentId)
            if (fresh) {
              const size = { cols: live.cols, rows: live.rows }
              void this.spawn({ ...fresh, ...size }, {}, generation).catch((error) => {
                console.error('pty: fresh relaunch failed', error)
                emitPtyExit(request.agentId, generation)
              })
            } else {
              // No relaunch: the agent is gone, and everyone watching hears so.
              emitPtyExit(request.agentId, generation)
            }
            return
          }
        }
      } else if (recent) recent = ''
      emitPtyData(request.agentId, generation, chunk)
    })
    proc.onExit(() => {
      if (recoveryHandled) return
      if (this.live.get(request.agentId)?.pty === proc) this.live.delete(request.agentId)
      if (this.generations.get(request.agentId) === generation)
        emitPtyExit(request.agentId, generation)
    })
    return generation
  }

  /** Input as the person typed it (keys, a paste). */
  write(agentId: string, data: string): void {
    const live = this.live.get(agentId)
    if (!live) return
    live.pty.write(data)
    emitPtyInput(agentId, data, false)
    if (submitsInput(data)) emitPtySubmit(agentId)
  }

  /**
   * A programmatic prompt: the text, then Enter `SUBMIT_KEY_DELAY_MS` later
   * (Enter inside a burst of text reads as a line break, not a submit).
   * Multi-line text goes as a bracketed paste so it stays one prompt.
   */
  submit(agentId: string, text: string): boolean {
    const live = this.live.get(agentId)
    if (!live) return false
    const typed = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text
    live.pty.write(typed)
    emitPtyInput(agentId, typed, true)
    setTimeout(() => {
      if (this.live.get(agentId) !== live) return
      live.pty.write('\r')
      emitPtySubmit(agentId)
    }, SUBMIT_KEY_DELAY_MS)
    return true
  }

  /** Text pasted into the input without submitting it (dictation). */
  paste(agentId: string, text: string): boolean {
    const live = this.live.get(agentId)
    if (!live) return false
    const pasted = `\x1b[200~${text}\x1b[201~`
    live.pty.write(pasted)
    emitPtyInput(agentId, pasted, true)
    return true
  }

  /** The harness's own interrupt keys (not always Ctrl+C — that quits some CLIs). */
  interrupt(agentId: string, keys: string): void {
    const live = this.live.get(agentId)
    if (!live) return
    live.pty.write(keys)
    emitPtyInterrupt(agentId)
  }

  resize(agentId: string, cols: number, rows: number): void {
    const live = this.live.get(agentId)
    if (!live || cols <= 0 || rows <= 0) return
    if (live.cols === cols && live.rows === rows) return
    try {
      live.pty.resize(cols, rows)
    } catch {
      // ConPTY can throw on a process that is exiting: non-fatal.
    }
    live.cols = cols
    live.rows = rows
    emitPtyResize(agentId, cols, rows)
  }

  /** Stops the agent's process (a grace for its own cleanup, then a hard kill). */
  kill(agentId: string, graceMs = 150): Promise<void> {
    const live = this.live.get(agentId)
    if (!live) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      live.pty.onExit(() => finish())
      try {
        live.pty.kill()
      } catch {
        // Windows may throw for a process already gone.
      }
      setTimeout(
        () => {
          if (done) return
          try {
            if (process.platform !== 'win32') live.pty.kill('SIGKILL')
            else live.pty.kill()
          } catch {
            // gone
          }
          setTimeout(finish, 500)
        },
        Math.max(graceMs, 1500)
      )
    })
  }

  async killAll(): Promise<void> {
    this.shuttingDown = true
    await Promise.all([...this.live.keys()].map((agentId) => this.kill(agentId)))
  }
}
