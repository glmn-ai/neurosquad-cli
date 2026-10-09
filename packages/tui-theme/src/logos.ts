/**
 * Harness logos: a registry (brand colour + two-cell monogram + embedded PNGs), encoders for the
 * three terminal image protocols (kitty graphics, iTerm2 inline images, sixel), and the glyph
 * badge fallback.
 *
 * Trademarks: each logo identifies the CLI it belongs to and is the property of its owner; see
 * the package README. Claude Code has no image, only a "CC" monogram badge on Claude's orange — no
 * Claude Code logo, at Anthropic's request. `logos: 'none'` draws neutral badges with no brand marks
 * or colours.
 *
 * Adding a harness: an entry in `HARNESS_LOGOS` (+ its PNGs via `scripts/gen-logos.py`). Without
 * PNGs it still gets a glyph badge, and `logoImage` returns undefined (callers keep the badge).
 */
import { inflateSync } from 'node:zlib'
import { contrast, hex, type Ansi16, type Rgb } from './color.js'
import { wrapForTmux, type GraphicsProtocol } from './capabilities.js'
import { LOGO_PNG_BASE64 } from './logos.generated.js'
import { seg, type Line } from './text.js'
import type { LogoMode, Theme } from './theme.js'
import { ROLE_SOURCES } from './tokens.js'

export interface HarnessLogo {
  readonly id: string
  readonly name: string
  /** The colour the badge is filled with (the brand's own primary colour). */
  readonly brand: Rgb
  /** Two ASCII characters drawn on the badge. ASCII on purpose: always exactly 2 cells. */
  readonly monogram: string
  /** Text colour on the badge; default = whichever of near-black / white contrasts more. */
  readonly ink?: Rgb
  /**
   * The badge at 16 colours: the ANSI background and ink. Optional — without it the 16-colour badge
   * is the bold monogram on the default background, because terminal themes re-paint the 16
   * colours and only a pair checked by hand is safe to fill with.
   */
  readonly ansi16?: { readonly bg: Exclude<Ansi16, -1>; readonly ink: Exclude<Ansi16, -1> }
}

export const HARNESS_LOGOS = {
  // Claude Code: a plain "CC" monogram on Claude's orange — no image, no Claude Code logo or mark
  // (Anthropic asked us not to use the Claude Code logo). `logos: 'images'` falls back to this
  // glyph badge. White ink: 3.1:1 on #d97757 (WCAG >= 3:1 for bold text; cream falls short).
  // 256 colours: 173 on 231. 16 colours: red (the hue bucket `rgbToAnsi16` puts #d97757 in) with
  // bright white.
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    brand: hex('#d97757'),
    monogram: 'CC',
    ink: hex('#ffffff'),
    ansi16: { bg: 1, ink: 15 }
  },
  codex: { id: 'codex', name: 'Codex', brand: hex('#0080f7'), monogram: 'Cx' },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    brand: hex('#f1ecec'),
    monogram: 'Oc',
    ink: hex('#131010')
  },
  command: {
    id: 'command',
    name: 'Command',
    brand: hex('#34343a'),
    monogram: '>_',
    ink: hex('#e8e8ec')
  }
} as const satisfies Record<string, HarnessLogo>

export type HarnessLogoId = keyof typeof HARNESS_LOGOS

/** The logo for an id, or the generic command logo. */
export function harnessLogo(id: string): HarnessLogo {
  return (HARNESS_LOGOS as Record<string, HarnessLogo>)[id] ?? HARNESS_LOGOS.command
}

const NEAR_BLACK = hex('#111114')
const WHITE = hex('#ffffff')

function inkFor(logo: HarnessLogo): Rgb {
  if (logo.ink) return logo.ink
  return contrast(logo.brand, NEAR_BLACK) >= contrast(logo.brand, WHITE) ? NEAR_BLACK : WHITE
}

/**
 * The two-cell glyph badge: the monogram on the brand colour (`logos: 'glyphs'`, and the fallback
 * for `'images'`), or on a neutral chip (`'none'`). At 16 colours a logo with an `ansi16` pair is
 * filled with it; otherwise (and with colour off) the monogram is bold on the default background —
 * still two cells, still readable.
 */
