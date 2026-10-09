// Where everything goes on the screen. Pure: sizes in, rectangles out.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Layout {
  width: number
  height: number
  header: Rect
  footer: Rect
  sidebar: Rect | null
  main: Rect
}

export const SIDEBAR_MIN = 24
export const SIDEBAR_MAX = 34
/** Below this width the sidebar is hidden unless asked for. */
export const SIDEBAR_AUTO_HIDE_BELOW = 72
/** A tile smaller than this is not worth showing: the grid pages instead. */
export const TILE_MIN_WIDTH = 28
export const TILE_MIN_HEIGHT = 7

export function screenLayout(
  width: number,
  height: number,
  sidebar: 'auto' | 'shown' | 'hidden'
): Layout {
  const showSidebar =
    sidebar === 'shown' || (sidebar === 'auto' && width >= SIDEBAR_AUTO_HIDE_BELOW)
  const sidebarWidth = showSidebar
    ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(width * 0.22)))
    : 0
  const bodyY = 1
  const bodyHeight = Math.max(1, height - 2)
  return {
    width,
    height,
    header: { x: 0, y: 0, width, height: 1 },
    footer: { x: 0, y: height - 1, width, height: 1 },
    sidebar: showSidebar ? { x: 0, y: bodyY, width: sidebarWidth, height: bodyHeight } : null,
    main: {
      x: sidebarWidth,
      y: bodyY,
      width: Math.max(1, width - sidebarWidth),
      height: bodyHeight
    }
  }
}

export interface GridShape {
  cols: number
  rows: number
  /** Tiles per page. */
  perPage: number
}

/**
 * How many columns and rows of tiles for `count` agents in `area`: the most
 * tiles that still meet the minimum size, laid out so each tile's shape is
 * closest to a terminal's (about 3 cells wide per row).
 */
export function gridShape(
  count: number,
  area: Pick<Rect, 'width' | 'height'>,
  maxTiles = 9
): GridShape {
  const want = Math.max(1, Math.min(count, maxTiles))
  let best: { cols: number; rows: number; score: number } | null = null
  for (let n = want; n >= 1; n--) {
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols)
      const width = Math.floor(area.width / cols)
      const height = Math.floor(area.height / rows)
      if (width < TILE_MIN_WIDTH || height < TILE_MIN_HEIGHT) continue
      // Prefer filling the slots, then a terminal-like aspect (≈ 3:1 in cells).
      const empty = cols * rows - n
      const aspect = Math.abs(Math.log(width / height / 3))
      const score = empty * 2 + aspect
      if (!best || score < best.score) best = { cols, rows, score }
    }
    if (best) return { cols: best.cols, rows: best.rows, perPage: n }
  }
  return { cols: 1, rows: 1, perPage: 1 }
}

/** The tiles' rectangles for one page, row by row, filling `area` exactly. */
export function tileRects(shape: GridShape, count: number, area: Rect): Rect[] {
  const rects: Rect[] = []
  const n = Math.min(count, shape.perPage)
  const rows = Math.ceil(n / shape.cols)
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / shape.cols)
    const inRow = row === rows - 1 ? n - row * shape.cols : shape.cols
    const col = i - row * shape.cols
    const x0 = area.x + Math.floor((col * area.width) / inRow)
    const x1 = area.x + Math.floor(((col + 1) * area.width) / inRow)
    const y0 = area.y + Math.floor((row * area.height) / rows)
    const y1 = area.y + Math.floor(((row + 1) * area.height) / rows)
    rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
  }
  return rects
}

/** The inside of a framed rectangle (one-cell border). */
export function inner(rect: Rect): Rect {
  return {
    x: rect.x + 1,
    y: rect.y + 1,
    width: Math.max(1, rect.width - 2),
    height: Math.max(1, rect.height - 2)
  }
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}
