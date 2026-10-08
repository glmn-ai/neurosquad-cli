/**
 * `createTheme()` — the one object a TUI needs: every semantic role resolved for the terminal's
 * colour depth (24-bit / 256 / 16 / none), in the shapes both Ink and OpenTUI take, plus SGR
 * helpers for writing raw ANSI.
 *
 * Framework-agnostic on purpose:
 * - Ink: `<Text color={theme.colors.accent.ink}>` (hex, `ansi256(n)` or a chalk name — whatever the
 *   level allows) or just the `hex` and let chalk downsample.
 * - OpenTUI: `fg={theme.colors.accent.hex}` / `RGBA.fromInts(...theme.colors.accent.rgb, 255)`.
 * - Raw: `theme.paint('text', { fg: 'accent', bold: true })`.
 */
import { release } from 'node:os'
import {
  ANSI16_NAMES,
  rgbToAnsi16,
  rgbToAnsi256,
  toHex,
  type Ansi16,
  type ColorLevel,
  type Rgb
} from './color.js'
import {
  detectAmbiguousWide,
  detectColorLevel,
  detectUnicode,
  type Env,
  type TerminalFacts
} from './capabilities.js'
import { ROLE_SOURCES, type Role, type Token } from './tokens.js'

/** A colour resolved for one terminal. */
export interface ThemeColor extends Rgb {
  /** `[r, g, b]`, e.g. for OpenTUI's `RGBA.fromInts(...rgb, 255)`. */
  readonly rgb: readonly [number, number, number]
  /** `#rrggbb` (the 24-bit value; frameworks that downsample themselves can take this). */
  readonly hex: string
  /** Nearest xterm-256 index (16..255). */
  readonly ansi256: number
  /** The ANSI colour with the same meaning (-1 = terminal default). */
  readonly ansi16: Ansi16
  /**
   * The value for Ink's `color` / `backgroundColor` at this terminal's level: hex at 24-bit,
   * `ansi256(n)` at 256, a chalk name at 16, `undefined` when the role uses the terminal default
   * or colour is off.
   */
  readonly ink: string | undefined
  /** SGR "set foreground" sequence for this level ('' when colour is off). */
  readonly fg: string
  /** SGR "set background" sequence for this level ('' when colour is off). */
  readonly bg: string
}

export type LogoMode = 'images' | 'glyphs' | 'none'

export interface ThemeOptions {
  /** Defaults to `process.env`. */
  env?: Env
  /** Defaults to `process.stdout.isTTY`. */
  isTTY?: boolean
  platform?: NodeJS.Platform
  osRelease?: string
  /** Force a colour level instead of detecting it. */
  colorLevel?: ColorLevel
  /** Force Unicode glyphs on/off instead of detecting. */
  unicode?: boolean
  /** Treat East Asian ambiguous characters as wide (then glyph sets fall back to ASCII). */
  ambiguousWide?: boolean
  /**
   * Harness logos: real images (when the terminal can draw them, else glyphs), brand-coloured
   * glyph badges, or neutral badges with no brand colours at all. Env: `NSQ_LOGOS`.
   */
  logos?: LogoMode
}

