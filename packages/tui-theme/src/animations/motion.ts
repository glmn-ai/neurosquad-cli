/**
 * When to animate at all. Decorative motion is a nicety; it must never cost the user a slow link,
 * a flickering 16-colour console or a vestibular headache. Every "no" here means the effects render
 * their static resting frame instead.
 */
import type { ColorLevel } from '../color.js'
import { isRemoteSession, type Env } from '../capabilities.js'

export interface MotionInput {
  env?: Env
  colorLevel: ColorLevel
  /** The user's `reduceMotion` setting. */
  reduceMotion?: boolean
  /** Override remote detection (default: SSH env vars). */
  remote?: boolean
}

export interface MotionPolicy {
  animate: boolean
  /** Frames per second for decorative effects (spinner, shimmer, pulse). */
  fps: number
  /** Frames per second for short transitions (expand / collapse). */
  transitionFps: number
  reason: string
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())

/**
 * Off when: `NSQ_NO_ANIMATION=1`, `reduceMotion`, colour off or 16 colours (`NO_COLOR` lands here),
 * or an SSH session (unless `NSQ_ANIMATION=1` forces it on). On: 12 fps decorative, 30 fps
 * transitions.
 */
export function resolveMotion(input: MotionInput): MotionPolicy {
  const env = input.env ?? process.env
  const off = (reason: string): MotionPolicy => ({
    animate: false,
    fps: 0,
    transitionFps: 0,
    reason
  })
  if (truthy(env.NSQ_NO_ANIMATION)) return off('NSQ_NO_ANIMATION')
  if (input.reduceMotion) return off('reduceMotion')
  if (input.colorLevel <= 1) return off(input.colorLevel === 0 ? 'no colour' : '16 colours')
  const remote = input.remote ?? isRemoteSession(env)
  if (remote && !truthy(env.NSQ_ANIMATION))
    return off('remote session (set NSQ_ANIMATION=1 to animate)')
  return { animate: true, fps: 12, transitionFps: 30, reason: 'on' }
}

/**
 * Watches how long terminal writes take to flush (a slow SSH / serial link shows up as write
 * callbacks arriving late) and says when animation should stop. Feed it with `track(write)` or
 * `record(ms)`.
 */
export class WriteLatencyMeter {
  private ewma = 0
  private samples = 0
  constructor(
    /** Above this smoothed flush time (ms) the link counts as slow. */
    private readonly thresholdMs = 25,
    /** Ignore the verdict until this many samples. */
    private readonly minSamples = 5,
    private readonly now: () => number = () => performance.now()
  ) {}

  record(ms: number): void {
    this.samples++
    this.ewma = this.samples === 1 ? ms : this.ewma * 0.8 + ms * 0.2
  }

  /** Wraps a `stream.write(data, cb)` call and records how long the flush took. */
  track(write: (data: string, cb: () => void) => unknown, data: string): void {
    const start = this.now()
    write(data, () => this.record(this.now() - start))
  }

  get slow(): boolean {
    return this.samples >= this.minSamples && this.ewma > this.thresholdMs
  }

  get averageMs(): number {
    return this.ewma
  }
}
