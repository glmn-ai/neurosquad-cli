import { describe, expect, it } from 'vitest'
import { borderChars, openTuiBorderChars, type BorderName } from './borders.js'
import { ASCII_GLYPHS, UNICODE_GLYPHS } from './glyphs.js'
import { HARNESS_LOGOS } from './logos.js'
import { fit, graphemeWidth, stringWidth, stripAnsi, truncate } from './width.js'

const RGI = new RegExp('^\\p{RGI_Emoji}$', 'v')

describe('stringWidth', () => {
  it('counts ASCII and East Asian wide characters', () => {
    expect(stringWidth('nsq')).toBe(3)
    expect(stringWidth('漢字')).toBe(4)
    expect(stringWidth('ｱｲ')).toBe(2) // halfwidth katakana
    expect(stringWidth('ＡＢ')).toBe(4) // fullwidth latin
    expect(stringWidth('한국어')).toBe(6)
  })

  it('counts emoji presentation as two cells, text presentation as one', () => {
    expect(stringWidth('👍')).toBe(2)
    expect(stringWidth('👍🏽')).toBe(2) // skin tone modifier
    expect(stringWidth('👨\u200d👩\u200d👧')).toBe(2) // ZWJ sequence
    expect(stringWidth('🇺🇦')).toBe(2) // flag
    expect(stringWidth('✔')).toBe(1)
    expect(stringWidth('✔\ufe0f')).toBe(2) // VS16 asks for emoji presentation
    expect(stringWidth('❤')).toBe(1)
    expect(stringWidth('❤\ufe0f')).toBe(2)
    expect(stringWidth('⚠')).toBe(1)
  })

  it('ignores combining marks, ZWJ and variation selectors', () => {
    expect(stringWidth('e\u0301')).toBe(1)
    expect(stringWidth('a\u200db')).toBe(2)
    expect(stringWidth('x\ufe0e')).toBe(1)
  })

  it('ignores ANSI escapes', () => {
    expect(stringWidth('\x1b[38;2;1;2;3mok\x1b[0m')).toBe(2)
    expect(stringWidth('\x1b]8;;https://x\x07link\x1b]8;;\x07')).toBe(4)
    expect(stripAnsi('\x1b_Ga=T;AAAA\x1b\\a')).toBe('a')
  })

  it('counts East Asian ambiguous characters as one unless asked', () => {
    expect(stringWidth('●─█')).toBe(3)
    expect(stringWidth('●─█', { ambiguousWide: true })).toBe(6)
  })
})

describe('truncate / fit', () => {
  it('never splits a wide character', () => {
    expect(truncate('漢字漢字', 5)).toBe('漢字…')
    expect(stringWidth(truncate('漢字漢字', 4))).toBeLessThanOrEqual(4)
    expect(truncate('ab漢', 3, '')).toBe('ab ')
  })

  it('keeps emoji sequences whole', () => {
    expect(truncate('👨\u200d👩\u200d👧👨\u200d👩\u200d👧x', 4)).toBe('👨\u200d👩\u200d👧… ')
  })

  it('fits to an exact width', () => {
    for (const s of ['hello world', '漢字テキスト', 'a👍b', '']) {
      for (const w of [0, 1, 3, 6, 12]) expect(stringWidth(fit(s, w))).toBe(w)
    }
    expect(fit('ab', 4, 'right')).toBe('  ab')
    expect(fit('ab', 5, 'center')).toBe(' ab  ')
  })
})

describe('our glyphs are safe', () => {
  const unicode = [
    ...Object.values(UNICODE_GLYPHS.status),
    ...UNICODE_GLYPHS.spinner,
    ...UNICODE_GLYPHS.sparkle,
    ...[...UNICODE_GLYPHS.scramble],
    UNICODE_GLYPHS.bullet,
    UNICODE_GLYPHS.separator,
    UNICODE_GLYPHS.chevronRight,
    UNICODE_GLYPHS.chevronDown,
    UNICODE_GLYPHS.arrowUp,
    UNICODE_GLYPHS.arrowDown,
    UNICODE_GLYPHS.enter,
    UNICODE_GLYPHS.check,
    UNICODE_GLYPHS.cross
  ]

  it('every Unicode glyph is one cell and never an emoji by default', () => {
    for (const g of unicode) {
      expect(graphemeWidth(g), g).toBe(1)
      expect(RGI.test(g), g).toBe(false)
    }
  })

  it('every border character is one cell', () => {
    for (const name of ['rounded', 'single', 'heavy', 'double', 'ascii'] as BorderName[]) {
      for (const ch of [
        ...Object.values(borderChars(name)),
        ...Object.values(openTuiBorderChars(name))
      ]) {
        expect(stringWidth(ch), `${name} ${ch}`).toBe(1)
      }
    }
  })

  it('the ASCII set is pure printable ASCII (safe on ambiguous-wide and legacy consoles)', () => {
    const all = [
      ...Object.values(ASCII_GLYPHS.status),
      ...ASCII_GLYPHS.spinner,
      ...ASCII_GLYPHS.sparkle,
      ASCII_GLYPHS.scramble,
      ASCII_GLYPHS.bullet,
      ASCII_GLYPHS.separator,
      ASCII_GLYPHS.check,
      ASCII_GLYPHS.cross
    ]
    for (const g of all) expect(/^[\x20-\x7e]+$/.test(g), g).toBe(true)
    for (const ch of Object.values(borderChars('ascii')))
      expect(/^[\x20-\x7e]$/.test(ch)).toBe(true)
  })

  it('logo monograms are exactly two ASCII cells', () => {
    for (const logo of Object.values(HARNESS_LOGOS)) {
      expect(/^[\x21-\x7e]{2}$/.test(logo.monogram), logo.id).toBe(true)
    }
  })
})
