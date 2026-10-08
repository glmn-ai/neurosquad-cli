/**
 * Box drawing: border character sets in the shapes Ink and OpenTUI take, and plain line-based
 * renderers for a tile frame, a header / status line and key hints.
 *
 * Tile states (desktop card language): `normal` — quiet grey rounded frame; `focused` — accent
 * frame; `attention` — the needs-you colour. Focus is never colour-only: the focused frame also
 * switches to the heavy line set when colours are scarce (≤ 16), and its title gets a `›` marker.
 */
import { glyphSet } from './glyphs.js'
import type { Rgb } from './color.js'
import { seg, fitLine, lineWidth, type Line, type Seg } from './text.js'
import type { StyleSpec, Theme } from './theme.js'
import type { Role } from './tokens.js'
import { truncate } from './width.js'

/** Ink's `BoxStyle` shape (`<Box borderStyle={…}>`). */
export interface BorderChars {
  topLeft: string
  top: string
  topRight: string
  right: string
  bottomRight: string
  bottom: string
  bottomLeft: string
  left: string
}

/** OpenTUI's `BorderCharacters` shape (`customBorderChars`). */
export interface OpenTuiBorderChars {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  horizontal: string
  vertical: string
  topT: string
  bottomT: string
  leftT: string
  rightT: string
  cross: string
}

export type BorderName = 'rounded' | 'single' | 'heavy' | 'double' | 'ascii'

interface FullSet extends BorderChars {
  teeTop: string
  teeBottom: string
  teeLeft: string
  teeRight: string
  cross: string
}

const SETS: Record<BorderName, FullSet> = {
  rounded: {
    topLeft: '╭',
    top: '─',
    topRight: '╮',
    right: '│',
    bottomRight: '╯',
    bottom: '─',
    bottomLeft: '╰',
    left: '│',
    teeTop: '┬',
    teeBottom: '┴',
    teeLeft: '├',
    teeRight: '┤',
    cross: '┼'
  },
  single: {
    topLeft: '┌',
    top: '─',
    topRight: '┐',
    right: '│',
    bottomRight: '┘',
    bottom: '─',
    bottomLeft: '└',
    left: '│',
    teeTop: '┬',
    teeBottom: '┴',
    teeLeft: '├',
    teeRight: '┤',
    cross: '┼'
  },
  heavy: {
    topLeft: '┏',
    top: '━',
    topRight: '┓',
    right: '┃',
    bottomRight: '┛',
    bottom: '━',
    bottomLeft: '┗',
    left: '┃',
    teeTop: '┳',
    teeBottom: '┻',
    teeLeft: '┣',
    teeRight: '┫',
    cross: '╋'
  },
  double: {
    topLeft: '╔',
    top: '═',
    topRight: '╗',
    right: '║',
    bottomRight: '╝',
    bottom: '═',
    bottomLeft: '╚',
    left: '║',
    teeTop: '╦',
    teeBottom: '╩',
    teeLeft: '╠',
    teeRight: '╣',
    cross: '╬'
  },
  ascii: {
    topLeft: '+',
    top: '-',
    topRight: '+',
    right: '|',
    bottomRight: '+',
    bottom: '-',
    bottomLeft: '+',
    left: '|',
    teeTop: '+',
    teeBottom: '+',
    teeLeft: '+',
    teeRight: '+',
    cross: '+'
  }
}

/** Ink-shaped border set. */
export function borderChars(name: BorderName): BorderChars {
  const s = SETS[name]
  return {
    topLeft: s.topLeft,
    top: s.top,
    topRight: s.topRight,
    right: s.right,
    bottomRight: s.bottomRight,
    bottom: s.bottom,
    bottomLeft: s.bottomLeft,
    left: s.left
  }
}

/** OpenTUI-shaped border set. */
export function openTuiBorderChars(name: BorderName): OpenTuiBorderChars {
  const s = SETS[name]
  return {
    topLeft: s.topLeft,
    topRight: s.topRight,
    bottomLeft: s.bottomLeft,
    bottomRight: s.bottomRight,
    horizontal: s.top,
    vertical: s.left,
    topT: s.teeTop,
    bottomT: s.teeBottom,
    leftT: s.teeLeft,
    rightT: s.teeRight,
    cross: s.cross
  }
}

export type TileState = 'normal' | 'focused' | 'attention'

export interface TileStyle {
  border: BorderName
  /** Border colour role. */
  color: Role
  /** Title colour role. */
  titleColor: Role
  titleBold: boolean
}

/** How a tile in `state` is drawn on this theme. */
export function tileStyle(theme: Theme, state: TileState): TileStyle {
  if (!theme.unicode) {
    return {
      border: 'ascii',
      color: state === 'normal' ? 'border' : state === 'focused' ? 'focusBorder' : 'needsYou',
      titleColor: state === 'normal' ? 'mutedText' : 'text',
      titleBold: state !== 'normal'
    }
  }
  const scarce = theme.level <= 1
  switch (state) {
    case 'focused':
      return {
        border: scarce ? 'heavy' : 'rounded',
        color: 'focusBorder',
        titleColor: 'text',
        titleBold: true
      }
    case 'attention':
      return {
        border: scarce ? 'double' : 'rounded',
        color: 'needsYou',
        titleColor: 'needsYou',
        titleBold: true
      }
    default:
      return { border: 'rounded', color: 'border', titleColor: 'mutedText', titleBold: false }
  }
}

