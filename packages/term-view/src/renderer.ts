// Paints a grid into a rectangle of the host terminal, sending only what
// changed since the last paint.
//
// The renderer remembers what it last put in each cell of its rectangle and,
// per frame, emits ANSI for the cells that differ: a cursor move when the
// next changed cell is not where the host cursor already is (`CUF` within a
// row, `CUP` otherwise), an SGR change only when the pen differs, then the
// characters. Nothing is cleared, so nothing flickers; an unchanged frame
// costs zero bytes.
//
// Widths. The host decides how far its cursor moves after a wide or
// clustered character, and hosts disagree (emoji, flags, ambiguous-width
// CJK punctuation). After printing such a cell the renderer forgets where
// the host cursor is and positions the next cell absolutely, so a host that
// measures differently can misdraw that one cell but never shifts the rest
// of the row. A wide character cut by the tile's edge is drawn as a blank.

import { colorSgr, defaultDowngrade, type ColorDepth, type ColorDowngrade } from './color.js'
import {
  ATTR_BLINK,
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_INVERSE,
  ATTR_INVISIBLE,
  ATTR_ITALIC,
  ATTR_OVERLINE,
  ATTR_STRIKETHROUGH,
  ATTR_UNDERLINE,
  type Grid
} from './grid.js'
import { computeViewport, type FitMode, type Viewport } from './viewport.js'

/** A rectangle of the host terminal, 0-based cells. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ColorOptions {
  /** What the host can show (default `'truecolor'`). */
  depth?: ColorDepth
  /** How colours are brought down to `depth` (default `defaultDowngrade`). */
  downgrade?: ColorDowngrade
}

/**
 * When to stop trusting the host's cursor advance and position the next
 * cell absolutely: after wide/clustered cells (`'wide'`, default), or after
 * any non-ASCII character (`'non-ascii'` — for hosts set to treat ambiguous
 * East Asian characters such as box drawing as wide).
 */
export type ResyncMode = 'wide' | 'non-ascii'

/** The host terminal's size: tiles are clipped to it (a cell past the right edge would wrap). */
export interface HostSize {
  cols: number
  rows: number
}

export interface TileRendererOptions extends ColorOptions {
  rect: Rect
  hostSize?: HostSize
  fit?: FitMode
  resync?: ResyncMode
}

/**
 * The host terminal's cursor and pen as the frame being built leaves them.
 * Shared by the tiles painted in one frame, so the second tile does not
 * re-send an SGR the first one already set.
 */
export interface PaintState {
  x: number
  y: number
  cursorKnown: boolean
  fg: number
  bg: number
  attrs: number
  penKnown: boolean
}

export function createPaintState(): PaintState {
  return { x: 0, y: 0, cursorKnown: false, fg: 0, bg: 0, attrs: 0, penKnown: false }
}

export interface TileRenderer {
  /** The area painted: the requested rect clipped to the host size. */
  readonly rect: Rect
  /** The part of the agent's screen shown by the last `render`. */
  readonly viewport: Viewport
  /** Moves/resizes the tile; the next render repaints all of it. */
  setRect(rect: Rect): void
  setHostSize(size: HostSize | undefined): void
  setFit(fit: FitMode): void
  setColors(colors: ColorOptions): void
  /** Forget what the host shows (it was overwritten, cleared, resized): repaint everything next time. */
  invalidate(): void
  /**
   * ANSI that brings the rectangle from its last painted state to `grid`.
   * With `state` (several tiles in one frame) the host's cursor/pen are
   * tracked there and the pen is not reset at the end; without it the output
   * is self-contained and ends with `SGR 0`.
   */
  render(grid: Grid, state?: PaintState): string
  /** Host position of the agent's cursor, or null when hidden or outside the tile. */
  cursorPosition(grid: Grid): { x: number; y: number } | null
}

const PAINTABLE = ~ATTR_INVISIBLE & 0xffff