export function logoBadge(theme: Theme, id: string, mode: LogoMode = theme.logos): Line {
  const logo = harnessLogo(id)
  if (theme.level === 1 && logo.ansi16 && mode !== 'none') {
    // An Rgb with an `ansi16` field: `resolveColor` takes the given ANSI colour as is.
    const fg = { ...inkFor(logo), ansi16: logo.ansi16.ink }
    const bg = { ...logo.brand, ansi16: logo.ansi16.bg }
    return [seg(logo.monogram, { fg, bg, bold: true })]
  }
  if (theme.level <= 1)
    return [seg(logo.monogram, { bold: true, fg: theme.level === 1 ? 'text' : undefined })]
  if (mode === 'none') return [seg(logo.monogram, { fg: 'mutedText', bg: 'chipBg', bold: true })]
  return [seg(logo.monogram, { fg: inkFor(logo), bg: logo.brand, bold: true })]
}

/** Embedded PNG bytes of a logo (closest size ≥ `px`, else the largest), or undefined. */
export function logoPng(id: string, px: number): Buffer | undefined {
  const sizes = LOGO_PNG_BASE64[id]
  if (!sizes) return undefined
  const size = px <= 16 ? 16 : 32
  return Buffer.from(sizes[size], 'base64')
}

// ---- PNG decoding (for sixel) --------------------------------------------------------------

export interface Pixels {
  width: number
  height: number
  /** RGBA, row-major. */
  data: Uint8Array
}

/**
 * Decodes the PNGs we ship: 8-bit RGBA or RGB, non-interlaced (what `gen-logos.py` writes).
 * Throws on anything else — it is not a general PNG decoder.
 */
export function decodePng(png: Buffer): Pixels {
  const sig = png.subarray(0, 8).toString('latin1')
  if (sig !== '\x89PNG\r\n\x1a\n') throw new Error('Not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos < png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.subarray(pos + 4, pos + 8).toString('latin1')
    const body = png.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      colorType = body[9]
      const interlace = body[12]
      if (depth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
        throw new Error(
          `Unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`
        )
      }
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`Bad PNG filter ${filter}`)
      cur[x] = v & 255
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      out[o] = cur[x * bpp]
      out[o + 1] = cur[x * bpp + 1]
      out[o + 2] = cur[x * bpp + 2]
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255
    }
    prev.set(cur)
  }
  return { width, height, data: out }
}

// ---- protocol encoders ---------------------------------------------------------------------

export interface ImageCells {
  /** Width in cells the image is scaled to (default 2 — the same footprint as the glyph badge). */
  cols?: number
  /** Height in cells (default 1). */
  rows?: number
}

/**
 * kitty graphics protocol: transmit-and-display a PNG, scaled to `cols × rows` cells, without
 * moving the cursor (`C=1`) and without replies (`q=2`). Chunked at 4096 bytes as the spec asks.
 * Pass `id` to replace an image in place later (and `kittyDelete(id)` to remove it).
 */
export function kittyImage(png: Buffer, cells: ImageCells & { id?: number } = {}): string {
  const b64 = png.toString('base64')
  const cols = cells.cols ?? 2
  const rows = cells.rows ?? 1
  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096))
  const id = cells.id !== undefined ? `,i=${cells.id}` : ''
  return chunks
    .map((c, i) => {
      const more = i < chunks.length - 1 ? 1 : 0
      const keys =
        i === 0 ? `a=T,f=100,t=d,c=${cols},r=${rows},C=1,q=2${id},m=${more}` : `m=${more}`
      return `\x1b_G${keys};${c}\x1b\\`
    })
    .join('')
}

/** Deletes kitty images: one by id, or every image placed on screen when `id` is omitted. */
export function kittyDelete(id?: number): string {
  return id === undefined ? '\x1b_Ga=d,d=a,q=2\x1b\\' : `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`
}

/** iTerm2 inline image (OSC 1337), also understood by WezTerm, VS Code and others. */
export function iterm2Image(png: Buffer, cells: ImageCells = {}): string {
  const cols = cells.cols ?? 2
  const rows = cells.rows ?? 1
  return (
    `\x1b]1337;File=inline=1;size=${png.length};width=${cols};height=${rows};preserveAspectRatio=1;doNotMoveCursor=1:` +
    `${png.toString('base64')}\x07`
  )
}

/**
 * Sixel image. Pixels with alpha < 50 % stay transparent (`P2=1`); partial alpha is blended over
 * `bg` (the tile background). Colours are reduced to at most 255 registers by 5-bit rounding.
 */