export interface FrameOptions {
  width: number
  height: number
  state?: TileState
  /** Segments placed in the top border after the corner (logo, name, …). */
  title?: Line
  /** Segments right-aligned in the top border (elapsed time, cost). */
  titleRight?: Line
  /** Segments in the bottom border (hint, last line). */
  footer?: Line
  /** Body lines (already styled); fitted to the inner width. */
  body?: Line[]
  /** Body background role (defaults to `tileBg`). */
  bg?: Role
  /** Override the border colour (e.g. a pulsing needs-you colour from `animations`). */
  borderColor?: Role | Rgb
}

/**
 * A complete tile frame as `height` lines of exactly `width` cells:
 * `╭─ title ─────── right ─╮ / │ body │ / ╰─ footer ─────╯`.
 */
export function frame(theme: Theme, o: FrameOptions): Line[] {
  const width = Math.max(4, o.width)
  const height = Math.max(2, o.height)
  const style = tileStyle(theme, o.state ?? 'normal')
  const b = SETS[style.border]
  const bg: Role = o.bg ?? 'tileBg'
  const bc: StyleSpec = { fg: o.borderColor ?? style.color, bg }
  const inner = width - 2
  const g = glyphSet(theme.unicode)

  const borderRow = (
    left: string,
    right: string,
    fill: string,
    content?: Line,
    contentRight?: Line,
    isTitle = false
  ): Line => {
    const row: Line = [seg(left, bc)]
    let used = 0
    if (content && content.length) {
      const marker =
        o.state === 'focused' && isTitle
          ? [seg(g.chevronRight, { ...bc, fg: 'focusBorder', bold: true })]
          : []
      const head: Line = [seg(fill, bc), ...marker, seg(' ', { bg }), ...content, seg(' ', { bg })]
      const maxHead = Math.max(0, inner - 2 - (contentRight ? lineWidth(contentRight) + 3 : 0))
      const fitted = lineWidth(head) > maxHead ? fitLine(head, maxHead, bg) : head
      row.push(...fitted)
      used += lineWidth(fitted)
    }
    const tail: Line =
      contentRight && contentRight.length
        ? [seg(' ', { bg }), ...contentRight, seg(' ', { bg }), seg(fill, bc)]
        : []
    const tailW = lineWidth(tail)
    const gap = Math.max(0, inner - used - tailW)
    row.push(seg(fill.repeat(gap), bc))
    if (used + gap + tailW <= inner) row.push(...tail)
    row.push(seg(right, bc))
    return fitLine(row, width, bg)
  }

  const titled: Line | undefined = o.title?.map((s) => ({
    fg: style.titleColor,
    bold: style.titleBold,
    ...s,
    bg: s.bg ?? bg
  }))
  const lines: Line[] = [
    borderRow(
      b.topLeft,
      b.topRight,
      b.top,
      titled,
      o.titleRight?.map((s) => ({ ...s, bg: s.bg ?? bg })),
      true
    )
  ]
  for (let i = 0; i < height - 2; i++) {
    const body = o.body?.[i] ?? []
    lines.push([
      seg(b.left, bc),
      ...fitLine(
        body.map((s) => ({ ...s, bg: s.bg ?? bg })),
        inner,
        bg
      ),
      seg(b.right, bc)
    ])
  }
  lines.push(
    borderRow(
      b.bottomLeft,
      b.bottomRight,
      b.bottom,
      o.footer?.map((s) => ({ fg: 'mutedText', ...s, bg: s.bg ?? bg }))
    )
  )
  return lines
}

/** A horizontal rule `────` in the separator colour. */
export function rule(theme: Theme, width: number, bg: Role = 'appBg'): Line {
  return [seg((theme.unicode ? '─' : '-').repeat(Math.max(0, width)), { fg: 'separator', bg })]
}

/** Key hint chip: ` ⏎ ` in a chip, then the label in muted text. */
export function keyHint(key: string, label: string, bg: Role = 'headerBg'): Line {
  return [
    seg(` ${key} `, { fg: 'text', bg: 'chipBg', bold: true }),
    seg(` ${label}  `, { fg: 'mutedText', bg })
  ]
}

/**
 * A full-width header / status line: `left` from the start, `right` flush to the end, both on the
 * header background. Left content is truncated first.
 */
export function statusLine(
  theme: Theme,
  width: number,
  left: Line,
  right: Line = [],
  bg: Role = 'headerBg'
): Line {
  const withBg = (l: Line): Line => l.map((s) => ({ ...s, bg: s.bg ?? bg }))
  const r = withBg(right)
  const rw = lineWidth(r)
  const l = fitLine(withBg([seg(' ', { bg }), ...left]), Math.max(0, width - rw - 1), bg)
  return fitLine([...l, ...r, seg(' ', { bg })], width, bg)
}

/** A small label pill: `[ NEEDS YOU ]`-like, coloured background. */
export function badge(text: string, fg: Role | Rgb, bg: Role | Rgb, bold = true): Seg {
  return seg(` ${text} `, { fg, bg, bold })
}

/** Truncates a plain title to fit a tile of `width`. */
export function tileTitle(text: string, width: number, ellipsis = '…'): string {
  return truncate(text, Math.max(0, width - 8), ellipsis)
}
