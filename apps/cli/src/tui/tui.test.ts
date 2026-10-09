import { describe, expect, it } from 'vitest'
import { createTheme } from '@neurosquad/tui-theme'
import { InputParser, applicationCursor, encodeMouse } from './keys.js'
import { gridShape, inner, screenLayout, tileRects } from './layout.js'
import { Canvas } from './canvas.js'
import { TextField } from './widgets.js'

describe('input parser', () => {
  it('keys, modifiers, mouse, paste, split sequences', () => {
    const parser = new InputParser()
    const events = parser.feed(
      'a\r\x1b[A\x1b[1;5C\x1d\x1bx\x1b[<0;10;5M\x1b[<64;1;1M\x1b[200~hi\nthere\x1b[201~'
    )
    expect(
      events.map((e) =>
        e.type === 'key' ? `${e.ctrl ? 'C-' : ''}${e.alt ? 'M-' : ''}${e.name}` : e.type
      )
    ).toEqual(['a', 'enter', 'up', 'C-right', 'C-]', 'M-x', 'mouse', 'mouse', 'paste'])
    const click = events[6]
    expect(click).toMatchObject({ type: 'mouse', button: 0, action: 'down', x: 9, y: 4 })
    expect(events[7]).toMatchObject({ button: 'wheelup' })
    expect(events[8]).toMatchObject({ text: 'hi\nthere' })
    // A sequence split across chunks completes with the next one.
    expect(parser.feed('\x1b[')).toEqual([])
    expect(parser.feed('B')[0]).toMatchObject({ name: 'down' })
    // A lone Escape is held until flushed.
    expect(parser.feed('\x1b')).toEqual([])
    expect(parser.flush()[0]).toMatchObject({ name: 'escape' })
  })

  it('re-encodes mouse and cursor keys for an agent', () => {
    const [event] = new InputParser().feed('\x1b[<0;30;12M')
    expect(encodeMouse(event as never, 2, 3)).toBe('\x1b[<0;3;4M')
    expect(applicationCursor('\x1b[A')).toBe('\x1bOA')
    expect(applicationCursor('x')).toBe('x')
  })
})

describe('layout', () => {
  it('sidebar hides on narrow screens', () => {
    expect(screenLayout(160, 40, 'auto').sidebar).not.toBeNull()
    expect(screenLayout(60, 40, 'auto').sidebar).toBeNull()
    expect(screenLayout(60, 40, 'shown').sidebar).not.toBeNull()
  })

  it('grid tiles fill the area exactly, with no overlap', () => {
    const area = { x: 30, y: 1, width: 130, height: 40 }
    for (const count of [1, 2, 3, 4, 5, 7, 9, 12]) {
      const shape = gridShape(count, area)
      const rects = tileRects(shape, count, area)
      expect(rects.length).toBe(Math.min(count, shape.perPage))
      const covered = rects.reduce((sum, r) => sum + r.width * r.height, 0)
      if (rects.length === shape.cols * shape.rows) expect(covered).toBe(area.width * area.height)
      for (const r of rects) {
        expect(r.width).toBeGreaterThanOrEqual(28)
        expect(r.height).toBeGreaterThanOrEqual(7)
      }
    }
    expect(gridShape(4, area)).toMatchObject({ cols: 2, rows: 2 })
    expect(inner({ x: 0, y: 0, width: 10, height: 5 })).toEqual({ x: 1, y: 1, width: 8, height: 3 })
  })

  it('pages when tiles would be too small', () => {
    const shape = gridShape(9, { width: 60, height: 20 })
    expect(shape.perPage).toBeLessThan(9)
  })
})

describe('canvas', () => {
  const theme = createTheme({ colorLevel: 0, unicode: true, isTTY: true })

  it('writes only what changed and never touches tile cells', () => {
    const a = new Canvas(10, 2)
    a.put(0, 0, [{ text: 'hello' }])
    a.clear(5, 1, 5, 1)
    const first = a.diff(theme, undefined)
    expect(first.out).toContain('hello')
    const b = new Canvas(10, 2)
    b.put(0, 0, [{ text: 'hellO' }])
    b.clear(5, 1, 5, 1)
    const second = b.diff(theme, a)
    expect(second.out).toBe('\x1b[1;5H\x1b[0mO\x1b[0m')
    expect([...second.rows]).toEqual([0])
    expect(b.diff(theme, b).out).toBe('')
  })

  it('wide characters stay whole', () => {
    const a = new Canvas(6, 1)
    a.put(0, 0, [{ text: 'ab' }])
    const b = new Canvas(6, 1)
    b.put(0, 0, [{ text: 'a日' }])
    expect(b.diff(theme, a).out).toContain('日')
  })
})

describe('text field', () => {
  it('edits', () => {
    const field = new TextField('hello')
    const parser = new InputParser()
    for (const event of parser.feed('\x7f\x7fp!\x1b[D\x1b[D\x1b[DX')) field.handle(event as never)
    expect(field.value).toBe('heXlp!')
  })
})
