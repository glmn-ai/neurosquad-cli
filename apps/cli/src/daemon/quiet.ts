// "Quiet while working" in the daemon: a working agent whose screen has not changed for
// `quietAfter` minutes (config.json, default 5; 0 = off; `nsq set <agent> --quiet-after` per
// agent) is flagged quiet — a tool inside a command it runs may be asking something no hook
// reports (git's password, `[y/N]`, ssh's host key), or something hangs. The comparison that
// tells real output from a turning spinner is @neurosquad/core's QuietWatch; this module owns the
// clock: it samples the daemon's headless screens while an agent works, and tells the daemon when
// an episode starts and how it ends. It never types anything into the agent.
import {
  DEFAULT_QUIET_AFTER_MIN,
  QUIET_LINE_MAX,
  QuietWatch,
  type AgentStatusKind,
  type QuietFlag
} from '@neurosquad/core'
import { cleanText } from './approvals.js'
import type { ApprovalBy } from './approvals.js'

/** How a quiet episode ended. */
export type QuietEnd =
  | 'output' // the screen changed (new output)
  | 'input' // someone typed, pasted or sent something into the agent
  | 'hook' // the harness reported progress (a hook)
  | 'finished' // the turn ended
  | 'needs-input' // the harness asked a question of its own
  | 'idle' // interrupted / back at its prompt
  | 'exited' // the process ended (stopped, restarted, crashed, removed)
  | 'unanswered' // nsq itself stopped

/** What clients see of a quiet episode (`AgentView.quiet`): secrets in the line masked. */
export interface QuietView {
  /** When the screen last changed (the quiet started). Epoch ms. */
  since: number
  /** When nsq flagged it. */
  at: number
  /** The last non-empty screen line, plain words, secret-looking parts masked, ≤ 300 chars. */
  line?: string
  /** The line looks like a tool asking something (a password, a yes/no): that line. */
  asking?: string
}

export function quietView(flag: QuietFlag): QuietView {
  return {
    since: flag.since,
    at: flag.at,
    ...(flag.line ? { line: cleanText(flag.line, QUIET_LINE_MAX) } : {}),
    ...(flag.asking ? { asking: cleanText(flag.asking, QUIET_LINE_MAX) } : {})
  }
}

/** "7 min", "45 s". */
export function quietDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`
}

/** The threshold in ms from minutes (config or per agent); 0 = off, nonsense = the default. */
export function quietAfterMs(...minutes: (number | undefined)[]): number {
  for (const value of minutes) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value * 60_000
  }
  return DEFAULT_QUIET_AFTER_MIN * 60_000
}

/** A screen sample check at most this often… */
const SAMPLE_MAX_MS = 2000
/** …and at least this often (short test thresholds). */
const SAMPLE_MIN_MS = 200

export interface QuietHost {
  /** The visible rows of the agent's screen and its version (bumped on every change), or null. */
  screen(agentId: string): { version: number; lines: string[] } | null
  /** The agent's threshold in ms (0: off). */
  afterMs(agentId: string): number
  onStart(agentId: string, flag: QuietView): void
  onEnd(agentId: string, flag: QuietView, how: QuietEnd, by?: ApprovalBy): void
  now?(): number
}

export class QuietMonitor {
  private readonly watch = new QuietWatch()
  /** The screen version each watched agent was last sampled at. */
  private readonly sampled = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly host: QuietHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  /** A published status: working starts (or keeps) the watch; anything else ends it. */
  status(agentId: string, kind: AgentStatusKind): void {
    if (kind === 'working') {
      if (this.watch.watching(agentId)) this.activity(agentId, 'hook')
      else {
        this.watch.watch(agentId, this.now())
        this.sampled.delete(agentId)
        this.arm()
      }
      return
    }
    this.end(agentId, kind)
  }

  /** The process ended or the agent was removed. */
  exited(agentId: string): void {
    this.end(agentId, 'exited')
  }

  /** Progress the screen may not show: the person's input, a hook. */
  activity(agentId: string, how: 'input' | 'hook', by?: ApprovalBy): void {
    const ended = this.watch.touch(agentId, this.now())
    this.sampled.delete(agentId)
    if (ended) this.host.onEnd(agentId, quietView(ended), how, by)
  }

  /** The agent's current episode, if it is quiet now. */
  current(agentId: string): QuietView | undefined {
    const flag = this.watch.flag(agentId)
    return flag ? quietView(flag) : undefined
  }

  /** nsq stops: open episodes end unanswered. */
  closeAll(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const id of this.watch.watched()) this.end(id, 'unanswered')
  }

  private end(agentId: string, how: QuietEnd): void {
    this.sampled.delete(agentId)
    const ended = this.watch.unwatch(agentId)
    if (ended) this.host.onEnd(agentId, quietView(ended), how)
  }

  private arm(): void {
    if (this.timer || this.stopped) return
    const ids = this.watch.watched()
    if (ids.length === 0) return
    const shortest = Math.min(...ids.map((id) => this.host.afterMs(id)).filter((ms) => ms > 0))
    const delay = Number.isFinite(shortest)
      ? Math.min(SAMPLE_MAX_MS, Math.max(SAMPLE_MIN_MS, Math.floor(shortest / 4)))
      : SAMPLE_MAX_MS
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
      this.arm()
    }, delay)
    this.timer.unref?.()
  }

  /** One round: sample every watched agent whose screen changed, then flag the quiet ones. */
  tick(): void {
    const now = this.now()
    for (const id of this.watch.watched()) {
      try {
        const screen = this.host.screen(id)
        if (!screen) continue
        if (this.sampled.get(id) !== screen.version) {
          this.sampled.set(id, screen.version)
          const { ended } = this.watch.observe(id, screen.lines, now)
          if (ended) this.host.onEnd(id, quietView(ended), 'output')
        }
        const flag = this.watch.due(id, now, this.host.afterMs(id), screen.lines)
        if (flag) this.host.onStart(id, quietView(flag))
      } catch {
        // one agent's screen never stops the others
      }
    }
  }
}

/** Focus reports (a terminal gaining or losing focus) are the terminal talking, not a person. */
// eslint-disable-next-line no-control-regex -- ESC of the focus reports
const FOCUS_ONLY = /^(?:\u001b\[[IO])+$/

/** Whether input written into an agent's terminal is the person's own (not a focus report). */
export function typedByPerson(data: string): boolean {
  return data.length > 0 && !FOCUS_ONLY.test(data)
}
