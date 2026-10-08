// Colours as one number per cell, and how to bring them down to what the host
// terminal can show.
//
// A cell colour is packed into a uint32 so a grid can keep it in a typed array:
//   0                      the terminal's default colour,
//   PALETTE | index        one of the 256 palette entries (0–15 are the 16 "ANSI" colours),
//   RGB | 0xRRGGBB         a truecolor value.

export const DEFAULT_COLOR = 0
export const PALETTE = 0x1000000
export const RGB = 0x2000000
const KIND_MASK = 0x3000000
const VALUE_MASK = 0xffffff

/** What the host terminal can display. `'none'` keeps attributes (bold, inverse…) but drops colour. */
export type ColorDepth = 'truecolor' | 256 | 16 | 'none'

export type ColorLayer = 'fg' | 'bg'

/**
 * Maps a packed colour to one the host can show at `depth`. Must return
 * `DEFAULT_COLOR`, a `PALETTE` colour (index < 16 at depth 16) or, at
 * truecolor, anything. The theme package can supply its own (closest match in
 * the user's palette rather than xterm's defaults); `defaultDowngrade` is the
 * built-in one.
 */
export type ColorDowngrade = (color: number, depth: ColorDepth, layer: ColorLayer) => number

export function paletteColor(index: number): number {
  return PALETTE | (index & 0xff)
}

export function rgbColor(r: number, g: number, b: number): number {
  return RGB | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

export function isDefaultColor(color: number): boolean {
  return (color & KIND_MASK) === 0
}

export function isPaletteColor(color: number): boolean {
  return (color & KIND_MASK) === PALETTE
}

export function isRgbColor(color: number): boolean {
  return (color & KIND_MASK) === RGB
}

export function colorValue(color: number): number {
  return color & VALUE_MASK
}

/** xterm's default 16-colour palette (the same values xterm.js uses). */
export const ANSI_16: readonly number[] = [
  0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666,
  0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff
]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

/** The RGB value of palette entry `index` (xterm defaults for 0–15, the 6×6×6 cube, the grey ramp). */
export function paletteToRgb(index: number): number {
  if (index < 16) return ANSI_16[index]
  if (index < 232) {
    const i = index - 16
    const r = CUBE_LEVELS[Math.floor(i / 36)]
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6]
    const b = CUBE_LEVELS[i % 6]
    return (r << 16) | (g << 8) | b
  }
  const level = 8 + (index - 232) * 10
  return (level << 16) | (level << 8) | level
}

function distance(a: number, b: number): number {
  // "Redmean" — a cheap perceptual weighting that beats plain Euclidean RGB.
  const ar = (a >> 16) & 0xff
  const ag = (a >> 8) & 0xff
  const ab = a & 0xff
  const br = (b >> 16) & 0xff
  const bg = (b >> 8) & 0xff
  const bb = b & 0xff
  const rmean = (ar + br) / 2
  const dr = ar - br
  const dg = ag - bg
  const db = ab - bb
  return (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db
}

function nearestCubeLevel(v: number): number {
  if (v < 48) return 0
  if (v < 115) return 1
  return Math.min(5, Math.floor((v - 35) / 40))
}

/** Closest entry of the 256-colour palette (16–255 only: 0–15 are themeable and so unreliable). */
export function rgbTo256(rgb: number): number {
  const r = (rgb >> 16) & 0xff
  const g = (rgb >> 8) & 0xff
  const b = rgb & 0xff
  const cube = 16 + 36 * nearestCubeLevel(r) + 6 * nearestCubeLevel(g) + nearestCubeLevel(b)
  const avg = Math.round((r + g + b) / 3)
  const greyIndex = avg > 238 ? 23 : Math.max(0, Math.round((avg - 8) / 10))
  const grey = 232 + greyIndex
  return distance(rgb, paletteToRgb(cube)) <= distance(rgb, paletteToRgb(grey)) ? cube : grey
}

/** Closest of the 16 ANSI colours. */
export function rgbTo16(rgb: number): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < 16; i++) {
    const d = distance(rgb, ANSI_16[i])
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  }
  return best
}

const cache16 = new Map<number, number>()
const cache256 = new Map<number, number>()
const CACHE_LIMIT = 4096

function cached(cache: Map<number, number>, key: number, compute: (k: number) => number): number {
  let value = cache.get(key)
  if (value === undefined) {
    value = compute(key)
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, value)
  }
  return value
}

export const defaultDowngrade: ColorDowngrade = (color, depth) => {
  if (depth === 'truecolor' || isDefaultColor(color)) return color
  if (depth === 'none') return DEFAULT_COLOR
  if (isPaletteColor(color)) {
    const index = colorValue(color)
    if (depth === 256 || index < 16) return color
    return paletteColor(cached(cache16, paletteToRgb(index), rgbTo16))
  }
  const rgb = colorValue(color)
  if (depth === 256) return paletteColor(cached(cache256, rgb, rgbTo256))
  return paletteColor(cached(cache16, rgb, rgbTo16))
}

/** SGR parameters selecting `color` (already downgraded) for `layer`. */
export function colorSgr(color: number, layer: ColorLayer): string {
  const kind = color & KIND_MASK
  if (kind === 0) return layer === 'fg' ? '39' : '49'
  const value = color & VALUE_MASK
  if (kind === PALETTE) {
    if (value < 8) return String((layer === 'fg' ? 30 : 40) + value)
    if (value < 16) return String((layer === 'fg' ? 90 : 100) + value - 8)
    return `${layer === 'fg' ? 38 : 48};5;${value}`
  }
  return `${layer === 'fg' ? 38 : 48};2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`
}

/** `#rrggbb` (or `#rgb`) → 0xRRGGBB; undefined when it does not parse. */
export function parseHexColor(text: string): number | undefined {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())
  if (!match) return undefined
  let hex = match[1]
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c)
  return parseInt(hex, 16)
}

/** The X11 `rgb:RRRR/GGGG/BBBB` form terminals answer colour queries with. */
export function x11Rgb(rgb: number): string {
  const part = (v: number): string => {
    const hex = v.toString(16).padStart(2, '0')
    return hex + hex
  }
  return `rgb:${part((rgb >> 16) & 0xff)}/${part((rgb >> 8) & 0xff)}/${part(rgb & 0xff)}`
}
