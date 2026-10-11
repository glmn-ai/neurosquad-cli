// A pixel picture of a terminal screen (a term-view grid), for checking what the dashboard draws
// as a camera would see it: each cell is `scale` pixels wide and 2 × `scale` tall, block glyphs
// (█ ▀ ▄) cover their halves in the foreground colour, everything else shows the background.
// Used by the tests and the live e2e to decode the phone panel's QR codes.
import {
  ATTR_INVERSE,
  isPaletteColor,
  isRgbColor,
  colorValue,
  paletteToRgb,
  type Grid
} from '@neurosquad/term-view'

export interface Picture {
  data: Uint8ClampedArray
  width: number
  height: number
}

const DEFAULT_FG = 0xe5e5e5
const DEFAULT_BG = 0x000000

function rgbOf(color: number, fallback: number): number {
  if (isRgbColor(color)) return colorValue(color)
  if (isPaletteColor(color)) return paletteToRgb(colorValue(color))
  return fallback
}

export function gridPicture(grid: Grid, scale = 4): Picture {
  const width = grid.cols * scale
  const height = grid.rows * 2 * scale
  const data = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const i = row * grid.cols + col
      let fg = rgbOf(grid.fg[i]!, DEFAULT_FG)
      let bg = rgbOf(grid.bg[i]!, DEFAULT_BG)
      if (grid.attrs[i]! & ATTR_INVERSE) [fg, bg] = [bg, fg]
      const ch = grid.chars[i]
      const top = ch === '█' || ch === '▀' ? fg : bg
      const bottom = ch === '█' || ch === '▄' ? fg : bg
      for (let half = 0; half < 2; half++) {
        const color = half === 0 ? top : bottom
        for (let dy = 0; dy < scale; dy++) {
          const y = (row * 2 + half) * scale + dy
          for (let dx = 0; dx < scale; dx++) {
            const at = (y * width + col * scale + dx) * 4
            data[at] = (color >> 16) & 0xff
            data[at + 1] = (color >> 8) & 0xff
            data[at + 2] = color & 0xff
            data[at + 3] = 255
          }
        }
      }
    }
  }
  return { data, width, height }
}
