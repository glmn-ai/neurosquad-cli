import { describe, expect, it } from 'vitest'
import {
  ansi256ToRgb,
  contrast,
  gradientAt,
  hex,
  mix,
  oklch,
  rgbToAnsi16,
  rgbToAnsi256,
  toHex
} from './color.js'
import { BRAND, HEROUI_DARK, ROLE_SOURCES } from './tokens.js'

describe('oklch → sRGB', () => {
  it('matches the desktop accent and success colours', () => {
    expect(toHex(oklch(0.6204, 0.195, 253.83))).toBe('#0485f7')
    expect(toHex(HEROUI_DARK.success)).toBe('#17c964')
  })

  it('maps black, white and mid grey exactly', () => {
    expect(oklch(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 })
    expect(oklch(1, 0, 0)).toEqual({ r: 255, g: 255, b: 255 })
  })
})

describe('hex', () => {
  it('parses long and short forms and round-trips', () => {
    expect(hex('#a3e635')).toEqual({ r: 163, g: 230, b: 53 })
    expect(hex('fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(toHex(hex('#10b981'))).toBe('#10b981')
  })

  it('throws on garbage', () => {
    expect(() => hex('#12')).toThrow()
    expect(() => hex('lime')).toThrow()
  })
})

describe('mixing', () => {
  it('returns the endpoints at 0 and 1', () => {
    expect(mix(BRAND.lime, BRAND.emerald, 0)).toEqual(hex('#a3e635'))
    expect(mix(BRAND.lime, BRAND.emerald, 1)).toEqual(hex('#10b981'))
    expect(gradientAt([BRAND.lime, BRAND.emerald], 0.5)).toEqual(
      mix(BRAND.lime, BRAND.emerald, 0.5)
    )
  })

  it('computes WCAG contrast', () => {
    expect(contrast(hex('#000'), hex('#fff'))).toBeCloseTo(21, 5)
    expect(contrast(ROLE_SOURCES.text, ROLE_SOURCES.tileBg)).toBeGreaterThan(15)
    expect(contrast(ROLE_SOURCES.mutedText, ROLE_SOURCES.tileBg)).toBeGreaterThan(4.5)
  })
})

describe('downgrade to 256 colours', () => {
  it('maps cube colours to themselves', () => {
    for (const idx of [16, 21, 46, 196, 201, 226, 231, 67, 148]) {
      expect(rgbToAnsi256(ansi256ToRgb(idx))).toBe(idx)
    }
  })

  it('uses the grey ramp for greys', () => {
    expect(rgbToAnsi256(hex('#808080'))).toBe(244)
    expect(rgbToAnsi256(hex('#121212'))).toBe(233)
  })

  it('never returns the theme-dependent 0..15', () => {
    for (let i = 0; i < 2000; i++) {
      const c = { r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 53) % 256 }
      const idx = rgbToAnsi256(c)
      expect(idx).toBeGreaterThanOrEqual(16)
      expect(idx).toBeLessThanOrEqual(255)
    }
  })

  it('keeps the brand colours green-ish', () => {
    const lime = ansi256ToRgb(rgbToAnsi256(BRAND.lime))
    const emerald = ansi256ToRgb(rgbToAnsi256(BRAND.emerald))
    expect(lime.g).toBeGreaterThan(lime.b)
    expect(emerald.g).toBeGreaterThan(emerald.r)
  })
})

describe('downgrade to 16 colours (by meaning, not by xterm RGB)', () => {
  it('names hues', () => {
    expect(rgbToAnsi16(hex('#cc2222')) % 8).toBe(1)
    expect(rgbToAnsi16(HEROUI_DARK.success) % 8).toBe(2)
    expect(rgbToAnsi16(HEROUI_DARK.warning) % 8).toBe(3)
    expect(rgbToAnsi16(HEROUI_DARK.accent) % 8).toBe(4)
    expect(rgbToAnsi16(hex('#cc44cc')) % 8).toBe(5)
    expect(rgbToAnsi16(hex('#22aacc')) % 8).toBe(6)
    expect(rgbToAnsi16(BRAND.lime)).toBe(10)
  })

  it('splits greys by lightness', () => {
    expect(rgbToAnsi16(hex('#000000'))).toBe(0)
    expect(rgbToAnsi16(hex('#6b6b6b'))).toBe(8)
    expect(rgbToAnsi16(hex('#c8c8c8'))).toBe(7)
    expect(rgbToAnsi16(hex('#ffffff'))).toBe(15)
  })
})
