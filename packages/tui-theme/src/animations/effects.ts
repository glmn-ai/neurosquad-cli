/**
 * Effects as pure frame generators: `effect(theme, now, …) → Seg | Line | Line[]`. No timers, no
 * I/O — drive them from the shared `Ticker` and render the result your own way (Ink, OpenTUI, raw
 * ANSI with `diffFrames`). Pass `now = undefined` (motion off) to get the resting frame; every
 * effect has one, and it is what a static screenshot of the TUI looks like.
 *
 * Colours are quantised (gradient LUTs, stepped pulses), so consecutive frames are often equal and
 * a cell-diffing writer has little to repaint.
 *
 * Effects only decorate our chrome (borders, labels, badges). Never run them over an agent's own
 * terminal content.
 */
import { gradientAt, mix, type Rgb } from '../color.js'
import { glyphSet } from '../glyphs.js'
import { frame, type FrameOptions } from '../borders.js'
import { seg, type Line, type Seg } from '../text.js'
import type { Theme } from '../theme.js'
import { BRAND_GRADIENT, ROLE_SOURCES } from '../tokens.js'
import { wordmark } from '../wordmark.js'
import { graphemes } from '../width.js'

// ---- shared helpers ------------------------------------------------------------------------

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3)
export const easeInOutCubic = (t: number): number => {
  const x = clamp01(t)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

const LUT_STEPS = 24
const BRAND_LUT: readonly Rgb[] = Array.from({ length: LUT_STEPS }, (_, i) =>
  gradientAt(BRAND_GRADIENT, i / (LUT_STEPS - 1))
)
const WHITE: Rgb = { r: 255, g: 255, b: 255 }

/** The brand gradient (lime → emerald) at `t` ∈ [0, 1], quantised to 24 steps. */
export function brandAt(t: number): Rgb {
  return BRAND_LUT[Math.round(clamp01(t) * (LUT_STEPS - 1))]
}

/** Ping-pong 0 → 1 → 0 over `periodMs`. */
function pingPong(now: number, periodMs: number): number {
  const p = (now % periodMs) / periodMs
  return p < 0.5 ? p * 2 : 2 - p * 2
}

/** Deterministic hash → [0, 1). Frames must be reproducible (tests, recordings). */
function hash01(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// ---- working: gradient spinner ----------------------------------------------------------------

/**
 * One-cell spinner for "working": braille frames at ~12 fps whose colour breathes along the brand
 * gradient. Static frame: the status glyph in the accent colour.
 */
export function spinner(
  theme: Theme,
  now: number | undefined,
  opts: { fps?: number; bg?: Seg['bg'] } = {}
): Seg {
  const g = glyphSet(theme.unicode)
  if (now === undefined) return seg(g.status.working, { fg: 'accentText', bg: opts.bg })
  const frames = g.spinner
  const i = Math.floor(now / (1000 / (opts.fps ?? 12))) % frames.length
  return seg(frames[i], { fg: brandAt(pingPong(now, 1400)), bg: opts.bg, bold: true })
}

// ---- thinking: scramble-decode, then shimmer ------------------------------------------------------

export interface ThinkingOptions {
  /** When the label appeared (decode starts here). */
  startedAt?: number
  /** Decode time per character (ms); total decode is capped at 700 ms. */
  msPerChar?: number
  /** Shimmer sweep period (ms). */
  shimmerMs?: number
  /** Resting colour of the decoded text. */
  base?: Seg['fg']
  bg?: Seg['bg']
}

/**
 * A label such as `Thinking…` that first decodes out of scrambled glyphs, left to right, then has
 * a soft lime highlight gliding across it. Static frame: the plain label in muted text.
 */
export function thinking(
  theme: Theme,
  text: string,
  now: number | undefined,
  opts: ThinkingOptions = {}
): Line {
  const base = opts.base ?? 'mutedText'
  const bg = opts.bg
  if (now === undefined) return [seg(text, { fg: base, bg })]
  const chars = graphemes(text)
  const started = opts.startedAt ?? 0
  const elapsed = Math.max(0, now - started)
  const per = Math.min(opts.msPerChar ?? 45, 700 / Math.max(1, chars.length))
  const revealed = Math.floor(elapsed / per)
  const frameNo = Math.floor(now / 70)
  const pool = [...glyphSet(theme.unicode).scramble]
  const baseRgb: Rgb = typeof base === 'string' ? ROLE_SOURCES[base] : base
  const decoding = revealed < chars.length
  const period = opts.shimmerMs ?? 1800
  // Band centre in character units; travels past both ends so the sweep fades in and out.
  const centre = ((elapsed % period) / period) * (chars.length + 8) - 4
  return chars.map(({ g, w }, i) => {
    if (i >= revealed && g !== ' ') {
      const pick = pool[Math.floor(hash01(i, frameNo) * pool.length)]
      const glyph = w === 2 ? pick + pick : pick
      return seg(glyph, { fg: brandAt(hash01(i + 7, frameNo)), bg })
    }
    if (decoding) {
      // Freshly decoded characters flash bright, then settle.
      const age = elapsed - i * per
      const k = clamp01(age / 220)
      return seg(g, { fg: mix(BRAND_GRADIENT[0], baseRgb, k), bg })
    }
    const d = Math.abs(i - centre)
    const glow = Math.exp(-(d * d) / 4.5)
    const k = Math.round(glow * 6) / 6 // quantised: fewer repaints
    return seg(g, { fg: mix(baseRgb, mix(BRAND_GRADIENT[0], WHITE, 0.25), k), bg, bold: k > 0.6 })
  })
}

// ---- needs you: pulse ------------------------------------------------------------------------

export interface PulseFrame {
  /** Border / badge colour this frame. */
  color: Rgb
  /** 0 (trough) … 1 (peak). */
  level: number
  /** Still in the opening burst (the first ~3 s). */
  burst: boolean
}

/**
 * The needs-you pulse — the hero moment. It opens with three quick, strong beats so the eye finds
 * the tile, then settles into a slow, shallow breath that stays visible without nagging. Stepped to
 * 8 levels. Static frame: the plain needs-you colour.
 */
export function attentionPulse(now: number | undefined, since = 0): PulseFrame {
  const peak = ROLE_SOURCES.needsYouGlow
  const rest = ROLE_SOURCES.needsYou
  const trough = ROLE_SOURCES.needsYouDim
  if (now === undefined) return { color: rest, level: 0.5, burst: false }
  const t = Math.max(0, now - since)
  const burstMs = 3 * 900
  let level: number
  let color: Rgb
  if (t < burstMs) {
    level = 0.5 - 0.5 * Math.cos(((t % 900) / 900) * 2 * Math.PI)
    level = Math.round(level * 8) / 8
    color = level >= 0.5 ? mix(rest, peak, (level - 0.5) * 2) : mix(trough, rest, level * 2)
    return { color, level, burst: true }
  }
  level = 0.5 - 0.5 * Math.cos((((t - burstMs) % 2600) / 2600) * 2 * Math.PI)
  level = Math.round(level * 8) / 8
  color = mix(rest, peak, level * 0.45)
  return { color, level, burst: false }
}

/** The sidebar badge for a needs-you row: ` NEEDS YOU ` on the pulsing colour. */
export function attentionBadge(
  theme: Theme,
  now: number | undefined,
  since = 0,
  text = 'NEEDS YOU'
): Seg {
  const p = attentionPulse(now, since)
  if (theme.level <= 1) return seg(` ${text} `, { fg: 'warningFg', bg: 'needsYou', bold: true })
  return seg(` ${text} `, { fg: 'warningFg', bg: p.color, bold: true })
}

/** The status dot for a needs-you row: `●` in the pulsing colour. */
export function attentionDot(
  theme: Theme,
  now: number | undefined,
  since = 0,
  bg?: Seg['bg']
): Seg {
  return seg(glyphSet(theme.unicode).status['needs-input'], {
    fg: attentionPulse(now, since).color,
    bg,
    bold: true
  })
}

// ---- new tile: fade-in + typewriter -------------------------------------------------------------

/** 0 → 1 (eased) over `durationMs` after `startedAt`; 1 when static. */
export function fadeIn(now: number | undefined, startedAt: number, durationMs = 320): number {
  if (now === undefined) return 1
  return easeOutCubic((now - startedAt) / durationMs)
}

/** A colour faded in from `from` (usually the tile background) to `to`. */
export function fadeColor(from: Rgb, to: Rgb, k: number): Rgb {
  return k >= 1 ? to : mix(from, to, k)
}

/**
 * The first `n` graphemes of `text`, typing at `cps` characters per second, with a block cursor
 * while typing. Static: the whole text.
 */
export function typewriter(
  theme: Theme,
  text: string,
  now: number | undefined,
  startedAt: number,
  opts: { cps?: number; fg?: Seg['fg']; bg?: Seg['bg'] } = {}
): Line {
  const fg = opts.fg ?? 'text'
  if (now === undefined) return [seg(text, { fg, bg: opts.bg })]
  const chars = graphemes(text)
  const n = Math.max(0, Math.floor(((now - startedAt) / 1000) * (opts.cps ?? 70)))
  if (n >= chars.length) return [seg(text, { fg, bg: opts.bg })]
  const shown = chars
    .slice(0, n)
    .map((c) => c.g)
    .join('')
  const cursor = theme.unicode ? '▌' : '_'
  return [seg(shown, { fg, bg: opts.bg }), seg(cursor, { fg: BRAND_GRADIENT[0], bg: opts.bg })]
}

/**
 * A tile frame fading in: border and title rise from the tile background over ~320 ms. Body
 * content is the caller's (never animate the agent's terminal itself).
 */
export function tileEnter(
  theme: Theme,
  now: number | undefined,
  startedAt: number,
  o: FrameOptions
): Line[] {
  const k = fadeIn(now, startedAt)
  if (k >= 1) return frame(theme, o)
  const bg = ROLE_SOURCES[o.bg ?? 'tileBg']
  const border = fadeColor(bg, ROLE_SOURCES.border, k)
  const lines = frame(theme, {
    ...o,
    borderColor: o.state === 'focused' ? fadeColor(bg, ROLE_SOURCES.focusBorder, k) : border
  })
  const fade = (c: Seg['fg']): Seg['fg'] =>
    c === undefined ? c : fadeColor(bg, typeof c === 'string' ? ROLE_SOURCES[c] : c, k)
  return lines.map((l) => l.map((s) => ({ ...s, fg: fade(s.fg), bg: fade(s.bg) })))
}

// ---- splash: wordmark sweep -----------------------------------------------------------------------

/**
 * The startup wordmark: a light band sweeps left to right across the `>S` mark and the word in
 * under a second, the word fading up from the background behind it. Returns the frame and whether
 * the sweep is over (then show the static `wordmark()`).
 */
export function wordmarkSweep(
  theme: Theme,
  now: number | undefined,
  startedAt: number,
  opts: { durationMs?: number; bg?: Rgb } = {}
): { lines: Line[]; done: boolean } {
  const duration = opts.durationMs ?? 850
  const p = now === undefined ? 1 : (now - startedAt) / duration
  if (p >= 1) return { lines: wordmark(theme, { bg: opts.bg }), done: true }
  const bg = opts.bg ?? ROLE_SOURCES.appBg
  const total = 60 // ≈ lockup width in cells; the band runs slightly past both ends
  const centre = easeInOutCubic(p) * (total + 16) - 8
  const lift = (x: number): number => {
    const d = (x - centre) / 4
    return Math.exp(-d * d)
  }
  return {
    lines: wordmark(theme, {
      bg: opts.bg,
      markColor: (x, w) => mix(brandAt(x / Math.max(1, w - 1)), WHITE, lift(x) * 0.7),
      wordColor: (x) => {
        const seen = clamp01((centre - x) / 6 + 0.5)
        return mix(mix(bg, ROLE_SOURCES.text, seen), WHITE, lift(x) * 0.5)
      }
    }),
    done: false
  }
}

// ---- progress bar --------------------------------------------------------------------------------

export interface ProgressOptions {
  width: number
  /** 0..1, or undefined for an indeterminate bar. */
  ratio: number | undefined
  bg?: Seg['bg']
}

/**
 * A thin gradient progress bar (`━━━━╸────`) with a highlight gliding along the filled part.
 * Indeterminate (`ratio` undefined): a short gradient segment bouncing along the track. ASCII
 * terminals get `[=====>    ]`.
 */
export function progressBar(theme: Theme, now: number | undefined, o: ProgressOptions): Line {
  const width = Math.max(3, o.width)
  const bg = o.bg
  if (!theme.unicode) {
    const inner = width - 2
    if (o.ratio === undefined) {
      const pos = now === undefined ? 0 : Math.floor(pingPong(now, 1600) * (inner - 3))
      return [
        seg('[' + ' '.repeat(pos) + '===' + ' '.repeat(Math.max(0, inner - pos - 3)) + ']', {
          fg: 'accentText',
          bg
        })
      ]
    }
    const filled = Math.round(clamp01(o.ratio) * inner)
    const head = filled > 0 && filled < inner ? '>' : ''
    const body = '='.repeat(Math.max(0, filled - head.length)) + head
    return [
      seg('[', { fg: 'mutedText', bg }),
      seg(body, { fg: 'success', bg }),
      seg(' '.repeat(inner - body.length) + ']', { fg: 'mutedText', bg })
    ]
  }
  const cells: Seg[] = []
  if (o.ratio === undefined) {
    const span = Math.max(3, Math.floor(width / 5))
    const start = now === undefined ? 0 : Math.round(pingPong(now, 1800) * (width - span))
    for (let x = 0; x < width; x++) {
      const on = x >= start && x < start + span
      cells.push(
        seg('━', { fg: on ? brandAt((x - start) / Math.max(1, span - 1)) : 'separator', bg })
      )
    }
    return cells
  }
  const exact = clamp01(o.ratio) * width
  const full = Math.floor(exact)
  const half = exact - full >= 0.5
  const shine = now === undefined ? -100 : ((now % 1600) / 1600) * (full + 10) - 5
  for (let x = 0; x < width; x++) {
    if (x < full) {
      const base = brandAt(x / Math.max(1, width - 1))
      const d = (x - shine) / 2.2
      const lift = Math.round(Math.exp(-d * d) * 4) / 4
      cells.push(seg('━', { fg: mix(base, WHITE, lift * 0.55), bg }))
    } else if (x === full && half)
      cells.push(seg('╸', { fg: brandAt(x / Math.max(1, width - 1)), bg }))
    else cells.push(seg('─', { fg: 'border', bg }))
  }
  return cells
}

// ---- finished: sparkle ---------------------------------------------------------------------------

/**
 * A short twinkle on the status glyph when an agent finishes: `· ✧ ✦ ✧ ✔`, lime to emerald, about
 * 700 ms, then the plain success check. Static: the check.
 */
export function sparkle(
  theme: Theme,
  now: number | undefined,
  finishedAt: number,
  bg?: Seg['bg']
): { seg: Seg; done: boolean } {
  const g = glyphSet(theme.unicode)
  const rest = seg(g.status.finished, { fg: 'success', bg })
  if (now === undefined) return { seg: rest, done: true }
  const t = now - finishedAt
  const frames = g.sparkle
  const per = 140
  if (t < 0 || t >= per * frames.length) return { seg: rest, done: t >= 0 }
  const i = Math.floor(t / per)
  return {
    seg: seg(frames[i], {
      fg: i === frames.length - 1 ? ROLE_SOURCES.success : brandAt(i / (frames.length - 1)),
      bg,
      bold: true
    }),
    done: false
  }
}

// ---- expand / collapse -----------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A rectangle between `from` and `to` at progress `k` (eased, rounded to cells). */
export function lerpRect(from: Rect, to: Rect, k: number): Rect {
  const e = easeInOutCubic(k)
  const l = (a: number, b: number): number => Math.round(a + (b - a) * e)
  return {
    x: l(from.x, to.x),
    y: l(from.y, to.y),
    width: l(from.width, to.width),
    height: l(from.height, to.height)
  }
}

/**
 * Where the growing (or shrinking) box is for an expand-to-fullscreen / back-to-grid transition,
 * or undefined when the transition is over (draw the final layout). ~180 ms: a handful of frames
 * at 30 fps. Draw it with `frame(theme, { …rect, state: 'focused' })` over the old layout; the
 * agent's terminal is re-laid out once, at the end, not per frame.
 */
export function transitionRect(
  now: number | undefined,
  startedAt: number,
  from: Rect,
  to: Rect,
  durationMs = 180
): Rect | undefined {
  if (now === undefined || now < startedAt) return undefined
  const k = (now - startedAt) / durationMs
  if (k >= 1) return undefined
  return lerpRect(from, to, k)
}
