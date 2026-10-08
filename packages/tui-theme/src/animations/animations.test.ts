import { describe, expect, it } from 'vitest'
import { lineText, lineWidth } from '../text.js'
import { createTheme } from '../theme.js'
import { ROLE_SOURCES } from '../tokens.js'
import { wordmark } from '../wordmark.js'
import {
  attentionPulse,
  fadeIn,
  lerpRect,
  progressBar,
  sparkle,
  spinner,
  thinking,
  transitionRect,
  typewriter,
  wordmarkSweep
} from './effects.js'
import { WriteLatencyMeter, resolveMotion } from './motion.js'
import { Ticker, type TickerClock } from './ticker.js'

const theme = createTheme({ env: {}, isTTY: true, platform: 'linux', colorLevel: 3, unicode: true })
const ascii = createTheme({
  env: {},
  isTTY: true,
  platform: 'linux',
  colorLevel: 3,
  unicode: false
})

class FakeClock implements TickerClock {
  t = 0
  timers = new Map<number, { fn: () => void; ms: number; next: number }>()
  private id = 0
  now(): number {
    return this.t
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.id
    this.timers.set(id, { fn, ms, next: this.t + ms })
    return id
  }
  clearInterval(h: unknown): void {
    this.timers.delete(h as number)
  }
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let next: { fn: () => void; ms: number; next: number } | undefined
      for (const tm of this.timers.values())
        if (tm.next <= end && (!next || tm.next < next.next)) next = tm
      if (!next) break
      this.t = next.next
      next.next += next.ms
      next.fn()
    }
    this.t = end
  }
}

describe('Ticker', () => {
  it('runs one interval for any number of subscribers', () => {
    const clock = new FakeClock()
    const ticker = new Ticker({ clock })
    const counts = new Array(9).fill(0)
    const offs = counts.map((_, i) => ticker.subscribe(() => counts[i]++, { fps: 12 }))
    expect(clock.timers.size).toBe(1)
    clock.advance(1000)
    for (const c of counts) expect(c).toBeGreaterThanOrEqual(11)
    for (const c of counts) expect(c).toBeLessThanOrEqual(13)
    offs.forEach((off) => off())
    expect(clock.timers.size).toBe(0)
    expect(ticker.running).toBe(false)
  })

  it('serves slower subscribers at their own rate from a faster interval', () => {
    const clock = new FakeClock()
    const ticker = new Ticker({ clock })
    let fast = 0
    let slow = 0
    ticker.subscribe(() => fast++, { fps: 30 })
    ticker.subscribe(() => slow++, { fps: 10 })
    clock.advance(1000)
    expect(fast).toBeGreaterThanOrEqual(29)
    expect(slow).toBeGreaterThanOrEqual(9)
    expect(slow).toBeLessThanOrEqual(11)
  })

  it('stops while paused for any reason and when disabled', () => {
    const clock = new FakeClock()
    const ticker = new Ticker({ clock })
    let n = 0
    ticker.subscribe(() => n++)
    ticker.pause('hidden')
    ticker.pause('attached')
    clock.advance(1000)
    expect(n).toBe(0)
    expect(clock.timers.size).toBe(0)
    ticker.resume('hidden')
    expect(ticker.running).toBe(false)
    ticker.resume('attached')
    expect(ticker.running).toBe(true)
    ticker.setEnabled(false)
    expect(ticker.running).toBe(false)
    clock.advance(1000)
    expect(n).toBe(0)
  })

  it('a throwing subscriber does not stop the others', () => {
    const clock = new FakeClock()
    const ticker = new Ticker({ clock })
    let n = 0
    ticker.subscribe(() => {
      throw new Error('boom')
    })
    ticker.subscribe(() => n++)
    clock.advance(500)
    expect(n).toBeGreaterThan(0)
  })
})

describe('resolveMotion', () => {
  it('animates on a capable local terminal', () => {
    expect(resolveMotion({ env: {}, colorLevel: 3 })).toMatchObject({ animate: true, fps: 12 })
  })

  it('goes static for NSQ_NO_ANIMATION, reduceMotion, ≤16 colours and SSH', () => {
    expect(resolveMotion({ env: { NSQ_NO_ANIMATION: '1' }, colorLevel: 3 }).animate).toBe(false)
    expect(resolveMotion({ env: {}, colorLevel: 3, reduceMotion: true }).animate).toBe(false)
    expect(resolveMotion({ env: {}, colorLevel: 1 }).animate).toBe(false)
    expect(resolveMotion({ env: {}, colorLevel: 0 }).animate).toBe(false)
    expect(resolveMotion({ env: { SSH_CONNECTION: '1 2 3 4' }, colorLevel: 3 }).animate).toBe(false)
    expect(
      resolveMotion({ env: { SSH_TTY: '/dev/pts/1', NSQ_ANIMATION: '1' }, colorLevel: 3 }).animate
    ).toBe(true)
  })

  it('the latency meter flags a slow link after enough samples', () => {
    const m = new WriteLatencyMeter(25, 5)
    for (let i = 0; i < 4; i++) m.record(80)
    expect(m.slow).toBe(false)
    m.record(80)
    expect(m.slow).toBe(true)
    const fast = new WriteLatencyMeter()
    for (let i = 0; i < 20; i++) fast.record(2)
    expect(fast.slow).toBe(false)
    let t = 0
    const timed = new WriteLatencyMeter(25, 1, () => t)
    timed.track((_d, cb) => {
      t += 40
      cb()
    }, 'x')
    expect(timed.slow).toBe(true)
  })
})

