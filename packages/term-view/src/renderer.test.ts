import { describe, expect, it, vi } from 'vitest'
import { PALETTE, RGB, defaultDowngrade, type ColorDowngrade } from './color.js'
import { gridToText } from './grid.js'
import { createPaintState, createTileRenderer } from './renderer.js'
import { createTermView } from './termView.js'
import {
  FIXTURE_KINDS,
  expectRegionMatches,
  loadFixture,
  makeHost,
  makeView,
  write
} from './__test__/helpers.js'

describe('diff renderer', () => {
  it('paints the whole rect once, then nothing for an unchanged screen', async () => {
    const view = makeView({ cols: 10, rows: 2 })
    await write(view, 'hi')
    const renderer = createTileRenderer({ rect: { x: 3, y: 4, width: 10, height: 2 } })
    const grid = view.snapshot()
    const first = renderer.render(grid)
    expect(first).toBe('\x1b[5;4H\x1b[0mhi        \x1b[6;4H          ')
    expect(renderer.render(grid)).toBe('')
    expect(renderer.render(view.snapshot(grid))).toBe('')
  })

  it('sends only the changed cell: one move, one character', async () => {
    const view = makeView({ cols: 10, rows: 2 })
    await write(view, 'hello')
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 10, height: 2 } })
    const grid = view.snapshot()
    renderer.render(grid)
    await write(view, '\x1b[1;2Ha')
    expect(renderer.render(view.snapshot(grid))).toBe('\x1b[1;2H\x1b[0ma')
  })

  it('skips unchanged cells within a row with a cursor-forward', async () => {
    const view = makeView({ cols: 10, rows: 1 })
    await write(view, 'abcdef')
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 10, height: 1 } })
    const grid = view.snapshot()
    const state = createPaintState()
    renderer.render(grid, state)
    await write(view, '\x1b[1;1HX\x1b[1;5HY')
    expect(renderer.render(view.snapshot(grid), state)).toBe('\x1b[1;1HX\x1b[3CY')
  })

  it('changes the pen with the smallest SGR', async () => {
    const view = makeView({ cols: 4, rows: 1 })
    await write(view, '\x1b[1;31mab\x1b[22mc\x1b[0md')
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 4, height: 1 } })
    expect(renderer.render(view.snapshot())).toBe('\x1b[1;1H\x1b[0;1;31mab\x1b[22mc\x1b[39md')
  })

  it('shares cursor and pen across tiles of one frame', async () => {
    const a = makeView({ cols: 3, rows: 1 })
    const b = makeView({ cols: 3, rows: 1 })
    await write(a, '\x1b[32mabc')
    await write(b, '\x1b[32mdef')
    const state = createPaintState()
    const left = createTileRenderer({ rect: { x: 0, y: 0, width: 3, height: 1 } })
    const right = createTileRenderer({ rect: { x: 3, y: 0, width: 3, height: 1 } })
    const frame = left.render(a.snapshot(), state) + right.render(b.snapshot(), state)
    expect(frame).toBe('\x1b[1;1H\x1b[0;32mabcdef')
  })

  it('re-anchors after a wide character instead of trusting the host advance', async () => {
    const view = makeView({ cols: 4, rows: 1 })
    await write(view, '中ab')
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 4, height: 1 } })
    expect(renderer.render(view.snapshot())).toBe('\x1b[1;1H\x1b[0m中\x1b[1;3Hab')
  })

  it('blanks a wide character cut by either edge', async () => {
    const view = makeView({ cols: 10, rows: 1 })
    await write(view, 'a中b中')
    const right = createTileRenderer({
      rect: { x: 0, y: 0, width: 2, height: 1 },
      fit: 'top-left'
    })
    expect(right.render(view.snapshot())).toBe('\x1b[1;1H\x1b[0ma ')
    const narrow = makeView({ cols: 4, rows: 1 })
    await write(narrow, '中ab')
    const left = createTileRenderer({
      rect: { x: 0, y: 0, width: 3, height: 1 },
      fit: 'bottom-right'
    })
    expect(left.render(narrow.snapshot())).toBe('\x1b[1;1H\x1b[0m ab')
  })

  it('replaces a wide character by narrow ones and back', async () => {
    const view = makeView({ cols: 4, rows: 1 })
    const host = makeHost(4, 1)
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 4, height: 1 } })
    const grid = view.snapshot()
    for (const text of ['中文', 'abcd', 'a中d', '😀x', '    ', '中文']) {
      await write(view, '\x1b[1;1H' + text)
      await write(host, renderer.render(view.snapshot(grid)))
      expect(gridToText(host.snapshot())).toBe(gridToText(view.snapshot()))
    }
  })

  it('repaints everything after invalidate() and setRect()', async () => {
    const view = makeView({ cols: 4, rows: 1 })
    await write(view, 'ab')
    const renderer = createTileRenderer({
      rect: { x: 0, y: 0, width: 4, height: 1 },
      fit: 'top-left'
    })
    const grid = view.snapshot()
    renderer.render(grid)
    renderer.invalidate()
    expect(renderer.render(grid)).toBe('\x1b[1;1H\x1b[0mab  ')
    renderer.setRect({ x: 1, y: 1, width: 2, height: 1 })
    expect(renderer.render(grid)).toBe('\x1b[2;2H\x1b[0mab')
  })

  it('clips a tile to the host size so nothing wraps', async () => {
    const view = makeView({ cols: 6, rows: 3 })
    await write(view, 'abcdef\r\nghijkl\r\nmnopqr')
    const host = makeHost(8, 2)
    const renderer = createTileRenderer({
      rect: { x: 4, y: 0, width: 6, height: 3 },
      hostSize: { cols: 8, rows: 2 },
      fit: 'top-left'
    })
    expect(renderer.rect).toEqual({ x: 4, y: 0, width: 4, height: 2 })
    await write(host, renderer.render(view.snapshot()))
    expect(gridToText(host.snapshot())).toBe('    abcd\n    ghij')
    renderer.setHostSize(undefined)
    expect(renderer.rect).toEqual({ x: 4, y: 0, width: 6, height: 3 })
  })

  it('reports the agent cursor in host coordinates', async () => {
    const view = makeView({ cols: 10, rows: 3 })
    await write(view, 'ab\r\ncd')
    const renderer = createTileRenderer({ rect: { x: 5, y: 5, width: 10, height: 3 } })
    const grid = view.snapshot()
    renderer.render(grid)
    expect(renderer.cursorPosition(grid)).toEqual({ x: 7, y: 6 })
    await write(view, '\x1b[?25l')
    expect(renderer.cursorPosition(view.snapshot(grid))).toBeNull()
  })
})

