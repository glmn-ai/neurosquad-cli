import { describe, expect, it } from 'vitest'
import { ATTR_INVERSE } from './grid.js'
import { bufferTop, highlightSelection, linkAt, selectionText } from './selection.js'
import { createTermView, type TermView } from './termView.js'

const write = (view: TermView, data: string): Promise<void> =>
  new Promise((resolve) => view.write(data, resolve))

describe('selection', () => {
  it('copies rows with newlines, a terminal-wrapped line in one piece', async () => {
    const view = createTermView({ cols: 10, rows: 5 })
    await write(view, 'hello world\r\nsecond   \r\nthird')
    // Row 0 "hello worl", row 1 "d" (wrapped), row 2 "second", row 3 "third".
    expect(selectionText(view, { start: { line: 0, col: 6 }, end: { line: 2, col: 9 } })).toBe(
      'world\nsecond'
    )
    // Either order.
    expect(selectionText(view, { start: { line: 3, col: 2 }, end: { line: 2, col: 3 } })).toBe(
      'ond\nthi'
    )
  })

  it('maps the scrolled view to buffer lines and inverts the selected cells', async () => {
    const view = createTermView({ cols: 10, rows: 3, scrollback: 50 })
    let text = ''
    for (let i = 0; i < 10; i++) text += `row ${i}\r\n`
    await write(view, text)
    // 10 lines + the cursor line on 3 rows: baseY 8.
    expect(bufferTop(view)).toBe(8)
    expect(bufferTop(view, 5)).toBe(3)
    const grid = view.snapshot(undefined, { scrollOffset: 5 })
    highlightSelection(grid, { start: { line: 4, col: 0 }, end: { line: 4, col: 2 } })
    const inverted = (row: number, col: number): boolean =>
      (grid.attrs[row * grid.cols + col] & ATTR_INVERSE) !== 0
    expect([inverted(1, 0), inverted(1, 2), inverted(1, 3), inverted(0, 0)]).toEqual([
      true,
      true,
      false,
      false
    ])
  })
})

describe('linkAt', () => {
  it('finds the link under a cell and trims the punctuation after it', async () => {
    const view = createTermView({ cols: 60, rows: 4 })
    await write(view, 'See (https://example.com/a_(b)) now. Or http://x.io/q?a=1.')
    expect(linkAt(view, { line: 0, col: 10 })).toBe('https://example.com/a_(b)')
    expect(linkAt(view, { line: 0, col: 45 })).toBe('http://x.io/q?a=1')
    expect(linkAt(view, { line: 0, col: 1 })).toBeNull()
  })

  it('follows a link the terminal wrapped, from any of its rows', async () => {
    const view = createTermView({ cols: 20, rows: 4 })
    await write(view, 'go https://example.com/very/long/path ok')
    const url = 'https://example.com/very/long/path'
    expect(linkAt(view, { line: 0, col: 5 })).toBe(url)
    expect(linkAt(view, { line: 1, col: 3 })).toBe(url)
  })

  it('follows a link a TUI broke at the edge itself, past the indent', async () => {
    const view = createTermView({ cols: 24, rows: 5 })
    // Ink-style: the program writes the rows, each with its indent.
    await write(view, '  see https://example.co\r\n  m/docs/page here\r\n  next line')
    const url = 'https://example.com/docs/page'
    expect(linkAt(view, { line: 0, col: 10 })).toBe(url)
    expect(linkAt(view, { line: 1, col: 4 })).toBe(url)
    expect(linkAt(view, { line: 1, col: 0 })).toBeNull()
    expect(linkAt(view, { line: 2, col: 4 })).toBeNull()
  })

  it('stops at a frame border', async () => {
    const view = createTermView({ cols: 30, rows: 3 })
    await write(view, '│ https://a.dev/x │')
    expect(linkAt(view, { line: 0, col: 4 })).toBe('https://a.dev/x')
  })
})
