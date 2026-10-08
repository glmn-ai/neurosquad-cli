// Which part of an agent's screen a smaller tile shows.
//
// A tile never resizes the agent's terminal (that would reflow its output
// and, for the owner, make its CPR answers lie); when the screen is bigger
// than the tile, the tile shows a window onto it.

import type { Grid } from './grid.js'

/**
 * - `'follow'` (default): the window that holds the cursor and the last
 *   written line, bottom-aligned — where an agent's prompt, spinner and newest
 *   output are. It stays put while they remain inside, so it does not jitter.
 * - `'top-left'`: plain clipping from the top-left corner.
 * - `'bottom-left'` / `'bottom-right'`: the last rows, left or right edge.
 */
export type FitMode = 'follow' | 'top-left' | 'bottom-left' | 'bottom-right'

export interface Viewport {
  /** First grid column shown. */
  left: number
  /** First grid row shown. */
  top: number
}

/** Columns shown to the right of the cursor after following it sideways. */
const CURSOR_MARGIN = 2

function lastContentRow(grid: Grid): number {
  const { cols, chars, bg, attrs } = grid
  for (let y = grid.rows - 1; y >= 0; y--) {
    const start = y * cols
    for (let i = start; i < start + cols; i++) {
      if ((chars[i] !== '' && chars[i] !== ' ') || bg[i] !== 0 || attrs[i] !== 0) return y
    }
  }
  return -1
}

export function computeViewport(
  grid: Grid,
  width: number,
  height: number,
  mode: FitMode,
  previous?: Viewport
): Viewport {
  const maxTop = Math.max(0, grid.rows - height)
  const maxLeft = Math.max(0, grid.cols - width)
  if (mode === 'top-left') return { left: 0, top: 0 }
  if (mode === 'bottom-left') return { left: 0, top: maxTop }
  if (mode === 'bottom-right') return { left: maxLeft, top: maxTop }

  const cursorY = Math.min(Math.max(grid.cursor.y, 0), grid.rows - 1)
  const cursorX = Math.min(Math.max(grid.cursor.x, 0), grid.cols - 1)

  let top = 0
  if (maxTop > 0) {
    const lowest = Math.max(cursorY, lastContentRow(grid))
    const inside = (t: number): boolean =>
      t >= 0 && t <= maxTop && cursorY >= t && lowest < t + height
    if (previous && inside(previous.top)) top = previous.top
    else top = Math.min(maxTop, Math.max(0, lowest - height + 1))
    // Content taller than the tile: the cursor wins.
    if (cursorY < top) top = cursorY
  }

  // Sideways only for a visible cursor that would be off the tile: lines start
  // on the left, and that is the side worth showing.
  let left = 0
  if (maxLeft > 0 && grid.cursor.visible) {
    const margin = Math.min(CURSOR_MARGIN, width - 1)
    const holds = (l: number): boolean => cursorX >= l && cursorX < l + width
    if (holds(0)) left = 0
    else if (previous && previous.left <= maxLeft && holds(previous.left)) left = previous.left
    else left = Math.min(maxLeft, Math.max(0, cursorX - width + 1 + margin))
  }
  return { left, top }
}
