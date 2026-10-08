import { describe, expect, it } from 'vitest'
import { PALETTE, RGB } from './color.js'
import {
  ATTR_BOLD,
  ATTR_INVERSE,
  ATTR_ITALIC,
  ATTR_UNDERLINE,
  gridRowText,
  gridToText
} from './grid.js'
import { FIXTURE_KINDS, loadFixture, makeView, write } from './__test__/helpers.js'
import { createTermView } from './termView.js'

describe('snapshot', () => {
  it('copies text, colours and attributes', async () => {
    const view = makeView()
    await write(
      view,
      'a\x1b[31mb\x1b[38;5;200mc\x1b[38;2;1;2;3md\x1b[0m \x1b[1;3;4;7me\x1b[0m\x1b[44mf'
    )
    const grid = view.snapshot()
    expect(gridRowText(grid, 0)).toBe('abcd ef')
    expect(grid.fg[0]).toBe(0)
    expect(grid.fg[1]).toBe(PALETTE | 1)
    expect(grid.fg[2]).toBe(PALETTE | 200)
    expect(grid.fg[3]).toBe(RGB | 0x010203)
    expect(grid.attrs[5]).toBe(ATTR_BOLD | ATTR_ITALIC | ATTR_UNDERLINE | ATTR_INVERSE)
    expect(grid.bg[6]).toBe(PALETTE | 4)
    expect(grid.cursor).toEqual({ x: 7, y: 0, visible: true })
  })

  it('measures wide, combining and clustered characters (graphemes mode)', async () => {
    const view = makeView({ cols: 30 })
    await write(view, 'A中😀👨‍👩‍👧🇺🇸é❤️|')
    const grid = view.snapshot()
    const cells = []
    for (let x = 0; x < 15; x++) cells.push([grid.chars[x], grid.widths[x]])
    expect(cells).toEqual([
      ['A', 1],
      ['中', 2],
      ['', 0],
      ['😀', 2],
      ['', 0],
      ['👨‍👩‍👧', 2],
      ['', 0],
      ['🇺🇸', 2],
      ['', 0],
      ['é', 1],
      ['❤️', 2],
      ['', 0],
      ['|', 1],
      ['', 1],
      ['', 1]
    ])
  })

  it('measures code point by code point in unicode 11 mode', async () => {
    const view = makeView({ cols: 30, unicode: '11' })
    await write(view, '👨‍👩|')
    const grid = view.snapshot()
    expect(grid.widths[0]).toBe(2)
    expect(grid.widths[2]).toBe(2)
    expect(grid.chars[4]).toBe('|')
  })

  it('shows the alternate screen of a full-screen TUI and returns to the normal one', async () => {
    const view = makeView()
    await write(view, 'shell prompt$ ')
    await write(view, '\x1b[?1049h\x1b[H\x1b[2JTUI frame\x1b[5;1Hstatus')
    let grid = view.snapshot()
    expect(grid.alternate).toBe(true)
    expect(view.modes().alternateScreen).toBe(true)
    expect(gridToText(grid)).toBe('TUI frame\n\n\n\nstatus')
    await write(view, '\x1b[?1049l')
    grid = view.snapshot(grid)
    expect(grid.alternate).toBe(false)
    expect(gridRowText(grid, 0)).toBe('shell prompt$')
  })

  it('reads back scrolled-off lines with scrollOffset', async () => {
    const view = makeView({ rows: 3 })
    await write(view, '1\r\n2\r\n3\r\n4\r\n5')
    expect(gridToText(view.snapshot())).toBe('3\n4\n5')
    const scrolled = view.snapshot(undefined, { scrollOffset: 2 })
    expect(gridToText(scrolled)).toBe('1\n2\n3')
    expect(scrolled.cursor.y).toBe(4)
  })

  it('reuses the grid passed in when the size matches', async () => {
    const view = makeView()
    const first = view.snapshot()
    await write(view, 'x')
    expect(view.snapshot(first)).toBe(first)
    view.resize(30, 5)
    expect(view.snapshot(first)).not.toBe(first)
  })

  it('reports the recent non-blank lines', async () => {
    const view = makeView({ rows: 6 })
    await write(view, 'one\r\n\r\ntwo\r\nthree\r\n')
    expect(view.recentLines(2)).toEqual(['two', 'three'])
  })
})

