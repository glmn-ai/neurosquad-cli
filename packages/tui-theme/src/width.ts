/**
 * Terminal cell width of text. Grapheme-aware (Intl.Segmenter), East Asian Wide/Fullwidth = 2,
 * emoji presentation sequences = 2, combining marks / ZWJ / variation selectors = 0, ANSI escapes =
 * 0. Ambiguous-width characters (●, ─, █, …) count as 1 unless `ambiguousWide` is set.
 */
import { AMBIGUOUS_RANGES, WIDE_RANGES } from './eastAsianWidth.generated.js'

function inRanges(ranges: readonly number[], cp: number): boolean {
  let lo = 0
  let hi = ranges.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const start = ranges[mid * 2]
    const end = ranges[mid * 2 + 1]
    if (cp < start) hi = mid - 1
    else if (cp > end) lo = mid + 1
    else return true
  }
  return false
}

export function isWideCodePoint(cp: number): boolean {
  return inRanges(WIDE_RANGES, cp)
}

export function isAmbiguousCodePoint(cp: number): boolean {
  return inRanges(AMBIGUOUS_RANGES, cp)
}

// Built at runtime: the `v` flag is ES2024 syntax and the package targets ES2022.
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v')
// eslint-disable-next-line no-misleading-character-class -- explicit escapes, intended ranges
const ZERO_WIDTH = new RegExp('^[\\p{Mn}\\p{Me}\\p{Cf}\\u200b-\\u200d\\ufe00-\\ufe0f]+$', 'u')
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'u')
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g

/** Removes CSI / OSC / DCS / APC escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

export interface WidthOptions {
  /** Count East Asian Ambiguous characters as two cells (CJK terminals with that setting). */
  ambiguousWide?: boolean
}

/** Width of one grapheme cluster. */
export function graphemeWidth(g: string, opts: WidthOptions = {}): number {
  if (g === '') return 0
  if (ZERO_WIDTH.test(g)) return 0
  const cp = g.codePointAt(0) as number
  if (g.length === 1 && CONTROL.test(g)) return 0
  if (RGI_EMOJI.test(g)) return 2
  // A text-default symbol followed by VS16 asks for emoji presentation; terminals draw it wide.
  if (g.includes('\ufe0f') && /\p{Extended_Pictographic}/u.test(g)) return 2
  // Regional indicator pairs (flags) are RGI emoji; a lone one is drawn wide by most terminals.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2
  if (isWideCodePoint(cp)) return 2
  if (opts.ambiguousWide && isAmbiguousCodePoint(cp)) return 2
  return 1
}

/** Cell width of a string (escape sequences ignored). */
export function stringWidth(text: string, opts: WidthOptions = {}): number {
  const plain = text.includes('\x1b') ? stripAnsi(text) : text
  let w = 0
  // ASCII fast path.
  if (/^[\x20-\x7e]*$/.test(plain)) return plain.length
  for (const { segment } of segmenter.segment(plain)) w += graphemeWidth(segment, opts)
  return w
}

/** Splits plain text into graphemes with their widths. */
export function graphemes(text: string, opts: WidthOptions = {}): Array<{ g: string; w: number }> {
  const out: Array<{ g: string; w: number }> = []
  for (const { segment } of segmenter.segment(text))
    out.push({ g: segment, w: graphemeWidth(segment, opts) })
  return out
}

/**
 * Cuts plain text to at most `width` cells, appending `ellipsis` when something was cut. Never
 * splits a grapheme or leaves half of a wide character (pads with a space instead).
 */
export function truncate(
  text: string,
  width: number,
  ellipsis = '…',
  opts: WidthOptions = {}
): string {
  if (width <= 0) return ''
  if (stringWidth(text, opts) <= width) return text
  const ew = stringWidth(ellipsis, opts)
  const room = Math.max(0, width - ew)
  let out = ''
  let used = 0
  for (const { g, w } of graphemes(text, opts)) {
    if (used + w > room) break
    out += g
    used += w
  }
  if (ew > width) return out.padEnd(width, ' ')
  return out + ellipsis + ' '.repeat(Math.max(0, room - used))
}

/** Pads (or truncates) plain text to exactly `width` cells. */
export function fit(
  text: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left',
  opts: WidthOptions = {}
): string {
  const t = truncate(text, width, '…', opts)
  const gap = width - stringWidth(t, opts)
  if (gap <= 0) return t
  if (align === 'right') return ' '.repeat(gap) + t
  if (align === 'center') return ' '.repeat(gap >> 1) + t + ' '.repeat(gap - (gap >> 1))
  return t + ' '.repeat(gap)
}