/** SGR turning `from` into `to` (or setting `to` from scratch when the pen is unknown). */
function sgr(state: PaintState, fg: number, bg: number, attrs: number): string {
  const params: string[] = []
  if (!state.penKnown) {
    params.push('0')
    if (attrs & ATTR_BOLD) params.push('1')
    if (attrs & ATTR_DIM) params.push('2')
    if (attrs & ATTR_ITALIC) params.push('3')
    if (attrs & ATTR_UNDERLINE) params.push('4')
    if (attrs & ATTR_BLINK) params.push('5')
    if (attrs & ATTR_INVERSE) params.push('7')
    if (attrs & ATTR_STRIKETHROUGH) params.push('9')
    if (attrs & ATTR_OVERLINE) params.push('53')
    if (fg !== 0) params.push(colorSgr(fg, 'fg'))
    if (bg !== 0) params.push(colorSgr(bg, 'bg'))
  } else {
    const from = state.attrs
    const off = from & ~attrs
    const on = attrs & ~from
    // 22 clears bold and dim together: re-add the one that stays.
    if (off & (ATTR_BOLD | ATTR_DIM)) {
      params.push('22')
      if (attrs & ATTR_BOLD) params.push('1')
      if (attrs & ATTR_DIM) params.push('2')
    } else {
      if (on & ATTR_BOLD) params.push('1')
      if (on & ATTR_DIM) params.push('2')
    }
    if (off & ATTR_ITALIC) params.push('23')
    else if (on & ATTR_ITALIC) params.push('3')
    if (off & ATTR_UNDERLINE) params.push('24')
    else if (on & ATTR_UNDERLINE) params.push('4')
    if (off & ATTR_BLINK) params.push('25')
    else if (on & ATTR_BLINK) params.push('5')
    if (off & ATTR_INVERSE) params.push('27')
    else if (on & ATTR_INVERSE) params.push('7')
    if (off & ATTR_STRIKETHROUGH) params.push('29')
    else if (on & ATTR_STRIKETHROUGH) params.push('9')
    if (off & ATTR_OVERLINE) params.push('55')
    else if (on & ATTR_OVERLINE) params.push('53')
    if (fg !== state.fg) params.push(colorSgr(fg, 'fg'))
    if (bg !== state.bg) params.push(colorSgr(bg, 'bg'))
  }
  state.fg = fg
  state.bg = bg
  state.attrs = attrs
  state.penKnown = true
  return params.length === 0 ? '' : `\x1b[${params.join(';')}m`
}

function moveTo(state: PaintState, x: number, y: number): string {
  if (state.cursorKnown && state.y === y) {
    if (state.x === x) return ''
    if (state.x < x) {
      const n = x - state.x
      state.x = x
      return n === 1 ? '\x1b[C' : `\x1b[${n}C`
    }
  }
  state.x = x
  state.y = y
  state.cursorKnown = true
  return `\x1b[${y + 1};${x + 1}H`
}

