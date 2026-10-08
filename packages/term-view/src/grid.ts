// A screenful of cells in flat typed arrays — what `TermView.snapshot()`
// returns and what the tile renderer diffs.

export const ATTR_BOLD = 1
export const ATTR_DIM = 2
export const ATTR_ITALIC = 4
export const ATTR_UNDERLINE = 8
export const ATTR_BLINK = 16
export const ATTR_INVERSE = 32
export const ATTR_INVISIBLE = 64
export const ATTR_STRIKETHROUGH = 128
export const ATTR_OVERLINE = 256

export interface GridCursor {
  /** Column, 0-based (may equal `cols` right after writing the last column). */
  x: number
  /** Row within the grid, 0-based. */
  y: number
  /** DECTCEM (`CSI ? 25 h/l`): whether the program wants the cursor shown. */
  visible: boolean
}

/**
 * One screen of the agent's terminal. Cell `i` is at column `i % cols`, row
 * `Math.floor(i / cols)`.
 *
 * `chars[i]` is the cell's text: one character, a base character with its
 * combining marks, or a whole grapheme cluster (ZWJ emoji, flags); `''` for
 * an empty cell and for the right half of a wide character. `widths[i]` is
 * 1, 2 (a wide character; the next cell has width 0) or 0 (that right half).
 */
export interface Grid {
  cols: number
  rows: number
  chars: string[]
  widths: Uint8Array
  /** Packed colours, see `color.ts`. */
  fg: Uint32Array
  bg: Uint32Array
  /** `ATTR_*` bits. */
  attrs: Uint16Array
  cursor: GridCursor
  /** The program switched to the alternate screen (full-screen TUIs). */
  alternate: boolean
  /** Buffer line shown in row 0 (scrollback lines above it: `top`). */
  top: number
  /** Bumped by the view every time its screen may have changed. */
  version: number
}

export function createGrid(cols: number, rows: number): Grid {
  const size = cols * rows
  return {
    cols,
    rows,
    chars: new Array<string>(size).fill(''),
    widths: new Uint8Array(size).fill(1),
    fg: new Uint32Array(size),
    bg: new Uint32Array(size),
    attrs: new Uint16Array(size),
    cursor: { x: 0, y: 0, visible: true },
    alternate: false,
    top: 0,
    version: 0
  }
}

/** Reallocates `grid`'s arrays when its size changed; otherwise returns it as is. */
export function ensureGridSize(grid: Grid, cols: number, rows: number): Grid {
  if (grid.cols === cols && grid.rows === rows) return grid
  const next = createGrid(cols, rows)
  next.version = grid.version
  return next
}

/** One row as plain text (wide characters once, trailing blanks trimmed when asked). */
export function gridRowText(grid: Grid, row: number, trimRight = true): string {
  let text = ''
  const start = row * grid.cols
  for (let x = 0; x < grid.cols; x++) {
    const i = start + x
    if (grid.widths[i] === 0) continue
    text += grid.chars[i] || ' '
  }
  return trimRight ? text.replace(/\s+$/, '') : text
}

/** The whole grid as text, one line per row — for tests, logs and the dashboard's "last line". */
export function gridToText(grid: Grid, trimRight = true): string {
  const lines: string[] = []
  for (let y = 0; y < grid.rows; y++) lines.push(gridRowText(grid, y, trimRight))
  return lines.join('\n')
}
