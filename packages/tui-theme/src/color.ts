/**
 * Colour maths: OKLCH tokens (the desktop app's HeroUI v3 theme is written in OKLCH) to sRGB, and
 * sRGB down to the xterm 256-colour palette or the 16 ANSI colours.
 *
 * Plain functions over plain `{ r, g, b }` objects — no terminal I/O here.
 */

/** An sRGB colour, 0..255 per channel. */
export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** How many colours the terminal can show: none, the 16 ANSI colours, xterm 256, or 24-bit. */
export type ColorLevel = 0 | 1 | 2 | 3

/**
 * One of the 16 ANSI colours (0 black … 7 white, 8 bright black … 15 bright white), or -1 for the
 * terminal's own default colour (SGR 39 / 49).
 */
export type Ansi16 = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15

export const ANSI16_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright'
] as const

export type Ansi16Name = (typeof ANSI16_NAMES)[number]

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const to255 = (x: number): number => Math.round(clamp01(x) * 255)

function linearToSrgb(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}

function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}

/** OKLab components of an sRGB colour (L 0..1). */
export function rgbToOklab(c: Rgb): [number, number, number] {
  const r = srgbToLinear(c.r / 255)
  const g = srgbToLinear(c.g / 255)
  const b = srgbToLinear(c.b / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

/** sRGB from OKLab, gamut-clipped per channel. */
export function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: to255(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: to255(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: to255(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
  }
}

/** `oklch(L C h)` → sRGB. `L` is 0..1 (pass 0.12 for "12%"). */
export function oklch(L: number, C: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180
  return oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad))
}

/** Parses `#rgb` / `#rrggbb`. Throws on anything else — tokens are ours, a typo should be loud. */
export function hex(value: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) throw new Error(`Not a hex colour: ${value}`)
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function toHex(c: Rgb): string {
  const p = (x: number): string => Math.round(x).toString(16).padStart(2, '0')
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`
}

/** Mixes `a` toward `b` by `t` (0 = a, 1 = b) in OKLab, so mid-points stay perceptually even. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t)
  const A = rgbToOklab(a)
  const B = rgbToOklab(b)
  return oklabToRgb(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k)
}

/** `fg` drawn at `alpha` over `bg` — how the desktop's `color-mix(… x%, transparent)` looks on a surface. */
export function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const k = clamp01(alpha)
  return {
    r: Math.round(bg.r + (fg.r - bg.r) * k),
    g: Math.round(bg.g + (fg.g - bg.g) * k),
    b: Math.round(bg.b + (fg.b - bg.b) * k)
  }
}

/** Samples a multi-stop gradient at `t` (0..1), mixing in OKLab. */
export function gradientAt(stops: readonly Rgb[], t: number): Rgb {
  if (stops.length === 0) throw new Error('gradientAt needs at least one stop')
  if (stops.length === 1) return stops[0]
  const k = clamp01(t) * (stops.length - 1)
  const i = Math.min(Math.floor(k), stops.length - 2)
  return mix(stops[i], stops[i + 1], k - i)
}

/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  return (
    0.2126 * srgbToLinear(c.r / 255) +
    0.7152 * srgbToLinear(c.g / 255) +
    0.0722 * srgbToLinear(c.b / 255)
  )
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---- 256 colours ---------------------------------------------------------------------------

const CUBE = [0, 95, 135, 175, 215, 255]

/** The RGB value xterm uses for palette index 16..255 (0..15 are theme-defined, see `ansi16Rgb`). */
export function ansi256ToRgb(index: number): Rgb {
  if (index < 16) return ANSI16_REFERENCE[index]
  if (index >= 232) {
    const v = 8 + (index - 232) * 10
    return { r: v, g: v, b: v }
  }
  const i = index - 16
  return { r: CUBE[Math.floor(i / 36)], g: CUBE[Math.floor(i / 6) % 6], b: CUBE[i % 6] }
}

function nearestCubeLevel(v: number): number {
  let best = 0
  for (let i = 1; i < CUBE.length; i++) {
    if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i
  }
  return best
}

function oklabDistance(a: Rgb, b: Rgb): number {
  const A = rgbToOklab(a)
  const B = rgbToOklab(b)
  return (A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2
}

/**
 * Nearest xterm-256 index for an sRGB colour, chosen between the closest 6×6×6 cube entry and the
 * closest grey-ramp entry by OKLab distance. Indices 0..15 are never returned: their real colours
 * depend on the user's terminal theme.
 */
export function rgbToAnsi256(c: Rgb): number {
  // A few candidates around the per-channel nearest cube level, so a near-grey colour is not
  // forced into the cube's coarse steps.
  let best = -1
  let bestD = Infinity
  const ri = nearestCubeLevel(c.r)
  const gi = nearestCubeLevel(c.g)
  const bi = nearestCubeLevel(c.b)
  for (let dr = -1; dr <= 1; dr++) {
    for (let dg = -1; dg <= 1; dg++) {
      for (let db = -1; db <= 1; db++) {
        const r = ri + dr
        const g = gi + dg
        const b = bi + db
        if (r < 0 || g < 0 || b < 0 || r > 5 || g > 5 || b > 5) continue
        const idx = 16 + 36 * r + 6 * g + b
        const d = oklabDistance(c, ansi256ToRgb(idx))
        if (d < bestD) {
          bestD = d
          best = idx
        }
      }
    }
  }
  const avg = (c.r + c.g + c.b) / 3
  const gi2 = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)))
  for (const g of [gi2 - 1, gi2, gi2 + 1]) {
    if (g < 0 || g > 23) continue
    const d = oklabDistance(c, ansi256ToRgb(232 + g))
    if (d < bestD) {
      bestD = d
      best = 232 + g
    }
  }
  return best
}

// ---- 16 colours ----------------------------------------------------------------------------

/** xterm's default 16 colours — only a reference; real terminals re-theme these. */
export const ANSI16_REFERENCE: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 0, b: 0 },
  { r: 0, g: 205, b: 0 },
  { r: 205, g: 205, b: 0 },
  { r: 0, g: 0, b: 238 },
  { r: 205, g: 0, b: 205 },
  { r: 0, g: 205, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 127, g: 127, b: 127 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 92, g: 92, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 }
]

/**
 * Maps a colour to the ANSI colour that *means* the same thing, by hue and lightness — not by
 * RGB distance to xterm's reference values, because every terminal theme re-paints the 16 colours
 * and only their names (red, green, …) are stable. Near-greys become black / bright black / white /
 * bright white by lightness.
 */
export function rgbToAnsi16(c: Rgb): Exclude<Ansi16, -1> {
  const [L, a, b] = rgbToOklab(c)
  const chroma = Math.hypot(a, b)
  if (chroma < 0.04) {
    if (L < 0.3) return 0
    if (L < 0.62) return 8
    if (L < 0.9) return 7
    return 15
  }
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  // OKLCH hue buckets: red ~29, yellow ~110, green ~142, cyan ~195, blue ~264, magenta ~328.
  let base: 1 | 2 | 3 | 4 | 5 | 6
  if (hue < 55 || hue >= 350) base = 1
  else if (hue < 120) base = 3
  else if (hue < 170) base = 2
  else if (hue < 225) base = 6
  else if (hue < 300) base = 4
  else base = 5
  const bright = L > 0.72
  return (bright ? base + 8 : base) as Exclude<Ansi16, -1>
}
