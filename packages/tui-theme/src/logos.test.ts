import { describe, expect, it } from 'vitest'
import {
  HARNESS_LOGOS,
  decodePng,
  harnessLogo,
  iterm2Image,
  kittyDelete,
  kittyImage,
  logoBadge,
  logoImage,
  logoPng,
  placeAt,
  sixelImage
} from './logos.js'
import { contrast } from './color.js'
import { lineText, lineWidth, renderLine } from './text.js'
import { createTheme } from './theme.js'

const theme = createTheme({ env: {}, isTTY: true, platform: 'linux', colorLevel: 3, unicode: true })

describe('registry', () => {
  it('ships 16 and 32 px PNGs for every logo except Claude Code', () => {
    for (const id of Object.keys(HARNESS_LOGOS)) {
      if (id === 'claude-code') continue
      for (const px of [16, 32]) {
        const png = logoPng(id, px)
        expect(png, id).toBeDefined()
        const img = decodePng(png as Buffer)
        expect(img.width).toBe(px)
        expect(img.height).toBe(px)
        // Not blank: some opaque pixels.
        let opaque = 0
        for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 200) opaque++
        expect(opaque, id).toBeGreaterThan(px)
      }
    }
  })

  it("Claude Code: no image in any protocol, a CC badge on Claude's orange in every colour mode", () => {
    expect(logoPng('claude-code', 16)).toBeUndefined()
    expect(logoPng('claude-code', 32)).toBeUndefined()
    for (const protocol of ['kitty', 'iterm2', 'sixel'] as const)
      expect(logoImage('claude-code', { protocol })).toBeUndefined()
    const logo = HARNESS_LOGOS['claude-code']
    expect(logo.monogram).toBe('CC')
    expect(logo.brand).toEqual({ r: 0xd9, g: 0x77, b: 0x57 })
    expect(logo.ink).toEqual({ r: 0xff, g: 0xff, b: 0xff })
    expect(contrast(logo.brand, logo.ink)).toBeGreaterThanOrEqual(3)
    for (const mode of ['images', 'glyphs', 'none'] as const)
      expect(lineText(logoBadge(theme, 'claude-code', mode))).toBe('CC')
    const at = (colorLevel: 0 | 1 | 2 | 3, mode: 'glyphs' | 'none' = 'glyphs'): string => {
      const t = createTheme({ env: {}, isTTY: true, platform: 'linux', colorLevel })
      return renderLine(t, logoBadge(t, 'claude-code', mode))
    }
    expect(at(3)).toContain('\x1b[38;2;255;255;255m\x1b[48;2;217;119;87m')
    expect(at(2)).toContain('\x1b[38;5;231m\x1b[48;5;173m')
    expect(at(1)).toContain('\x1b[97m\x1b[41m')
    // NSQ_LOGOS=none stays neutral at every level.
    for (const level of [1, 2, 3] as const)
      expect(at(level, 'none')).not.toMatch(/48;2;217|48;5;173|\[41m/)
    const ascii = createTheme({ env: {}, isTTY: true, platform: 'linux', colorLevel: 0 })
    expect(logoBadge(ascii, 'claude-code')).toEqual([expect.objectContaining({ text: 'CC' })])
    expect(at(0)).not.toContain('\x1b[4') // no background at all without colour
  })

  it('16 colours: only logos with an ansi16 pair are filled', () => {
    const t16 = createTheme({ env: {}, isTTY: true, platform: 'linux', colorLevel: 1 })
    expect(logoBadge(t16, 'codex')).toEqual([{ text: 'Cx', bold: true, fg: 'text' }])
  })

  it('unknown harnesses get the generic command logo', () => {
    expect(harnessLogo('some-new-cli').id).toBe('command')
    expect(logoPng('some-new-cli', 16)).toBeUndefined()
  })

  it('badges are always two cells', () => {
    for (const level of [0, 1, 2, 3] as const) {
      const t = createTheme({ env: {}, isTTY: true, platform: 'linux', colorLevel: level })
      for (const id of Object.keys(HARNESS_LOGOS)) {
        for (const mode of ['images', 'glyphs', 'none'] as const)
          expect(lineWidth(logoBadge(t, id, mode))).toBe(2)
      }
    }
  })

  it('logos: none drops brand colours', () => {
    const [s] = logoBadge(theme, 'claude-code', 'none')
    expect(s.bg).toBe('chipBg')
    const [b] = logoBadge(theme, 'claude-code', 'glyphs')
    expect(b.bg).toEqual(HARNESS_LOGOS['claude-code'].brand)
    expect(lineText(logoBadge(theme, 'codex'))).toBe('Cx')
  })
})

