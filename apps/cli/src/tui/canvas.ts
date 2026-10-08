// The dashboard's own chrome (header, sidebar, tile frames, dialogs) is drawn
// into a cell canvas each frame and written as a diff against the previous
// one: only cells that changed are sent, nothing is cleared, so nothing
// flickers. Cells marked transparent belong to the live terminal tiles, which
// the term-view compositor paints — the chrome writer never touches them.
import { graphemes, RESET, type Line, type StyleSpec, type Theme } from '@neurosquad/tui-theme'

interface Cell {
  /** The grapheme, '' for the right half of a wide one, null = transparent. */
  ch: string | null
  style: StyleSpec
  key: string
}

const styleKey = (s: StyleSpec): string =>
  `${typeof s.fg === 'object' ? `${s.fg.r},${s.fg.g},${s.fg.b}` : (s.fg ?? '')}|${
    typeof s.bg === 'object' ? `${s.bg.r},${s.bg.g},${s.bg.b}` : (s.bg ?? '')
  }|${s.bold ? 1 : 0}${s.dim ? 1 : 0}${s.italic ? 1 : 0}${s.underline ? 1 : 0}${s.inverse ? 1 : 0}`

const BLANK: StyleSpec = {}

export class Canvas {
  readonly cells: Cell[][]

  constructor(
    readonly width: number,
    readonly height: number,
    fill: StyleSpec = BLANK
  ) {
    const key = styleKey(fill)
    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => ({ ch: ' ', style: fill, key }))
    )
  }

  /** Writes a styled line at (x, y), clipped to `maxWidth` and the canvas. Returns the width used. */
  put(x: number, y: number, line: Line, maxWidth = this.width - x): number {
    if (y < 0 || y >= this.height) return 0
    const row = this.cells[y]
    const limit = Math.min(this.width, x + Math.max(0, maxWidth))
    let col = x
    for (const segment of line) {
      const style: StyleSpec = segment
      const key = styleKey(style)
      for (const { g, w } of graphemes(segment.text)) {
        if (w === 0) continue
        if (col + w > limit) return col - x
        if (col >= 0) {
          row[col] = { ch: g, style, key }
          if (w === 2 && col + 1 < this.width) row[col + 1] = { ch: '', style, key }
        }
        col += w
      }
    }
    return col - x
  }

  /** Fills a rectangle with spaces of one style. */
  fill(x: number, y: number, width: number, height: number, style: StyleSpec): void {
    const key = styleKey(style)
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + height); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + width); xx++) {
        this.cells[yy][xx] = { ch: ' ', style, key }
      }
    }
  }

  /** Marks a rectangle as owned by a live terminal tile. */
  clear(x: number, y: number, width: number, height: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + height); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + width); xx++) {
        this.cells[yy][xx] = { ch: null, style: BLANK, key: '' }
      }
    }
  }

  /**
   * The bytes that bring the screen from `prev` (undefined = unknown, paint
   * everything) to this canvas. Transparent cells are skipped.
   */
  diff(theme: Theme, prev: Canvas | undefined): { out: string; rows: Set<number> } {
    let out = ''
    const rows = new Set<number>()
    const full = !prev || prev.width !== this.width || prev.height !== this.height
    for (let y = 0; y < this.height; y++) {
      const row = this.cells[y]
      const old = full || !prev ? undefined : prev.cells[y]
      const differs = (x: number): boolean => {
        const c = row[x]
        const w = old?.[x]
        return c.ch !== null && (!w || w.ch !== c.ch || w.key !== c.key)
      }
      let x = 0
      while (x < this.width) {
        if (!differs(x)) {
          x++
          continue
        }
        // Start a run; the right half of a wide character starts at its left half.
        if (row[x].ch === '' && x > 0 && row[x - 1].ch) x--
        out += `\x1b[${y + 1};${x + 1}H`
        let key: string | null = null
        let first = true
        while (x < this.width) {
          const c = row[x]
          if (c.ch === null) break
          if (!first && !differs(x) && c.ch !== '') break
          first = false
          if (c.ch !== '') {
            if (c.key !== key) {
              out += RESET + theme.open(c.style)
              key = c.key
            }
            out += c.ch
          }
          x++
        }
        out += RESET
        rows.add(y)
      }
    }
    return { out, rows }
  }
}
