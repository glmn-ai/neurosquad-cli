import { describe, expect, it } from 'vitest'
import { frame, statusLine, tileStyle } from './borders.js'
import type { ColorLevel } from './color.js'
import { STATUS_ORDER, STATUS_STYLE, UNICODE_GLYPHS } from './glyphs.js'
import {
  diffFrames,
  fitLine,
  lineText,
  lineWidth,
  overlay,
  renderLine,
  seg,
  sliceLine
} from './text.js'
import { createTheme } from './theme.js'
import { stringWidth } from './width.js'
import { wordmark, wordmarkWidth } from './wordmark.js'

const themeAt = (colorLevel: ColorLevel, unicode = true) =>
  createTheme({ env: {}, isTTY: true, platform: 'linux', colorLevel, unicode })

describe('createTheme', () => {
  it('emits the right SGR form per level', () => {
    expect(themeAt(3).colors.accent.fg).toBe('\x1b[38;2;4;133;247m')
    expect(themeAt(2).colors.accent.fg).toBe('\x1b[38;5;33m')
    expect(themeAt(1).colors.accent.fg).toBe('\x1b[94m')
    expect(themeAt(1).colors.tileBg.bg).toBe('\x1b[49m')
    expect(themeAt(0).colors.accent.fg).toBe('')
  })

  it('gives Ink a colour value it understands at each level', () => {
    expect(themeAt(3).colors.success.ink).toBe('#17c964')
    expect(themeAt(2).colors.success.ink).toBe('ansi256(41)')
    expect(themeAt(1).colors.success.ink).toBe('greenBright')
    expect(themeAt(1).colors.appBg.ink).toBeUndefined()
    expect(themeAt(0).colors.success.ink).toBeUndefined()
  })

  it('reads NSQ_LOGOS and NO_COLOR', () => {
    expect(createTheme({ env: { NSQ_LOGOS: 'none' }, isTTY: true, platform: 'linux' }).logos).toBe(
      'none'
    )
    const t = createTheme({
      env: { NO_COLOR: '1', TERM: 'xterm-256color' },
      isTTY: true,
      platform: 'linux'
    })
    expect(t.level).toBe(0)
    expect(t.paint('x', { fg: 'accent', bold: true })).toBe('\x1b[1mx\x1b[0m') // bold is not colour
  })

  it('writes plain text to a pipe', () => {
    const t = createTheme({ env: { TERM: 'xterm-256color' }, isTTY: false, platform: 'linux' })
    expect(t.paint('x', { fg: 'accent', bold: true })).toBe('x')
  })

  it('an ambiguous-wide terminal gets ASCII glyphs', () => {
    expect(
      createTheme({
        env: { NSQ_AMBIGUOUS_WIDE: '1', TERM: 'xterm-256color' },
        isTTY: true,
        platform: 'linux'
      }).unicode
    ).toBe(false)
  })
})

describe('status vocabulary', () => {
  it('every status has a distinct glyph and label (never colour-only)', () => {
    const glyphs = new Set(STATUS_ORDER.map((s) => UNICODE_GLYPHS.status[s]))
    const labels = new Set(STATUS_ORDER.map((s) => STATUS_STYLE[s].label))
    expect(glyphs.size).toBe(5)
    expect(labels.size).toBe(5)
    expect(STATUS_ORDER[0]).toBe('needs-input')
  })
})

describe('frame', () => {
  for (const level of [0, 1, 2, 3] as ColorLevel[]) {
    for (const unicode of [true, false]) {
      it(`draws exact-width lines (level ${level}, ${unicode ? 'unicode' : 'ascii'})`, () => {
        const theme = themeAt(level, unicode)
        for (const state of ['normal', 'focused', 'attention'] as const) {
          const lines = frame(theme, {
            width: 30,
            height: 6,
            state,
            title: [seg('漢字 very long title that will not fit at all')],
            titleRight: [seg('12m $1.87')],
            footer: [seg('● NEEDS YOU')],
            body: [[seg('hello')], [seg('a much longer body line that overflows the tile width')]]
          })
          expect(lines).toHaveLength(6)
          for (const l of lines) expect(lineWidth(l)).toBe(30)
          for (const l of lines) expect(stringWidth(renderLine(theme, l))).toBe(30)
        }
      })
    }
  }

  it('focus is not colour-only on scarce palettes', () => {
    expect(tileStyle(themeAt(1), 'focused').border).toBe('heavy')
    expect(tileStyle(themeAt(1), 'attention').border).toBe('double')
    expect(tileStyle(themeAt(3), 'focused').border).toBe('rounded')
    const focused = frame(themeAt(3), { width: 20, height: 3, state: 'focused', title: [seg('a')] })
    expect(lineText(focused[0])).toContain('›')
  })

  it('statusLine fills the width', () => {
    const l = statusLine(
      themeAt(3),
      40,
      [seg('left side that is long enough to be cut')],
      [seg('right')]
    )
    expect(lineWidth(l)).toBe(40)
    expect(lineText(l).trimEnd().endsWith('right')).toBe(true)
  })
})

describe('text helpers', () => {
  it('fitLine pads and cuts', () => {
    expect(lineText(fitLine([seg('abc')], 5))).toBe('abc  ')
    expect(lineText(fitLine([seg('ab'), seg('漢字')], 3))).toBe('ab ')
  })

  it('sliceLine and overlay work in cells', () => {
    const base = [[seg('0123456789')], [seg('abcdefghij')]]
    expect(lineText(sliceLine(base[0], 2, 5))).toBe('234')
    const out = overlay(base, 3, 1, [[seg('XY')]])
    expect(lineText(out[1])).toBe('abcXYfghij')
    expect(out[0]).toBe(base[0])
  })

  it('diffFrames reports only the changed cells', () => {
    const a = [[seg('ab'), seg('c', { fg: 'accent' }), seg('def')], [seg('same')]]
    const b = [[seg('ab'), seg('X', { fg: 'accent' }), seg('def')], [seg('same')]]
    const spans = diffFrames(a, b)
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ row: 0, col: 2 })
    expect(lineText(spans[0].segs)).toBe('X')
    // style-only change counts too
    const c = [[seg('ab'), seg('c', { fg: 'success' }), seg('def')], [seg('same')]]
    expect(diffFrames(a, c)[0].col).toBe(2)
    // a shorter row blanks the old tail
    const d = [[seg('ab')], [seg('same')]]
    expect(lineText(diffFrames(a, d)[0].segs)).toBe('    ')
    expect(diffFrames(a, a)).toEqual([])
  })
})

describe('wordmark', () => {
  it('is four rows of half-block art, all the same width', () => {
    const lines = wordmark(themeAt(3))
    expect(lines).toHaveLength(4)
    for (const l of lines) expect(lineWidth(l)).toBe(wordmarkWidth())
    expect(lines.flat().some((s) => s.text === '█')).toBe(true)
  })

  it('falls back to one plain line without Unicode', () => {
    const lines = wordmark(themeAt(1, false))
    expect(lines).toHaveLength(1)
    expect(lineText(lines[0])).toBe('>S neurosquad')
  })

  it('mark-only is narrower', () => {
    expect(wordmarkWidth(false)).toBeLessThan(wordmarkWidth(true))
    expect(wordmark(themeAt(3), { word: false })[0].length).toBe(wordmarkWidth(false))
  })
})
