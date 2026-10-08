import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { parseCast, type Cast } from '../cast.js'
import { ATTR_INVISIBLE, type Grid } from '../grid.js'
import type { Rect } from '../renderer.js'
import { createTermView, type TermView, type TermViewOptions } from '../termView.js'
import type { Viewport } from '../viewport.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

export const FIXTURE_KINDS = ['claude', 'codex', 'opencode', 'build', 'unicode'] as const
export type FixtureKind = (typeof FIXTURE_KINDS)[number]

export function loadFixture(kind: FixtureKind): Cast {
  return parseCast(gunzipSync(readFileSync(join(fixtures, `${kind}.cast.gz`))).toString('utf8'))
}

export async function write(view: TermView, data: string): Promise<void> {
  await new Promise<void>((resolve) => view.write(data, resolve))
}

export function makeView(options: Partial<TermViewOptions> = {}): TermView {
  return createTermView({ cols: 20, rows: 5, ...options })
}

/** A second terminal standing in for the host: renderer output is written into it. */
export function makeHost(cols: number, rows: number): TermView {
  return createTermView({ cols, rows, scrollback: 0 })
}

/**
 * Checks that `host` shows `source`'s viewport inside `rect`, cell by cell,
 * with the renderer's edge rules (a wide character cut by an edge is blank).
 */
export function expectRegionMatches(
  host: Grid,
  rect: Rect,
  source: Grid,
  viewport: Viewport,
  colorMap: (c: number) => number = (c) => c
): string[] {
  const problems: string[] = []
  for (let row = 0; row < rect.height; row++) {
    for (let col = 0; col < rect.width; col++) {
      const hi = (rect.y + row) * host.cols + rect.x + col
      const gx = viewport.left + col
      const gy = viewport.top + row
      let ch = ' '
      let w = 1
      let fg = 0
      let bg = 0
      let attrs = 0
      if (gx < source.cols && gy < source.rows) {
        const si = gy * source.cols + gx
        ch = source.chars[si] || ' '
        w = source.widths[si]
        fg = colorMap(source.fg[si])
        bg = colorMap(source.bg[si])
        attrs = source.attrs[si] & ~ATTR_INVISIBLE
        if (source.attrs[si] & ATTR_INVISIBLE) ch = ' '
        if (w === 0) {
          // Right half: fine if the host shows the right half too (its left half was painted wide).
          if (col > 0 && host.widths[hi] === 0) continue
          ch = ' '
          w = 1
        } else if (w === 2 && (col === rect.width - 1 || source.attrs[si] & ATTR_INVISIBLE)) {
          ch = ' '
          w = 1
        }
      }
      const got = host.chars[hi] || ' '
      if (
        got !== ch ||
        host.widths[hi] !== w ||
        host.fg[hi] !== fg ||
        host.bg[hi] !== bg ||
        host.attrs[hi] !== attrs
      ) {
        problems.push(
          `(${col},${row}) want ${JSON.stringify(ch)} w${w} fg${fg.toString(16)} bg${bg.toString(16)} a${attrs}` +
            ` got ${JSON.stringify(got)} w${host.widths[hi]} fg${host.fg[hi].toString(16)} bg${host.bg[hi].toString(16)} a${host.attrs[hi]}`
        )
        if (problems.length > 5) return problems
      }
    }
  }
  return problems
}
