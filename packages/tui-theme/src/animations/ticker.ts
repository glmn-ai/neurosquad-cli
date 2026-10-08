/**
 * One clock for every effect in the TUI. Nine live tiles must not mean nine timers: subscribers
 * share a single interval that runs at the fastest rate anyone asked for (capped), and each one is
 * called only when its own period is due. The interval exists only while someone listens, the
 * ticker is enabled and nothing has paused it (hidden, backgrounded, attached to an agent).
 */

export interface TickerClock {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realClock: TickerClock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms)
    h.unref?.()
    return h
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}

export type TickListener = (now: number) => void

interface Sub {
  fn: TickListener
  periodMs: number
  last: number
}

export interface TickerOptions {
  /** Highest rate any subscriber may get (default 30). */
  maxFps?: number
  clock?: TickerClock
}

export type PauseReason = 'hidden' | 'background' | 'attached' | (string & {})

export class Ticker {
  private readonly subs = new Set<Sub>()
  private readonly pauses = new Set<PauseReason>()
  private handle: unknown
  private intervalMs = 0
  private enabled = true
  private readonly maxFps: number
  private readonly clock: TickerClock

  constructor(opts: TickerOptions = {}) {
    this.maxFps = opts.maxFps ?? 30
    this.clock = opts.clock ?? realClock
  }

  /** Calls `fn(now)` about `fps` times a second until the returned function is called. */
  subscribe(fn: TickListener, opts: { fps?: number } = {}): () => void {
    const fps = Math.max(1, Math.min(this.maxFps, opts.fps ?? 12))
    const sub: Sub = { fn, periodMs: 1000 / fps, last: -Infinity }
    this.subs.add(sub)
    this.reschedule()
    return () => {
      if (this.subs.delete(sub)) this.reschedule()
    }
  }

  /** Stops ticking for a reason (several can be active); `resume` with the same reason. */
  pause(reason: PauseReason): void {
    this.pauses.add(reason)
    this.reschedule()
  }

  resume(reason: PauseReason): void {
    if (this.pauses.delete(reason)) this.reschedule()
  }

  /** Master switch from the motion policy / a slow-link verdict. */
  setEnabled(on: boolean): void {
    this.enabled = on
    this.reschedule()
  }

  get running(): boolean {
    return this.handle !== undefined
  }

  get subscriberCount(): number {
    return this.subs.size
  }

  /** Current time on the ticker's clock (pass it to effects for a frame outside a tick). */
  now(): number {
    return this.clock.now()
  }

  /** Stops everything and drops all subscribers. */
  dispose(): void {
    this.subs.clear()
    this.reschedule()
  }

  private tick = (): void => {
    const now = this.clock.now()
    for (const sub of [...this.subs]) {
      // Allow a little slack so a 12 fps listener on a 30 fps interval does not drift to 10 fps.
      if (now - sub.last >= sub.periodMs - 4) {
        sub.last = now
        try {
          sub.fn(now)
        } catch {
          // An effect that throws must not stop the others.
        }
      }
    }
  }

  private reschedule(): void {
    const active = this.enabled && this.pauses.size === 0 && this.subs.size > 0
    let wanted = 0
    if (active) {
      let minPeriod = Infinity
      for (const s of this.subs) minPeriod = Math.min(minPeriod, s.periodMs)
      wanted = Math.max(1000 / this.maxFps, minPeriod)
    }
    if (wanted === this.intervalMs && (this.handle !== undefined) === active) return
    if (this.handle !== undefined) {
      this.clock.clearInterval(this.handle)
      this.handle = undefined
    }
    this.intervalMs = wanted
    if (active) this.handle = this.clock.setInterval(this.tick, wanted)
  }
}

/** The process-wide ticker. Use it unless you are testing. */
export const sharedTicker = new Ticker()