export interface StyleSpec {
  fg?: Role | Rgb
  bg?: Role | Rgb
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export interface Theme {
  readonly level: ColorLevel
  /** Non-ASCII glyphs are safe to draw. */
  readonly unicode: boolean
  readonly ambiguousWide: boolean
  readonly logos: LogoMode
  readonly colors: { readonly [R in Role]: ThemeColor }
  /** Resolves any colour (a role name, a token or raw RGB) for this terminal. */
  color(c: Role | Rgb): ThemeColor
  /** SGR open sequence for a style ('' when nothing applies). */
  open(style: StyleSpec): string
  /** `text` wrapped in the style and a reset. */
  paint(text: string, style: StyleSpec): string
}

export const RESET = '\x1b[0m'

function sgrFor(level: ColorLevel, c: Rgb, ansi16: Ansi16, background: boolean): string {
  if (level === 0) return ''
  if (level === 3) return `\x1b[${background ? 48 : 38};2;${c.r};${c.g};${c.b}m`
  if (level === 2) return `\x1b[${background ? 48 : 38};5;${rgbToAnsi256(c)}m`
  if (ansi16 === -1) return `\x1b[${background ? 49 : 39}m`
  const base = ansi16 < 8 ? (background ? 40 : 30) + ansi16 : (background ? 100 : 90) + ansi16 - 8
  return `\x1b[${base}m`
}

/** Resolves one colour for a level. `ansi16` (from a token) overrides the hue-based guess. */
export function resolveColor(c: Rgb & { ansi16?: Ansi16 }, level: ColorLevel): ThemeColor {
  const rgb = { r: c.r, g: c.g, b: c.b }
  const ansi256 = rgbToAnsi256(rgb)
  const ansi16: Ansi16 = c.ansi16 ?? rgbToAnsi16(rgb)
  const hexValue = toHex(rgb)
  const ink =
    level === 3
      ? hexValue
      : level === 2
        ? `ansi256(${ansi256})`
        : level === 1 && ansi16 !== -1
          ? ANSI16_NAMES[ansi16]
          : undefined
  return {
    ...rgb,
    rgb: [rgb.r, rgb.g, rgb.b],
    hex: hexValue,
    ansi256,
    ansi16,
    ink,
    fg: sgrFor(level, rgb, ansi16, false),
    bg: sgrFor(level, rgb, ansi16, true)
  }
}

function parseLogoMode(v: string | undefined): LogoMode | undefined {
  const s = v?.trim().toLowerCase()
  return s === 'images' || s === 'glyphs' || s === 'none' ? s : undefined
}

/** Builds the theme for the current terminal (or the facts/overrides you pass). */
export function createTheme(options: ThemeOptions = {}): Theme {
  const env = options.env ?? process.env
  const facts: TerminalFacts = {
    env,
    isTTY: options.isTTY ?? Boolean(process.stdout?.isTTY),
    platform: options.platform ?? process.platform,
    osRelease: options.osRelease
  }
  if (facts.osRelease === undefined && options.platform === undefined) facts.osRelease = release()
  const level = options.colorLevel ?? detectColorLevel(facts)
  const ambiguousWide = options.ambiguousWide ?? detectAmbiguousWide(env)
  const unicode = (options.unicode ?? detectUnicode(facts)) && !ambiguousWide
  const logos = options.logos ?? parseLogoMode(env.NSQ_LOGOS) ?? 'images'

  const colors = Object.fromEntries(
    (Object.entries(ROLE_SOURCES) as Array<[Role, Token]>).map(([role, token]) => [
      role,
      resolveColor(token, level)
    ])
  ) as { [R in Role]: ThemeColor }

  const color = (c: Role | Rgb): ThemeColor =>
    typeof c === 'string' ? colors[c] : resolveColor(c, level)

  const open = (s: StyleSpec): string => {
    let out = ''
    if (s.fg !== undefined) out += color(s.fg).fg
    if (s.bg !== undefined) out += color(s.bg).bg
    if (s.bold) out += '\x1b[1m'
    if (s.dim) out += '\x1b[2m'
    if (s.italic) out += '\x1b[3m'
    if (s.underline) out += '\x1b[4m'
    if (s.inverse) out += '\x1b[7m'
    return out
  }

  // NO_COLOR asks for no colour; we still allow bold/inverse (they are not colour) unless the
  // output is not a terminal at all.
  const plain = level === 0 && !facts.isTTY

  return {
    level,
    unicode,
    ambiguousWide,
    logos,
    colors,
    color,
    open: plain ? () => '' : open,
    paint(text, style) {
      if (plain) return text
      const o = open(style)
      return o ? o + text + RESET : text
    }
  }
}
