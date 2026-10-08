/**
 * A tiny styled-text model every renderer can consume: a `Line` is a list of `Seg`ments, each a run
 * of text with one style. Ink maps a Seg to `<Text color=… backgroundColor=… bold>`, OpenTUI to a
 * styled chunk, and `renderLine` turns it into ANSI for raw writers (and the preview).
 */
import type { Rgb } from './color.js'
import { RESET, type StyleSpec, type Theme } from './theme.js'
import { graphemes, stringWidth, type WidthOptions } from './width.js'

export interface Seg extends StyleSpec {
  text: string
}

export type Line = Seg[]

export const seg = (text: string, style: StyleSpec = {}): Seg => ({ text, ...style })

export function lineWidth(line: Line, opts: WidthOptions = {}): number {
  let w = 0
  for (const s of line) w += stringWidth(s.text, opts)
  return w
}

/** Plain text of a line (no styles). */
export function lineText(line: Line): string {
  return line.map((s) => s.text).join('')
}

/** Pads a line with spaces (in `bg`, if given) or cuts it to exactly `width` cells. */
export function fitLine(
  line: Line,
  width: number,
  bg?: StyleSpec['bg'],
  opts: WidthOptions = {}
): Line {
  const out: Line = []
  let used = 0
  for (const s of line) {
    if (used >= width) break
    const w = stringWidth(s.text, opts)
    if (used + w <= width) {
      out.push(s)
      used += w
      continue
    }
    let text = ''
    for (const { g, w: gw } of graphemes(s.text, opts)) {
      if (used + gw > width) break
      text += g
      used += gw
    }
    if (text) out.push({ ...s, text })
    break
  }
  if (used < width) out.push({ text: ' '.repeat(width - used), bg })
  return out
}

/** Joins lines side by side (each already fitted to its column width). */
export function hjoin(...columns: Line[][]): Line[] {
  const rows = Math.max(...columns.map((c) => c.length))
  const out: Line[] = []
  for (let i = 0; i < rows; i++) out.push(columns.flatMap((c) => c[i] ?? []))
  return out
}

function sameStyle(a: StyleSpec, b: StyleSpec): boolean {
  const same = (x: StyleSpec['fg'], y: StyleSpec['fg']): boolean =>
    x === y ||
    (typeof x === 'object' && typeof y === 'object' && x.r === y.r && x.g === y.g && x.b === y.b)
  return (
    same(a.fg, b.fg) &&
    same(a.bg, b.bg) &&
    !a.bold === !b.bold &&
    !a.dim === !b.dim &&
    !a.italic === !b.italic &&
    !a.underline === !b.underline &&
    !a.inverse === !b.inverse
  )
}

/** Merges neighbouring segments with the same style (fewer escape sequences, fewer Ink nodes). */
export function compact(line: Line): Line {
  const out: Line = []
  for (const s of line) {
    const last = out[out.length - 1]
    if (last && sameStyle(last, s)) out[out.length - 1] = { ...last, text: last.text + s.text }
    else out.push(s)
  }
  return out
}

/** One line as ANSI text (ends with a reset when any style was used). */
export function renderLine(theme: Theme, line: Line): string {
  let out = ''
  let styled = false
  for (const s of compact(line)) {
    const o = theme.open(s)
    if (o) {
      out += (styled ? RESET : '') + o + s.text
      styled = true
    } else {
      out += (styled ? RESET : '') + s.text
      styled = false
    }
  }
  return styled ? out + RESET : out
}

/** Text with one colour per grapheme along a gradient (`colorAt(i, n)` → colour). */
export function gradientText(
  text: string,
  colorAt: (index: number, count: number) => Rgb,
  style: Omit<StyleSpec, 'fg'> = {}
): Line {
  const gs = graphemes(text)
  return gs.map(({ g }, i) => ({ text: g, fg: colorAt(i, gs.length), ...style }))
}

/** A changed run of cells between two frames, for writers that only repaint what moved. */
export interface DirtySpan {
  row: number
  /** First changed column (cells). */
  col: number
  /** The new content from `col` to the end of the changed range. */
  segs: Line
}

function cells(line: Line, opts: WidthOptions): Array<{ g: string; s: Seg; w: number }> {
  const out: Array<{ g: string; s: Seg; w: number }> = []
  for (const s of line) for (const { g, w } of graphemes(s.text, opts)) out.push({ g, s, w })
  return out
}

/**
 * Compares two frames cell by cell and returns, per changed row, the smallest span that covers
 * every change — so an effect repaints a spinner cell, not a whole tile.
 */
export function diffFrames(
  prev: Line[] | undefined,
  next: Line[],
  opts: WidthOptions = {}
): DirtySpan[] {
  const spans: DirtySpan[] = []
  for (let row = 0; row < next.length; row++) {
    const a = prev?.[row]
    const b = next[row]
    if (a === b) continue
    const ca = a ? cells(a, opts) : []
    const cb = cells(b, opts)
    let first = -1
    let last = -1
    const n = Math.max(ca.length, cb.length)
    for (let i = 0; i < n; i++) {
      const x = ca[i]
      const y = cb[i]
      const equal = x && y && x.g === y.g && sameStyle(x.s, y.s)
      if (!equal) {
        if (first < 0) first = i
        last = i
      }
    }
    if (first < 0) continue
    let col = 0
    for (let i = 0; i < first; i++) col += cb[i]?.w ?? ca[i]?.w ?? 1
    const changed = cb.slice(first, last + 1).map(({ g, s }) => ({ ...s, text: g }))
    // If the new row is shorter, blank out what is left of the old one.
    const oldTail = ca.slice(Math.max(first, cb.length), last + 1).reduce((w, c) => w + c.w, 0)
    if (oldTail > 0) changed.push({ text: ' '.repeat(oldTail) })
    spans.push({ row, col, segs: compact(changed) })
  }
  return spans
}

/** Cells `[start, end)` of a line (a wide character cut in half becomes a space). */
export function sliceLine(line: Line, start: number, end: number, opts: WidthOptions = {}): Line {
  const out: Line = []
  let x = 0
  for (const s of line) {
    let text = ''
    for (const { g, w } of graphemes(s.text, opts)) {
      if (x >= start && x + w <= end) text += g
      else if (x < end && x + w > start)
        text += ' '.repeat(Math.min(end, x + w) - Math.max(start, x))
      x += w
    }
    if (text) out.push({ ...s, text })
    if (x >= end) break
  }
  return out
}

/**
 * Draws `top` over `base` with its top-left corner at cell (`x`, `y`) — e.g. a transition frame
 * over the grid, or a popup. Returns new lines; `base` is not modified.
 */
export function overlay(
  base: Line[],
  x: number,
  y: number,
  top: Line[],
  opts: WidthOptions = {}
): Line[] {
  const out = base.slice()
  top.forEach((line, i) => {
    const row = y + i
    if (row < 0 || row >= out.length) return
    const under = out[row]
    const w = lineWidth(line, opts)
    const total = lineWidth(under, opts)
    out[row] = [
      ...sliceLine(under, 0, x, opts),
      ...line,
      ...sliceLine(under, x + w, Math.max(total, x + w), opts)
    ]
  })
  return out
}
