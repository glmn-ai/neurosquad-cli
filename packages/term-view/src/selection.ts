// Selecting text and finding links on an agent's screen.
//
// A dashboard that turns on mouse reporting takes the mouse away from the host
// terminal: dragging no longer selects and links can't be clicked. So the
// dashboard does both itself, on the view's buffer.
//
// Positions are buffer cells: `line` counts from the top of the active buffer
// (scrollback included), so a selection stays on its text while the person
// scrolls. `bufferTop` turns a tile row into a buffer line.

import type { Grid } from './grid.js'
import { ATTR_INVERSE } from './grid.js'
import type { TermView } from './termView.js'

export interface CellPos {
  /** Buffer line, 0 = the oldest line kept. */
  line: number
  /** Column, 0-based. */
  col: number
}

/** Both ends included; `start` and `end` in any order. */
export interface Selection {
  start: CellPos
  end: CellPos
}

/** The buffer line shown in a snapshot's row 0 at `scrollOffset` (as `snapshot` picks it). */
export function bufferTop(view: TermView, scrollOffset = 0): number {
  const buffer = view.terminal.buffer.active
  return buffer.type === 'alternate'
    ? buffer.baseY
    : Math.max(0, buffer.baseY - Math.max(0, Math.floor(scrollOffset)))
}

const before = (a: CellPos, b: CellPos): boolean =>
  a.line < b.line || (a.line === b.line && a.col <= b.col)

/** The selection's ends in reading order. */
export function orderSelection(selection: Selection): Selection {
  return before(selection.start, selection.end)
    ? selection
    : { start: selection.end, end: selection.start }
}

/**
 * The selected text: rows joined with `\n`, except where the terminal itself
 * wrapped a long line; trailing blanks of each row dropped.
 */
export function selectionText(view: TermView, selection: Selection): string {
  const { start, end } = orderSelection(selection)
  const buffer = view.terminal.buffer.active
  let text = ''
  for (let y = start.line; y <= end.line; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const from = y === start.line ? start.col : 0
    const to = y === end.line ? end.col + 1 : view.cols
    const next = buffer.getLine(y + 1)
    const wrapsOn = y < end.line && next?.isWrapped === true
    const part = line.translateToString(false, from, to)
    text += wrapsOn ? part : part.replace(/\s+$/, '')
    if (y < end.line && !wrapsOn) text += '\n'
  }
  return text
}

/** Inverts the selected cells of a snapshot (taken with the same scroll offset). */
export function highlightSelection(grid: Grid, selection: Selection): void {
  const { start, end } = orderSelection(selection)
  for (let row = 0; row < grid.rows; row++) {
    const line = grid.top + row
    if (line < start.line || line > end.line) continue
    const from = line === start.line ? start.col : 0
    const to = line === end.line ? Math.min(end.col, grid.cols - 1) : grid.cols - 1
    for (let col = Math.max(0, from); col <= to; col++)
      grid.attrs[row * grid.cols + col] ^= ATTR_INVERSE
  }
}

// Characters a URL is made of (ASCII only: a frame's │ or a quote ends it).
const URL_RE = /https?:\/\/[\w\-.~:/?#[\]@!$&()*+,;=%]+/g
// Rows joined while looking for a link that the program broke over several lines.
const MAX_ROWS = 8

interface RowText {
  text: string
  /** Column of each UTF-16 unit of `text`. */
  cols: number[]
}

function rowText(view: TermView, y: number): RowText | null {
  const line = view.terminal.buffer.active.getLine(y)
  if (!line) return null
  let text = ''
  const cols: number[] = []
  const cell = line.getCell(0)
  for (let x = 0; x < view.cols; x++) {
    line.getCell(x, cell)
    if (cell?.getWidth() === 0) continue
    const chars = cell?.getChars() || ' '
    text += chars
    for (let k = 0; k < chars.length; k++) cols.push(x)
  }
  return { text, cols }
}

/** The row ends in text on its last column: a long word (a link) may go on below. */
const runsToEdge = (row: RowText): boolean => /\S$/.test(row.text)

/**
 * The http(s) link under a cell, or null. Follows a link onto the next rows
 * when the terminal wrapped it, and when the program broke it at the edge
 * itself (Claude Code and other TUIs wrap their own text; the rest of the link
 * then starts the next row after its indent).
 */
export function linkAt(view: TermView, pos: CellPos): string | null {
  const buffer = view.terminal.buffer.active
  const isWrapped = (y: number): boolean => buffer.getLine(y)?.isWrapped === true
  const joins = (upper: RowText, y: number): boolean => isWrapped(y) || runsToEdge(upper)

  // Rows above that may hold the start of the link.
  let first = pos.line
  let upper = rowText(view, first - 1)
  while (first > 0 && pos.line - first < MAX_ROWS && upper && joins(upper, first)) {
    first--
    upper = rowText(view, first - 1)
  }

  let text = ''
  let target = -1
  let previous: RowText | null = null
  for (let y = first; y <= pos.line + MAX_ROWS; y++) {
    const row = rowText(view, y)
    if (!row) break
    if (previous && !joins(previous, y)) {
      if (y > pos.line) break
      text = ''
    }
    // A program's own break: the rest of the link starts after the indent.
    const skip = previous && !isWrapped(y) ? row.text.length - row.text.trimStart().length : 0
    if (y === pos.line) {
      const index = row.cols.findIndex((c) => c >= pos.col)
      if (index >= skip) target = text.length + index - skip
    }
    text += row.text.slice(skip)
    previous = row
    if (y >= pos.line && !runsToEdge(row) && !isWrapped(y + 1)) break
  }
  if (target < 0) return null

  for (const match of text.matchAll(URL_RE)) {
    const from = match.index
    const url = trimUrl(match[0])
    if (target >= from && target < from + url.length) return url
  }
  return null
}

/** Drops what usually follows a link in prose: closing punctuation, an unmatched bracket. */
function trimUrl(url: string): string {
  let out = url
  for (;;) {
    const last = out.at(-1)
    if (last && '.,;:!?'.includes(last)) out = out.slice(0, -1)
    else if (last === ')' && count(out, '(') < count(out, ')')) out = out.slice(0, -1)
    else if (last === ']' && count(out, '[') < count(out, ']')) out = out.slice(0, -1)
    else return out
  }
}

const count = (text: string, ch: string): number => text.split(ch).length - 1
