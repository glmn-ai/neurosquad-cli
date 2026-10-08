/**
 * The NeuroSquad lockup in a terminal: the `>S` mark (prompt chevron + squared S) and the
 * `neurosquad` word, drawn as pixel art with half blocks (`▀ ▄ █`, two pixels per cell, so pixels
 * are roughly square), leaning like the desktop logo (11°) and lit by the lime → emerald brand
 * gradient. The word stays in the foreground colour, as on the desktop.
 *
 * Without Unicode it falls back to a one-line `>S neurosquad`.
 */
import { gradientAt, mix, type Rgb } from './color.js'
import { seg, type Line } from './text.js'
import type { Theme } from './theme.js'
import { BRAND_GRADIENT, ROLE_SOURCES } from './tokens.js'

// 7-pixel-tall glyphs. '#' = ink. Row 0 is the ascender line, rows 1-5 x-height, row 6 descender.
const MARK = [
  '##.......#####', //
  '.##......#....',
  '..##.....#....',
  '...##....#####',
  '..##.........#',
  '.##..........#',
  '##.......#####'
]
// The S above is drawn 7 rows tall, the chevron sits in front of it; columns 0-4 chevron, 9-13 S.

const LETTERS: Record<string, string[]> = {
  n: ['....', '####', '#..#', '#..#', '#..#', '#..#', '....'],
  e: ['....', '####', '#..#', '####', '#...', '####', '....'],
  u: ['....', '#..#', '#..#', '#..#', '#..#', '####', '....'],
  r: ['...', '###', '#..', '#..', '#..', '#..', '...'],
  o: ['....', '####', '#..#', '#..#', '#..#', '####', '....'],
  s: ['....', '####', '#...', '####', '...#', '####', '....'],
  q: ['....', '####', '#..#', '#..#', '#..#', '####', '...#'],
  a: ['....', '####', '...#', '####', '#..#', '####', '....'],
  d: ['...#', '####', '#..#', '#..#', '#..#', '####', '....']
}

const SHEAR = Math.tan((11 * Math.PI) / 180)
const ROWS = 7

interface Bitmap {
  width: number
  /** `pixels[y][x]` → 0 none, 1 mark, 2 word. */
  pixels: number[][]
}

function compose(word: string, withWord: boolean): Bitmap {
  const cols: number[][] = [] // column-major for easy concatenation
  const pushGlyph = (rows: string[], kind: number): void => {
    for (let x = 0; x < rows[0].length; x++) cols.push(rows.map((r) => (r[x] === '#' ? kind : 0)))
  }
  const gap = (n: number): void => {
    for (let i = 0; i < n; i++) cols.push(new Array(ROWS).fill(0))
  }
  // Squeeze the chevron/S gap from the source art to two columns (the desktop's equal-gaps rule).
  const mark = MARK.map((r) => r.slice(0, 5) + r.slice(7))
  pushGlyph(mark, 1)
  if (withWord) {
    gap(3)
    ;[...word].forEach((ch, i) => {
      const g = LETTERS[ch]
      if (!g) throw new Error(`No pixel glyph for ${ch}`)
      if (i > 0) gap(1)
      pushGlyph(g, 2)
    })
  }
  const shift = (y: number): number => Math.round((ROWS - 1 - y) * SHEAR)
  const width = cols.length + shift(0)
  const pixels: number[][] = []
  for (let y = 0; y < ROWS; y++) {
    const row = new Array(width).fill(0)
    for (let x = 0; x < cols.length; x++) if (cols[x][y]) row[x + shift(y)] = cols[x][y]
    pixels.push(row)
  }
  return { width, pixels }
}

export interface WordmarkOptions {
  /** Include the `neurosquad` word (default true); false = just the `>S` mark. */
  word?: boolean
  /** Colour of a mark pixel column: default = the brand gradient across the mark. */
  markColor?: (x: number, width: number) => Rgb
  /** Colour of a word pixel column: default = foreground. */
  wordColor?: (x: number, width: number) => Rgb
  /** Background behind the art (default: terminal default, i.e. none). */
  bg?: Rgb
}

/** Mark width in pixels (= cells) — the gradient spans the mark only, like the desktop. */
const MARK_WIDTH = compose('', false).width

/**
 * The lockup as 4 lines of half-block art (`theme.unicode`), or one plain line otherwise.
 * Pass `markColor` / `wordColor` to animate it (see `animations.wordmarkSweep`).
 */
export function wordmark(theme: Theme, opts: WordmarkOptions = {}): Line[] {
  const withWord = opts.word !== false
  const markColor =
    opts.markColor ?? ((x: number) => gradientAt(BRAND_GRADIENT, x / Math.max(1, MARK_WIDTH - 1)))
  const wordColor = opts.wordColor ?? (() => ROLE_SOURCES.text)
  if (!theme.unicode) {
    const line: Line = [
      seg('>', { fg: BRAND_GRADIENT[0], bold: true }),
      seg('S', { fg: BRAND_GRADIENT[1], bold: true })
    ]
    if (withWord) line.push(seg(' neurosquad', { fg: 'text', bold: true }))
    return [line]
  }
  const bm = compose('neurosquad', withWord)
  const lines: Line[] = []
  for (let y = 0; y < ROWS; y += 2) {
    const line: Line = []
    for (let x = 0; x < bm.width; x++) {
      const top = bm.pixels[y][x]
      const bottom = y + 1 < ROWS ? bm.pixels[y + 1][x] : 0
      const kind = top || bottom
      if (!kind) {
        line.push(seg(' ', opts.bg ? { bg: opts.bg } : {}))
        continue
      }
      const fg = kind === 1 ? markColor(x, MARK_WIDTH) : wordColor(x, bm.width)
      const ch = top && bottom ? '█' : top ? '▀' : '▄'
      line.push(seg(ch, opts.bg ? { fg, bg: opts.bg } : { fg }))
    }
    lines.push(line)
  }
  return lines
}

/**
 * The one-line `>S` mark (prompt chevron in lime, S in emerald) for headers and status lines.
 * Unicode terminals get `›` for the chevron only when `chevron: 'thin'` is asked for.
 */
export function compactMark(_theme: Theme, opts: { chevron?: 'ascii' | 'thin' } = {}): Line {
  const chevron = opts.chevron === 'thin' ? '❯' : '>'
  return [
    seg(chevron, { fg: BRAND_GRADIENT[0], bold: true }),
    seg('S', { fg: mix(BRAND_GRADIENT[0], BRAND_GRADIENT[1], 0.8), bold: true })
  ]
}

/** Width in cells of `wordmark(theme)` (unicode version). */
export function wordmarkWidth(word = true): number {
  return compose('neurosquad', word).width
}