export function createTileRenderer(options: TileRendererOptions): TileRenderer {
  let requested: Rect = { ...options.rect }
  let hostSize: HostSize | undefined = options.hostSize
  let rect: Rect = requested
  let fit: FitMode = options.fit ?? 'follow'
  let depth: ColorDepth = options.depth ?? 'truecolor'
  let downgrade: ColorDowngrade = options.downgrade ?? defaultDowngrade
  const resync: ResyncMode = options.resync ?? 'wide'

  // What the host shows in each cell of the rect (row-major, rect.width wide).
  let size = 0
  let pChars: string[] = []
  let pWidths = new Uint8Array(0)
  let pFg = new Uint32Array(0)
  let pBg = new Uint32Array(0)
  let pAttrs = new Uint16Array(0)
  let valid = false
  let viewport: Viewport = { left: 0, top: 0 }

  const allocate = (): void => {
    const x = Math.max(0, Math.floor(requested.x))
    const y = Math.max(0, Math.floor(requested.y))
    let width = Math.max(0, Math.floor(requested.width))
    let height = Math.max(0, Math.floor(requested.height))
    if (hostSize) {
      width = Math.max(0, Math.min(width, Math.floor(hostSize.cols) - x))
      height = Math.max(0, Math.min(height, Math.floor(hostSize.rows) - y))
    }
    rect = { x, y, width, height }
    size = width * height
    pChars = new Array<string>(size).fill('')
    pWidths = new Uint8Array(size)
    pFg = new Uint32Array(size)
    pBg = new Uint32Array(size)
    pAttrs = new Uint16Array(size)
    valid = false
  }
  allocate()

  const renderer: TileRenderer = {
    get rect() {
      return { ...rect }
    },
    get viewport() {
      return { ...viewport }
    },

    setRect(next) {
      if (
        next.x === requested.x &&
        next.y === requested.y &&
        next.width === requested.width &&
        next.height === requested.height
      ) {
        return
      }
      requested = { ...next }
      allocate()
    },

    setHostSize(size) {
      if (size?.cols === hostSize?.cols && size?.rows === hostSize?.rows) return
      hostSize = size ? { ...size } : undefined
      allocate()
    },

    setFit(next) {
      if (next === fit) return
      fit = next
      valid = false
    },

    setColors(colors) {
      depth = colors.depth ?? depth
      downgrade = colors.downgrade ?? downgrade
      valid = false
    },

    invalidate() {
      valid = false
    },

    render(grid, sharedState) {
      const { width, height } = rect
      if (width === 0 || height === 0) return ''
      viewport = computeViewport(grid, width, height, fit, viewport)

      const state = sharedState ?? createPaintState()
      const { cols, rows, chars, widths, fg, bg, attrs } = grid
      const { left, top } = viewport
      const nonAscii = resync === 'non-ascii'
      let out = ''

      for (let row = 0; row < height; row++) {
        const gy = top + row
        const hostY = rect.y + row
        const rowInGrid = gy < rows
        for (let col = 0; col < width;) {
          const gx = left + col
          let ch = ' '
          let w = 1
          let f = 0
          let b = 0
          let a = 0
          if (rowInGrid && gx < cols) {
            const i = gy * cols + gx
            w = widths[i]
            ch = chars[i]
            a = attrs[i]
            f = fg[i]
            b = bg[i]
            if (w === 0) {
              // The right half of a wide character whose left half is outside the tile.
              w = 1
              ch = ' '
            } else if (w === 2 && col === width - 1) {
              ch = ' '
              w = 1
            }
            if (a & ATTR_INVISIBLE) {
              ch = ' '
              if (w === 2) w = 1 // two blanks: the right half paints as a blank too
            }
            if (ch === '') ch = ' '
            a &= PAINTABLE
            if (depth !== 'truecolor') {
              if (f !== 0) f = downgrade(f, depth, 'fg')
              if (b !== 0) b = downgrade(b, depth, 'bg')
            }
          }

          const p = row * width + col
          if (
            valid &&
            pChars[p] === ch &&
            pWidths[p] === w &&
            pFg[p] === f &&
            pBg[p] === b &&
            pAttrs[p] === a
          ) {
            col += w
            continue
          }

          out += moveTo(state, rect.x + col, hostY)
          if (!state.penKnown || state.fg !== f || state.bg !== b || state.attrs !== a) {
            out += sgr(state, f, b, a)
          }
          out += ch
          pChars[p] = ch
          pWidths[p] = w
          pFg[p] = f
          pBg[p] = b
          pAttrs[p] = a
          if (w === 2) {
            const q = p + 1
            pChars[q] = ''
            pWidths[q] = 0
            pFg[q] = f
            pBg[q] = b
            pAttrs[q] = a
          }
          if (w === 2 || ch.length > 1 || (nonAscii && ch.charCodeAt(0) > 0x7e)) {
            state.cursorKnown = false
          } else {
            state.x += 1
          }
          col += w
        }
      }
      valid = true
      if (!sharedState && state.penKnown && (state.fg || state.bg || state.attrs)) out += '\x1b[0m'
      return out
    },

    cursorPosition(grid) {
      if (!grid.cursor.visible) return null
      const col = Math.min(grid.cursor.x, grid.cols - 1) - viewport.left
      const row = grid.cursor.y - viewport.top
      if (col < 0 || row < 0 || col >= rect.width || row >= rect.height) return null
      return { x: rect.x + col, y: rect.y + row }
    }
  }
  return renderer
}
