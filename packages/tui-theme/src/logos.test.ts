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
import { lineText, lineWidth } from './text.js'
import { createTheme } from './theme.js'

const theme = createTheme({ env: {}, isTTY: true, platform: 'linux', colorLevel: 3, unicode: true })

describe('registry', () => {
  it('ships 16 and 32 px PNGs for every logo', () => {
    for (const id of Object.keys(HARNESS_LOGOS)) {
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

  it('decodes the brand colour of the Claude Code logo', () => {
    const img = decodePng(logoPng('claude-code', 32) as Buffer)
    let best = 0
    for (let i = 0; i < img.data.length; i += 4) {
      const [r, g, b, a] = img.data.subarray(i, i + 4)
      if (a > 250 && Math.abs(r - 217) < 8 && Math.abs(g - 119) < 8 && Math.abs(b - 87) < 8) best++
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
    const seq = sixelImage(decodePng(logoPng('claude-code', 16) as Buffer))
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