describe('decodePng', () => {
  it('rejects what it does not support', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow()
  })

  it('decodes the brand colour of the Codex logo', () => {
    const img = decodePng(logoPng('codex', 32) as Buffer)
    let best = 0
    for (let i = 0; i < img.data.length; i += 4) {
      const [r, g, b, a] = img.data.subarray(i, i + 4)
      if (a > 250 && Math.abs(r - 0x00) < 24 && Math.abs(g - 0x80) < 24 && Math.abs(b - 0xf7) < 24)
        best++
    }
    expect(best).toBeGreaterThan(20)
  })
})

describe('image protocols', () => {
  const png = logoPng('codex', 32) as Buffer

  it('kitty: transmit+display, no cursor move, no replies, chunked', () => {
    const seq = kittyImage(png, { cols: 2, rows: 1, id: 7 })
    expect(seq.startsWith('\x1b_Ga=T,f=100,t=d,c=2,r=1,C=1,q=2,i=7,m=')).toBe(true)
    expect(seq.endsWith('\x1b\\')).toBe(true)
    const big = kittyImage(Buffer.alloc(10_000, 1))
    const chunks = big.split('\x1b\\').filter(Boolean)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toContain('m=1;')
    expect(chunks[chunks.length - 1].startsWith('\x1b_Gm=0;')).toBe(true)
    for (const c of chunks) expect(c.split(';')[1].length).toBeLessThanOrEqual(4096)
    expect(kittyDelete()).toBe('\x1b_Ga=d,d=a,q=2\x1b\\')
    expect(kittyDelete(7)).toBe('\x1b_Ga=d,d=I,i=7,q=2\x1b\\')
  })

  it('iTerm2: OSC 1337 with size and cell box', () => {
    const seq = iterm2Image(png)
    expect(seq.startsWith('\x1b]1337;File=inline=1;size=')).toBe(true)
    expect(seq).toContain(';width=2;height=1;preserveAspectRatio=1;doNotMoveCursor=1:')
    expect(seq.endsWith('\x07')).toBe(true)
    expect(seq).toContain(png.toString('base64'))
  })

  it('sixel: DCS with transparent background, palette and bands', () => {
    const seq = sixelImage(decodePng(logoPng('codex', 16) as Buffer))
    expect(seq.startsWith('\x1bP0;1;0q"1;1;16;16')).toBe(true)
    expect(seq.endsWith('\x1b\\')).toBe(true)
    expect(seq).toMatch(/#0;2;\d+;\d+;\d+/)
    expect(seq.split('-').length - 1).toBe(3) // 16 px = 3 sixel bands
    // only sixel data characters between the header and the terminator
    const body = seq.slice(seq.indexOf('#'), -2)
    expect(/^[#0-9;!?-~$-]*$/.test(body)).toBe(true)
  })

  it('logoImage picks the protocol and wraps for tmux', () => {
    expect(logoImage('codex', { protocol: 'none' })).toBeUndefined()
    expect(logoImage('codex', { protocol: 'kitty' })?.startsWith('\x1b_G')).toBe(true)
    expect(
      logoImage('codex', { protocol: 'iterm2', tmux: true })?.startsWith('\x1bPtmux;\x1b\x1b]1337')
    ).toBe(true)
    expect(logoImage('codex', { protocol: 'sixel' })?.startsWith('\x1bP0;1;0q')).toBe(true)
    expect(placeAt(3, 5, 'X')).toBe('\x1b7\x1b[3;5HX\x1b8')
  })
})

describe('sixel asset size', () => {
  it('uses 16 px unless the cells are known to fit 32 px', () => {
    const size = (seq: string | undefined): string | undefined => /"1;1;(\d+);/.exec(seq ?? '')?.[1]
    expect(size(logoImage('codex', { protocol: 'sixel' }))).toBe('16')
    expect(size(logoImage('codex', { protocol: 'sixel', cellPx: { width: 9, height: 18 } }))).toBe(
      '16'
    )
    expect(size(logoImage('codex', { protocol: 'sixel', cellPx: { width: 16, height: 32 } }))).toBe(
      '32'
    )
  })
})