describe('fit: a tile smaller than the agent screen', () => {
  it('follows the cursor and the newest lines, bottom-aligned, without reflowing', async () => {
    const view = makeView({ cols: 20, rows: 10 })
    await write(view, 'line1\r\nline2\r\nline3\r\nline4\r\n> prompt')
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 9, height: 3 } })
    const host = makeHost(9, 3)
    await write(host, renderer.render(view.snapshot()))
    expect(gridToText(host.snapshot())).toBe('line3\nline4\n> prompt')
    expect(renderer.viewport).toEqual({ left: 0, top: 2 })
    expect(view.cols).toBe(20)
  })

  it('scrolls sideways to keep a far-right cursor visible', async () => {
    const view = makeView({ cols: 40, rows: 2 })
    await write(view, 'x'.repeat(30))
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 10, height: 2 } })
    renderer.render(view.snapshot())
    const { left } = renderer.viewport
    expect(left).toBeGreaterThan(20)
    expect(30).toBeLessThan(left + 10)
  })

  it('keeps its window while the cursor stays inside (no jitter)', async () => {
    const view = makeView({ cols: 10, rows: 10 })
    await write(view, '1\r\n2\r\n3\r\n4\r\n5\r\n6')
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 10, height: 4 } })
    const grid = view.snapshot()
    renderer.render(grid)
    expect(renderer.viewport.top).toBe(2)
    await write(view, '\x1b[4;1H') // cursor up into the window
    renderer.render(view.snapshot(grid))
    expect(renderer.viewport.top).toBe(2)
  })

  it('other fit modes clip from a fixed corner', async () => {
    const view = makeView({ cols: 10, rows: 4 })
    await write(view, 'abcdefghij\r\n2\r\n3\r\nklmnopqrst\x1b[1;1H')
    const host = makeHost(4, 2)
    const tl = createTileRenderer({ rect: { x: 0, y: 0, width: 4, height: 2 }, fit: 'top-left' })
    await write(host, tl.render(view.snapshot()))
    expect(gridToText(host.snapshot())).toBe('abcd\n2')
    const br = createTileRenderer({
      rect: { x: 0, y: 0, width: 4, height: 2 },
      fit: 'bottom-right'
    })
    await write(host, br.render(view.snapshot()))
    expect(gridToText(host.snapshot())).toBe('\nqrst')
  })

  it('pads a tile bigger than the screen with blanks', async () => {
    const view = makeView({ cols: 3, rows: 1 })
    await write(view, 'abc')
    const host = makeHost(5, 2)
    await write(host, '#####\r\n#####')
    const renderer = createTileRenderer({ rect: { x: 0, y: 0, width: 5, height: 2 } })
    await write(host, renderer.render(view.snapshot()))
    expect(gridToText(host.snapshot())).toBe('abc\n')
  })
})