export function sixelImage(pixels: Pixels, bg: Rgb = ROLE_SOURCES.tileBg): string {
  const { width, height, data } = pixels
  const palette = new Map<number, number>()
  const index = new Int16Array(width * height).fill(-1)
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255
    if (a < 0.5) continue
    const r = Math.round(data[i * 4] * a + bg.r * (1 - a))
    const g = Math.round(data[i * 4 + 1] * a + bg.g * (1 - a))
    const b = Math.round(data[i * 4 + 2] * a + bg.b * (1 - a))
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    let reg = palette.get(key)
    if (reg === undefined) {
      if (palette.size >= 255) {
        // Out of registers: reuse the closest existing one.
        let best = 0
        let bestD = Infinity
        for (const [k, v] of palette) {
          const d =
            (((k >> 10) & 31) - (r >> 3)) ** 2 +
            (((k >> 5) & 31) - (g >> 3)) ** 2 +
            ((k & 31) - (b >> 3)) ** 2
          if (d < bestD) {
            bestD = d
            best = v
          }
        }
        reg = best
      } else {
        reg = palette.size
        palette.set(key, reg)
      }
    }
    index[i] = reg
  }
  let out = `\x1bP0;1;0q"1;1;${width};${height}`
  for (const [key, reg] of palette) {
    const pct = (v: number): number => Math.round((((v << 3) | (v >> 2)) * 100) / 255)
    out += `#${reg};2;${pct((key >> 10) & 31)};${pct((key >> 5) & 31)};${pct(key & 31)}`
  }
  for (let band = 0; band < height; band += 6) {
    const parts: string[] = []
    for (const reg of palette.values()) {
      let row = ''
      let used = false
      for (let x = 0; x < width; x++) {
        let bits = 0
        for (let k = 0; k < 6; k++) {
          const y = band + k
          if (y < height && index[y * width + x] === reg) bits |= 1 << k
        }
        if (bits) used = true
        row += String.fromCharCode(63 + bits)
      }
      if (used) parts.push(`#${reg}${rle(row)}`)
    }
    out += parts.join('$') + '-'
  }
  return out + '\x1b\\'
}

function rle(row: string): string {
  let out = ''
  let i = 0
  while (i < row.length) {
    let j = i
    while (j < row.length && row[j] === row[i]) j++
    const n = j - i
    out += n > 3 ? `!${n}${row[i]}` : row[i].repeat(n)
    i = j
  }
  return out
}

export interface LogoImageOptions extends ImageCells {
  protocol: GraphicsProtocol
  /** Wrap for tmux passthrough. */
  tmux?: boolean
  /** Cell size in pixels, when known (from `queryGraphics`) — picks the 16 or 32 px asset for sixel. */
  cellPx?: { width: number; height: number }
  /** kitty image id (to replace / delete it later). */
  id?: number
  bg?: Rgb
}

/**
 * The escape sequence that draws a harness logo at the cursor, or undefined when the protocol is
 * `none` or the harness has no image. Write it after the frame, with the cursor parked on the
 * badge cells (see `placeAt`); kitty and iTerm2 leave the cursor where it was, sixel does not.
 */
export function logoImage(id: string, o: LogoImageOptions): string | undefined {
  if (o.protocol === 'none') return undefined
  const rows = o.rows ?? 1
  // Sixel is drawn at its native pixel size, so pick the largest asset that fits the badge's cells
  // (16 px when the cell size is unknown). kitty and iTerm2 scale to the cell box themselves.
  const cols = o.cols ?? 2
  const fit = o.cellPx ? Math.min(rows * o.cellPx.height, cols * o.cellPx.width) : 16
  const png = logoPng(id, o.protocol === 'sixel' ? (fit >= 32 ? 32 : 16) : 32)
  if (!png) return undefined
  let seq: string
  if (o.protocol === 'kitty') seq = kittyImage(png, o)
  else if (o.protocol === 'iterm2') seq = iterm2Image(png, o)
  else seq = sixelImage(decodePng(png), o.bg)
  return o.tmux ? wrapForTmux(seq) : seq
}

/** Saves the cursor, moves to 1-based `row`/`col`, writes `seq`, restores the cursor. */
export function placeAt(row: number, col: number, seq: string): string {
  return `\x1b7\x1b[${row};${col}H${seq}\x1b8`
}