describe('effects', () => {
  it('have a static resting frame', () => {
    expect(spinner(theme, undefined).text).toBe('◐')
    expect(lineText(thinking(theme, 'Thinking…', undefined))).toBe('Thinking…')
    expect(attentionPulse(undefined).color).toEqual(ROLE_SOURCES.needsYou)
    expect(fadeIn(undefined, 0)).toBe(1)
    expect(lineText(typewriter(theme, 'abc', undefined, 0))).toBe('abc')
    expect(sparkle(theme, undefined, 0)).toMatchObject({ done: true })
    expect(
      transitionRect(
        undefined,
        0,
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 0, y: 0, width: 9, height: 9 }
      )
    ).toBeUndefined()
    expect(wordmarkSweep(theme, undefined, 0)).toEqual({ lines: wordmark(theme), done: true })
  })

  it('the spinner cycles one-cell braille frames', () => {
    const frames = new Set<string>()
    for (let t = 0; t < 1000; t += 83) frames.add(spinner(theme, t).text)
    expect(frames.size).toBeGreaterThan(5)
    for (const f of frames) expect(lineWidth([{ text: f }])).toBe(1)
    expect(['|', '/', '-', '\\']).toContain(spinner(ascii, 500).text)
  })

  it('thinking decodes to the real text, keeps its width, and is deterministic', () => {
    for (const t of [0, 100, 300, 2000]) {
      const l = thinking(theme, 'Thinking…', t, { startedAt: 0 })
      expect(lineWidth(l)).toBe(9)
      expect(thinking(theme, 'Thinking…', t, { startedAt: 0 })).toEqual(l)
    }
    expect(lineText(thinking(theme, 'Thinking…', 5000, { startedAt: 0 }))).toBe('Thinking…')
    expect(lineText(thinking(theme, 'Thinking…', 10, { startedAt: 0 }))).not.toBe('Thinking…')
    expect(lineWidth(thinking(theme, '思考中', 10, { startedAt: 0 }))).toBe(6)
  })

  it('the needs-you pulse bursts, then breathes, in 8 steps', () => {
    const levels = new Set<number>()
    for (let t = 0; t < 10000; t += 37) {
      const p = attentionPulse(t, 0)
      expect(p.level).toBeGreaterThanOrEqual(0)
      expect(p.level).toBeLessThanOrEqual(1)
      expect(Number.isInteger(p.level * 8)).toBe(true)
      expect(p.burst).toBe(t < 2700)
      levels.add(p.level)
    }
    expect(levels.size).toBeGreaterThan(4)
  })

  it('sparkle ends on the success check', () => {
    expect(sparkle(theme, 100, 0)).toMatchObject({ done: false })
    expect(sparkle(theme, 2000, 0).seg.text).toBe('✔')
  })

  it('progress bars keep their width', () => {
    for (const ratio of [0, 0.33, 0.5, 0.99, 1, undefined]) {
      for (const t of [undefined, 0, 900]) {
        expect(lineWidth(progressBar(theme, t, { width: 24, ratio }))).toBe(24)
        expect(lineWidth(progressBar(ascii, t, { width: 24, ratio }))).toBe(24)
      }
    }
  })

  it('transitions interpolate between the rects and then end', () => {
    const a = { x: 10, y: 0, width: 20, height: 10 }
    const b = { x: 0, y: 0, width: 60, height: 30 }
    expect(lerpRect(a, b, 0)).toEqual(a)
    expect(lerpRect(a, b, 1)).toEqual(b)
    expect(transitionRect(-1, 0, a, b)).toBeUndefined()
    const mid = transitionRect(90, 0, a, b)
    expect(mid?.width).toBeGreaterThan(20)
    expect(mid?.width).toBeLessThan(60)
    expect(transitionRect(180, 0, a, b)).toBeUndefined()
  })

  it('the wordmark sweep finishes in under a second', () => {
    expect(wordmarkSweep(theme, 400, 0).done).toBe(false)
    expect(wordmarkSweep(theme, 999, 0).done).toBe(true)
  })

  it('typewriter shows a cursor while typing', () => {
    const l = typewriter(theme, 'hello world', 50, 0, { cps: 100 })
    expect(lineText(l)).toBe('hello▌')
  })
})