describe('resize', () => {
  it('only resizes when cols or rows change', () => {
    const view = makeView()
    let changes = 0
    view.onChange(() => changes++)
    expect(view.resize(20, 5)).toBe(false)
    expect(changes).toBe(0)
    expect(view.resize(40, 10)).toBe(true)
    expect([view.cols, view.rows]).toEqual([40, 10])
    expect(changes).toBe(1)
  })

  it('keeps content across a resize', async () => {
    const view = makeView()
    await write(view, 'hello')
    view.resize(10, 3)
    expect(gridRowText(view.snapshot(), 0)).toBe('hello')
  })
})

describe('terminal query replies', () => {
  const QUERIES = '\x1b[c\x1b[6n\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]4;1;?\x07'

  it('the owner answers DA, CPR and colour queries', async () => {
    const view = createTermView({
      cols: 20,
      rows: 5,
      owner: true,
      colors: { foreground: '#ffffff', background: '#000000' }
    })
    const replies: string[] = []
    view.onReply((data) => replies.push(data))
    await write(view, 'ab' + QUERIES)
    expect(replies).toEqual([
      '\x1b[?1;2c',
      '\x1b[1;3R',
      '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
      '\x1b]11;rgb:0000/0000/0000\x1b\\',
      '\x1b]4;1;rgb:cdcd/3131/3131\x1b\\'
    ])
  })

  it('a mirror never answers', async () => {
    const view = makeView()
    const replies: string[] = []
    view.onReply((data) => replies.push(data))
    await write(view, QUERIES)
    expect(replies).toEqual([])
  })

  it('ownership can move between views', async () => {
    const view = makeView()
    const replies: string[] = []
    view.onReply((data) => replies.push(data))
    view.setOwner(true)
    await write(view, '\x1b[c')
    view.setOwner(false)
    await write(view, '\x1b[c')
    expect(replies).toEqual(['\x1b[?1;2c'])
  })

  it('drops answers to questions the replaced process asked', async () => {
    const view = makeView({ owner: true })
    const replies: string[] = []
    view.onReply((data) => replies.push(data))
    view.write('\x1b[6n') // queued, not parsed yet
    view.respawn()
    await view.flush()
    expect(replies).toEqual([])
    await write(view, '\x1b[6n')
    expect(replies).toEqual(['\x1b[1;1R'])
  })

  it('respawn(true) resets the screen', async () => {
    const view = makeView()
    await write(view, 'old\x1b[?2004h')
    view.respawn(true)
    await view.flush()
    expect(gridToText(view.snapshot())).toBe('\n\n\n\n')
    expect(view.modes().bracketedPaste).toBe(false)
  })
})

describe('modes', () => {
  it('tracks input modes and cursor visibility', async () => {
    const view = makeView()
    await write(view, '\x1b[?2004h\x1b[?1004h\x1b[?1h\x1b[?1002h\x1b[?1006h\x1b[?25l')
    expect(view.modes()).toMatchObject({
      bracketedPaste: true,
      sendFocus: true,
      applicationCursorKeys: true,
      mouseTracking: 'drag',
      mouseEncoding: 'sgr',
      cursorVisible: false
    })
    expect(view.snapshot().cursor.visible).toBe(false)
    await write(view, '\x1bc')
    expect(view.modes()).toMatchObject({
      bracketedPaste: false,
      cursorVisible: true,
      mouseEncoding: 'default'
    })
  })
})

describe('sample streams', () => {
  for (const kind of FIXTURE_KINDS) {
    it(`final screen of the fake ${kind} stream`, async () => {
      const cast = loadFixture(kind)
      const view = createTermView({ cols: cast.header.width, rows: cast.header.height })
      for (const event of cast.events) view.write(event.data)
      await view.flush()
      const grid = view.snapshot()
      expect({ alternate: grid.alternate, cursor: grid.cursor }).toMatchSnapshot()
      expect(gridToText(grid)).toMatchSnapshot()
      view.dispose()
    })
  }
})