describe('colour downgrade', () => {
  async function coloured() {
    const view = makeView({ cols: 3, rows: 1 })
    await write(view, '\x1b[38;2;255;0;0ma\x1b[38;5;196mb\x1b[48;2;0;0;255mc')
    return view.snapshot()
  }

  it('maps truecolor to 256 colours', async () => {
    const r = createTileRenderer({ rect: { x: 0, y: 0, width: 3, height: 1 }, depth: 256 })
    expect(r.render(await coloured())).toBe('\x1b[1;1H\x1b[0;38;5;196mab\x1b[48;5;21mc\x1b[0m')
  })

  it('maps everything to the 16 ANSI colours', async () => {
    const r = createTileRenderer({ rect: { x: 0, y: 0, width: 3, height: 1 }, depth: 16 })
    expect(r.render(await coloured())).toBe('\x1b[1;1H\x1b[0;31mab\x1b[44mc\x1b[0m')
  })

  it('drops colour but keeps attributes at depth none', async () => {
    const view = makeView({ cols: 2, rows: 1 })
    await write(view, '\x1b[1;31ma')
    const r = createTileRenderer({
      rect: { x: 0, y: 0, width: 1, height: 1 },
      depth: 'none',
      fit: 'top-left'
    })
    expect(r.render(view.snapshot())).toBe('\x1b[1;1H\x1b[0;1ma\x1b[0m')
  })

  it('uses a caller-supplied downgrade (the theme hook)', async () => {
    const downgrade = vi.fn<ColorDowngrade>(() => PALETTE | 2)
    const r = createTileRenderer({
      rect: { x: 0, y: 0, width: 3, height: 1 },
      depth: 16,
      downgrade
    })
    expect(r.render(await coloured())).toContain('\x1b[0;32m')
    expect(downgrade).toHaveBeenCalledWith(RGB | 0xff0000, 16, 'fg')
  })

  it('defaultDowngrade keeps what the depth supports', () => {
    expect(defaultDowngrade(RGB | 0x123456, 'truecolor', 'fg')).toBe(RGB | 0x123456)
    expect(defaultDowngrade(PALETTE | 9, 16, 'fg')).toBe(PALETTE | 9)
    expect(defaultDowngrade(PALETTE | 250, 256, 'bg')).toBe(PALETTE | 250)
    expect(defaultDowngrade(PALETTE | 250, 16, 'bg')).toBe(PALETTE | 7)
  })
})

describe('round trip: sample streams painted into a host terminal', () => {
  // Every frame the renderer emits, written into a second terminal, must
  // leave it showing exactly the agent's screen (or its window) in the rect.
  const tiles = [
    {
      name: 'full size',
      rect: { x: 0, y: 0, width: 120, height: 40 },
      depth: 'truecolor' as const
    },
    {
      name: 'small tile, offset',
      rect: { x: 7, y: 3, width: 50, height: 14 },
      depth: 'truecolor' as const
    },
    {
      name: 'small tile, 256 colours',
      rect: { x: 0, y: 1, width: 61, height: 19 },
      depth: 256 as const
    }
  ]
  for (const kind of FIXTURE_KINDS) {
    for (const tile of tiles) {
      it(`${kind} — ${tile.name}`, async () => {
        const cast = loadFixture(kind)
        const view = createTermView({ cols: cast.header.width, rows: cast.header.height })
        const host = makeHost(130, 45)
        const renderer = createTileRenderer({ rect: tile.rect, depth: tile.depth })
        let grid = view.snapshot()
        let sawAlternate = false
        const map = (c: number) =>
          c === 0 || tile.depth === 'truecolor' ? c : defaultDowngrade(c, tile.depth, 'fg')
        // Frames every few chunks, like a fixed frame rate over bursty output.
        for (let i = 0; i < cast.events.length; i++) {
          view.write(cast.events[i].data)
          if (i % 7 !== 6 && i !== cast.events.length - 1) continue
          await view.flush()
          grid = view.snapshot(grid)
          sawAlternate ||= grid.alternate
          await write(host, renderer.render(grid))
          const problems = expectRegionMatches(
            host.snapshot(),
            tile.rect,
            grid,
            renderer.viewport,
            map
          )
          expect(problems, `frame after chunk ${i}`).toEqual([])
        }
        if (kind === 'opencode') expect(sawAlternate).toBe(true)
        view.dispose()
        host.dispose()
      })
    }
  }
})
