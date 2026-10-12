import { describe, expect, it } from 'vitest'
import { gridRowText } from './grid.js'
import { createScrollback, wheelKeys, wheelTarget } from './scrollback.js'
import { createTermView, type TermView } from './termView.js'

const numbered = (from: number, to: number): string => {
  let text = ''
  for (let i = from; i <= to; i++) text += `line ${i}\r\n`
  return text
}

const write = (view: TermView, data: string): Promise<void> =>
  new Promise((resolve) => view.write(data, resolve))

/** The first row the view shows at the scrollback's offset. */
const topRow = (view: TermView, offset: number): string =>
  gridRowText(view.snapshot(undefined, { scrollOffset: offset }), 0).trim()

describe('scrollback', () => {
  it('scrolls back and forward within what the buffer keeps', async () => {
    const view = createTermView({ cols: 20, rows: 10, scrollback: 100 })
    const scroll = createScrollback(view)
    await write(view, numbered(1, 30))
    // 30 lines + the empty cursor line on a 10-row screen: 21 above it.
    expect(scroll.available).toBe(21)
    expect(scroll.canScroll()).toBe(true)
    expect(scroll.scrolled).toBe(false)
    expect(topRow(view, scroll.offset)).toBe('line 22')
    expect(scroll.scrollBy(3)).toBe(true)
    expect(scroll.offset).toBe(3)
    expect(topRow(view, scroll.offset)).toBe('line 19')
    scroll.page(-1)
    expect(scroll.offset).toBe(12)
    scroll.toTop()
    expect(scroll.offset).toBe(21)
    expect(topRow(view, scroll.offset)).toBe('line 1')
    expect(scroll.scrollBy(5)).toBe(false) // already at the top
    scroll.scrollBy(-100)
    expect(scroll.scrolled).toBe(false)
    expect(scroll.offset).toBe(0)
    view.dispose()
  })

  it('new output does not move the view while scrolled; at the bottom it follows again', async () => {
    const view = createTermView({ cols: 20, rows: 10, scrollback: 100 })
    const scroll = createScrollback(view)
    await write(view, numbered(1, 30))
    scroll.scrollBy(6)
    expect(topRow(view, scroll.offset)).toBe('line 16')
    await write(view, numbered(31, 40))
    // Still the same line on top: the offset grew by the 10 new lines.
    expect(scroll.offset).toBe(16)
    expect(topRow(view, scroll.offset)).toBe('line 16')
    expect(scroll.toBottom()).toBe(true)
    expect(scroll.offset).toBe(0)
    await write(view, numbered(41, 45))
    expect(scroll.offset).toBe(0)
    expect(topRow(view, scroll.offset)).toBe('line 37')
    view.dispose()
  })

  it('keeps the oldest line when the pinned one is trimmed off the top', async () => {
    const view = createTermView({ cols: 20, rows: 5, scrollback: 20 })
    const scroll = createScrollback(view)
    await write(view, numbered(1, 30))
    scroll.toTop()
    const oldest = topRow(view, scroll.offset)
    await write(view, numbered(31, 35))
    // The pinned line is gone: the view shows the oldest line kept, still scrolled back.
    expect(scroll.scrolled).toBe(true)
    expect(scroll.offset).toBe(scroll.available)
    expect(topRow(view, scroll.offset)).not.toBe(oldest)
    view.dispose()
  })

  it('a cleared screen or scrollback returns to the live view', async () => {
    const view = createTermView({ cols: 20, rows: 5, scrollback: 100 })
    const scroll = createScrollback(view)
    await write(view, numbered(1, 30))
    scroll.scrollBy(4)
    await write(view, '\x1b[3J')
    expect(scroll.scrolled).toBe(false)
    await write(view, numbered(1, 30))
    scroll.scrollBy(4)
    view.respawn(true)
    await view.flush()
    expect(scroll.scrolled).toBe(false)
    view.dispose()
  })

  it('has no scrollback on the alternate screen and forgets the position there', async () => {
    const view = createTermView({ cols: 20, rows: 5, scrollback: 100 })
    const scroll = createScrollback(view)
    await write(view, numbered(1, 30))
    scroll.scrollBy(4)
    await write(view, '\x1b[?1049h')
    expect(scroll.canScroll()).toBe(false)
    expect(scroll.available).toBe(0)
    expect(scroll.offset).toBe(0)
    expect(scroll.scrollBy(3)).toBe(false)
    await write(view, '\x1b[?1049l')
    expect(scroll.scrolled).toBe(false)
    view.dispose()
  })
})

describe('wheel routing', () => {
  it('goes to the agent when it asked for the mouse, as keys on the alternate screen', () => {
    expect(wheelTarget({ mouseTracking: 'vt200', alternateScreen: false })).toBe('mouse')
    expect(wheelTarget({ mouseTracking: 'any', alternateScreen: true })).toBe('mouse')
    expect(wheelTarget({ mouseTracking: 'none', alternateScreen: true })).toBe('keys')
    expect(wheelTarget({ mouseTracking: 'none', alternateScreen: false })).toBe('scrollback')
  })

  it('reads the modes the agent set', async () => {
    const view = createTermView({ cols: 20, rows: 5 })
    await write(view, '\x1b[?1000h\x1b[?1006h')
    expect(wheelTarget(view.modes())).toBe('mouse')
    await write(view, '\x1b[?1000l\x1b[?1049h')
    expect(wheelTarget(view.modes())).toBe('keys')
    view.dispose()
  })

  it('encodes a notch as cursor keys, in application mode when set', () => {
    expect(wheelKeys('up', { applicationCursorKeys: false })).toBe('\x1b[A\x1b[A\x1b[A')
    expect(wheelKeys('down', { applicationCursorKeys: true }, 1)).toBe('\x1bOB')
  })
})
