/**
 * `npm run preview -w packages/tui-theme` — prints a demo of the look: the wordmark, a header,
 * the sidebar (workspaces → agents in every status), a 2×2 grid of agent tiles with harness logos,
 * the effects gallery and the palette.
 *
 *   --colors=truecolor|256|16|none   force a colour level (default: detect)
 *   --logos=images|glyphs|none       harness logos (default: images when the terminal can)
 *   --graphics=kitty|iterm2|sixel    force an image protocol (default: detect from env)
 *   --width=<cols>                   layout width (default: terminal width, min 100)
 *   --live                           animate every effect (q / Ctrl+C to quit)
 *   --seconds=<n>                    stop --live after n seconds
 *   --record=<file.cast>             write an asciinema v2 recording of --live (virtual clock)
 *   --at=<ms>                        print one frame of the animation at this time
 *
 * Not part of the package API; excluded from the published files.
 */
import { writeFileSync } from 'node:fs'
import * as anim from './animations/index.js'
import { badge, frame, keyHint, rule, statusLine, type TileState } from './borders.js'
import { detectGraphicsFromEnv, type GraphicsProtocol } from './capabilities.js'
import type { ColorLevel } from './color.js'
import { STATUS_STYLE, glyphSet, type AgentStatus } from './glyphs.js'
import { logoBadge, logoImage, type HarnessLogoId } from './logos.js'
import {
  diffFrames,
  fitLine,
  hjoin,
  overlay,
  renderLine,
  seg,
  type Line,
  type Seg
} from './text.js'
import { createTheme, type LogoMode } from './theme.js'
import { ROLE_SOURCES, type Role } from './tokens.js'
import { compactMark, wordmark } from './wordmark.js'
import { stringWidth } from './width.js'

// ---- args ----------------------------------------------------------------------------------

const args = new Map<string, string>()
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
  if (m) args.set(m[1], m[2] ?? 'true')
}
const LEVELS: Record<string, ColorLevel> = { none: 0, '16': 1, '256': 2, truecolor: 3 }
const colorArg = args.get('colors')
const record = args.get('record')
const theme = createTheme({
  colorLevel: colorArg ? LEVELS[colorArg] : record ? 3 : undefined,
  isTTY: record ? true : undefined,
  logos: args.get('logos') as LogoMode | undefined
})
const graphicsArg = args.get('graphics') as GraphicsProtocol | undefined
const graphics: GraphicsProtocol =
  theme.logos !== 'images' ? 'none' : (graphicsArg ?? detectGraphicsFromEnv(process.env).protocol)
const WIDTH = Math.max(100, Number(args.get('width')) || process.stdout.columns || 120)
const g = glyphSet(theme.unicode)

// ---- demo data -------------------------------------------------------------------------------

interface DemoAgent {
  name: string
  harness: HarnessLogoId
  status: AgentStatus
  branch: string
  elapsed: string
  cost: string
  lines: string[]
}

const AGENTS: DemoAgent[] = [
  {
    name: 'api-fix',
    harness: 'claude-code',
    status: 'needs-input',
    branch: 'wt/api-fix',
    elapsed: '12m',
    cost: '$1.87',
    lines: [
      '● Bash(npm run test:e2e -- --grep checkout)',
      '',
      'Allow Bash: npm run test:e2e -- --grep checkout?',
      '  1. Yes',
      "  2. Yes, and don't ask again",
      '  3. No, tell Claude what to do'
    ]
  },
  {
    name: 'reviewer',
    harness: 'codex',
    status: 'working',
    branch: 'main',
    elapsed: '3m',
    cost: '$0.41',
    lines: [
      '• Reading src/cart.ts',
      '• Reading src/checkout/price.ts',
      '',
      '  The discount is applied twice when a coupon',
      '  and a member price overlap (price.ts:88).'
    ]
  },
  {
    name: 'docs',
    harness: 'opencode',
    status: 'finished',
    branch: 'wt/docs',
    elapsed: '21m',
    cost: '$1.14',
    lines: [
      'Updated README.md and docs/install.md:',
      '  + Windows (winget, Scoop) section',
      '  + troubleshooting for node-pty builds',
      '',
      'Done. 2 files changed, 64 insertions.'
    ]
  },
  {
    name: 'shell',
    harness: 'command',
    status: 'idle',
    branch: '.',
    elapsed: '—',
    cost: '—',
    lines: [
      '~/code/shop $ git status --short',
      ' M src/cart.ts',
      '?? docs/install.md',
      '~/code/shop $ '
    ]
  }
]

const EXITED: DemoAgent = {
  name: 'old-run',
  harness: 'claude-code',
  status: 'exited',
  branch: 'wt/old',
  elapsed: '2h',
  cost: '$0.92',
  lines: []
}

// ---- pieces ----------------------------------------------------------------------------------

/** A logo cell pair; tagged so image escapes can be placed over it afterwards. */
function logo(id: HarnessLogoId, bg: Role): Seg[] {
  const cells = logoBadge(theme, id).map((s) => ({ ...s, bg: s.bg ?? bg }))
  ;(cells[0] as Seg & { logo?: string }).logo = id
  return cells
}

function statusGlyph(a: DemoAgent, now: number | undefined, bg: Role): Seg {
  if (a.status === 'working') return anim.spinner(theme, now, { bg })
  if (a.status === 'needs-input') return anim.attentionDot(theme, now, 500, bg)
  if (a.status === 'finished') return anim.sparkle(theme, now, 2200, bg).seg
  const st = STATUS_STYLE[a.status]
  return seg(g.status[a.status], { fg: st.role, bg })
}

function sidebar(width: number, height: number, now: number | undefined): Line[] {
  const bg: Role = 'sidebarBg'
  const rows: Line[] = []
  const blank = (): Line => [seg('', { bg })]
  rows.push(blank())
  rows.push([seg(' WORKSPACES', { fg: 'mutedText', bg, bold: true })])
  rows.push(blank())
  const ws = (open: boolean, name: string, count: number, selected = false): Line => {
    const fill: Role = selected ? 'selectionBg' : bg
    const line: Line = [
      seg(` ${open ? g.chevronDown : g.chevronRight} `, { fg: 'mutedText', bg: fill }),
      seg(name, { fg: 'text', bg: fill, bold: true })
    ]
    return [
      ...fitLine(line, width - 4, fill),
      seg(String(count).padStart(3) + ' ', { fg: 'mutedText', bg: fill })
    ]
  }
  const agentRow = (a: DemoAgent, selected: boolean): Line => {
    const fill: Role = selected ? 'selectionBg' : bg
    const st = STATUS_STYLE[a.status]
    const label: Seg =
      a.status === 'needs-input'
        ? anim.attentionBadge(theme, now, 500)
        : seg(` ${st.label} `, {
            fg: selected && theme.level <= 1 ? 'selectionFg' : st.role,
            bg: fill
          })
    const left: Line = [
      seg('   ', { bg: fill }),
      statusGlyph(a, now, fill),
      seg(' ', { bg: fill }),
      ...logo(a.harness, fill),
      seg(' ', { bg: fill }),
      seg(a.name, { fg: a.status === 'exited' ? 'faintText' : 'text', bg: fill, bold: selected })
    ]
    const labelW = label.text.length
    return [...fitLine(left, width - labelW - 1, fill), label, seg(' ', { bg: fill })]
  }
  rows.push(ws(true, 'shop', AGENTS.length))
  AGENTS.forEach((a) => rows.push(agentRow(a, a.name === 'reviewer')))
  rows.push(blank())
  rows.push(ws(false, 'blog', 2))
  rows.push(ws(true, 'infra', 1))
  rows.push(agentRow(EXITED, false))
  while (rows.length < height - 2) rows.push(blank())
  rows.push([
    seg(' ', { bg }),
    ...compactMark(theme).map((s) => ({ ...s, bg })),
    seg(`  nsq 0.1.0`, { fg: 'faintText', bg })
  ])
  rows.push(blank())
  return rows.slice(0, height).map((l) => fitLine(l, width, bg))
}

function tileFor(
  a: DemoAgent,
  width: number,
  height: number,
  state: TileState,
  now: number | undefined,
  enterAt?: number
): Line[] {
  const st = STATUS_STYLE[a.status]
  const title: Line = [
    ...logo(a.harness, 'tileBg'),
    seg(' '),
    seg(a.name, { bold: true }),
    seg(` ${g.separator} ${a.branch}`, { fg: 'mutedText', bold: false })
  ]
  const right: Line = [seg(`${a.elapsed}  ${a.cost}`, { fg: 'mutedText' })]
  const body: Line[] = a.lines.map((l, i) => {
    if (a.status === 'needs-input' && i === 2) return [seg(l, { fg: 'warning', bold: true })]
    if (a.status === 'needs-input' && i === 0) return [seg(l, { fg: 'bodyText' })]
    return [seg(l, { fg: 'bodyText' })]
  })
  if (a.status === 'working')
    body.push(
      [],
      [
        seg(' '),
        anim.spinner(theme, now),
        seg(' '),
        ...anim.thinking(theme, 'Thinking…', now, { startedAt: 300 })
      ]
    )
  const footer: Line = [
    statusGlyph(a, now, 'tileBg'),
    seg(` ${st.label}`, { fg: st.role, bold: st.bold })
  ]
  const pulse = a.status === 'needs-input' ? anim.attentionPulse(now, 500).color : undefined
  const opts = {
    width,
    height,
    state,
    title,
    titleRight: right,
    footer,
    body: body.map((l) => [seg(' '), ...l]),
    borderColor: pulse
  }
  return enterAt !== undefined ? anim.tileEnter(theme, now, enterAt, opts) : frame(theme, opts)
}

function grid(width: number, height: number, now: number | undefined): Line[] {
  const colW = Math.floor((width - 1) / 2)
  const rowH = Math.floor(height / 2)
  const states: TileState[] = ['attention', 'focused', 'normal', 'normal']
  const tiles = AGENTS.map((a, i) =>
    tileFor(
      a,
      i % 2 === 0 ? colW : width - colW - 1,
      rowH,
      states[i],
      now,
      i === 3 ? 1000 : undefined
    )
  )
  const gap: Line[] = Array.from({ length: rowH }, () => [seg(' ', { bg: 'appBg' })])
  return [...hjoin(tiles[0], gap, tiles[1]), ...hjoin(tiles[2], gap, tiles[3])]
}

function header(width: number): Line {
  const left: Line = [
    ...compactMark(theme),
    seg(' neurosquad', { fg: 'text', bold: true }),
    seg(` ${g.separator} ~/code/shop ${g.separator} 5 agents`, { fg: 'mutedText' })
  ]
  const right: Line = [
    badge('1 needs you', 'warningFg', 'needsYou'),
    seg('  $3.42 today', { fg: 'text' }),
    seg('   ? help', { fg: 'mutedText' })
  ]
  return statusLine(theme, width, left, right)
}

function footerHints(width: number): Line {
  const hints: Line = [
    ...keyHint(`${g.arrowUp}${g.arrowDown}`, 'select'),
    ...keyHint(g.enter, 'expand'),
    ...keyHint('y/n/a', 'answer'),
    ...keyHint('i', 'interrupt'),
    ...keyHint('w', 'worktree agent'),
    ...keyHint('q', 'quit (agents keep running)')
  ]
  return statusLine(theme, width, hints)
}

function gallery(width: number, now: number | undefined): Line[] {
  const bg: Role = 'appBg'
  const label = (t: string): Seg => seg(t.padEnd(16), { fg: 'mutedText', bg })
  const t = now
  const ratio = t === undefined ? 0.62 : (t % 6000) / 6000
  const rows: Line[] = [
    [
      label(' working'),
      anim.spinner(theme, t, { bg }),
      seg('  ', { bg }),
      ...anim.thinking(theme, 'Thinking…', t, {
        startedAt: t === undefined ? 0 : Math.floor(t / 5000) * 5000 + 300,
        bg
      })
    ],
    [
      label(' needs you'),
      anim.attentionDot(theme, t, 500, bg),
      seg('  ', { bg }),
      anim.attentionBadge(theme, t, 500)
    ],
    [
      label(' finished'),
      anim.sparkle(theme, t === undefined ? undefined : 2200 + ((t - 2200) % 3000), 2200, bg).seg,
      seg('  sparkle on finish', { fg: 'mutedText', bg })
    ],
    [
      label(' new tile'),
      ...anim.typewriter(
        theme,
        'claude · fix the flaky checkout test',
        t === undefined ? undefined : t % 4000,
        400,
        { bg }
      )
    ],
    [
      label(' download'),
      ...anim.progressBar(theme, t, { width: 36, ratio, bg }),
      seg(` ${Math.round(ratio * 100)}%`.padStart(5) + '  model.onnx', { fg: 'mutedText', bg })
    ],
    [label(' indeterminate'), ...anim.progressBar(theme, t, { width: 36, ratio: undefined, bg })]
  ]
  return rows.map((l) => fitLine(l, width, bg))
}

function palette(width: number): Line[] {
  const bg: Role = 'appBg'
  const roles: Role[] = [
    'accent',
    'success',
    'warning',
    'danger',
    'mutedText',
    'faintText',
    'border',
    'selectionBg',
    'tileBg',
    'sidebarBg',
    'headerBg',
    'brandLime',
    'brandEmerald'
  ]
  const swatches = (rs: Role[], title: string): Line => {
    const line: Line = [seg(title.padEnd(16), { fg: 'mutedText', bg })]
    for (const r of rs) line.push(seg('  ', { bg: r }), seg(` ${r}  `, { fg: 'faintText', bg }))
    return line
  }
  const line = swatches(roles.slice(0, 7), ' palette')
  const line2 = swatches(roles.slice(7), '')
  const statuses: Line = [seg(' status'.padEnd(16), { fg: 'mutedText', bg })]
  for (const s of ['needs-input', 'working', 'finished', 'idle', 'exited'] as AgentStatus[]) {
    const st = STATUS_STYLE[s]
    statuses.push(
      seg(g.status[s], { fg: st.role, bg, bold: true }),
      seg(` ${st.label}   `, { fg: st.role, bg, bold: st.bold })
    )
  }
  const levels = [
    ' colours',
    theme.level === 3 ? '24-bit' : theme.level === 2 ? '256' : theme.level === 1 ? '16' : 'none',
    `glyphs: ${theme.unicode ? 'unicode' : 'ascii'}`,
    `logos: ${theme.logos}${theme.logos === 'images' ? ` (${graphics})` : ''}`
  ]
  const info: Line = [
    seg(levels[0].padEnd(16), { fg: 'mutedText', bg }),
    seg(levels.slice(1).join(`  ${g.separator}  `), { fg: 'text', bg })
  ]
  return [line, line2, statuses, info].map((l) => fitLine(l, width, bg))
}

// ---- screen ---------------------------------------------------------------------------------

const SIDEBAR_W = 34
const GRID_H = 26

function screen(now: number | undefined): Line[] {
  const bg: Role = 'appBg'
  const blank = (): Line => fitLine([], WIDTH, bg)
  const mark =
    now === undefined
      ? wordmark(theme, { bg: ROLE_SOURCES.appBg })
      : anim.wordmarkSweep(theme, now, 0, { bg: ROLE_SOURCES.appBg }).lines
  const lines: Line[] = [blank()]
  for (const l of mark) lines.push(fitLine([seg('  ', { bg }), ...l], WIDTH, bg))
  lines.push(
    fitLine(
      [
        seg('  run several coding agents in your terminal · get called when one needs you', {
          fg: 'mutedText',
          bg
        })
      ],
      WIDTH,
      bg
    )
  )
  lines.push(blank())
  lines.push(header(WIDTH))
  const gridW = WIDTH - SIDEBAR_W - 1
  let gridLines = grid(gridW, GRID_H, now)
  // Expand / collapse demo: the focused tile grows to the full grid, holds, and shrinks back.
  if (now !== undefined) {
    const cycle = now % 10000
    const colW = Math.floor((gridW - 1) / 2)
    const small = { x: colW + 1, y: 0, width: gridW - colW - 1, height: Math.floor(GRID_H / 2) }
    const big = { x: 0, y: 0, width: gridW, height: GRID_H }
    const r =
      anim.transitionRect(cycle, 5000, small, big) ?? anim.transitionRect(cycle, 7000, big, small)
    if (r)
      gridLines = overlay(
        gridLines,
        r.x,
        r.y,
        frame(theme, { ...r, state: 'focused', title: [seg('reviewer', { bold: true })] })
      )
    else if (cycle >= 5000 && cycle < 7000)
      gridLines = overlay(gridLines, 0, 0, tileFor(AGENTS[1], gridW, GRID_H, 'focused', now))
  }
  const body = hjoin(
    sidebar(SIDEBAR_W, GRID_H, now),
    Array.from({ length: GRID_H }, () => [seg(' ', { bg })]),
    gridLines
  )
  lines.push(...body)
  lines.push(footerHints(WIDTH))
  lines.push(blank())
  lines.push(...gallery(WIDTH, now))
  lines.push(
    fitLine(
      rule(theme, WIDTH - 2, bg).map((s) => s),
      WIDTH,
      bg
    )
  )
  lines.push(...palette(WIDTH))
  lines.push(blank())
  return lines
}

/** Where the logo badges are (row, 1-based col), for image placement. */
function logoSpots(lines: Line[]): Array<{ row: number; col: number; id: string }> {
  const spots: Array<{ row: number; col: number; id: string }> = []
  lines.forEach((line, row) => {
    let col = 0
    for (const s of line) {
      const id = (s as Seg & { logo?: string }).logo
      if (id) spots.push({ row, col: col + 1, id })
      col += stringWidth(s.text)
    }
  })
  return spots
}

function imagesOverlay(lines: Line[], absolute: boolean): string {
  if (graphics === 'none') return ''
  let out = ''
  for (const s of logoSpots(lines)) {
    const img = logoImage(s.id, { protocol: graphics, bg: ROLE_SOURCES.tileBg })
    if (!img) continue
    if (absolute) out += `\x1b7\x1b[${s.row + 1};${s.col}H${img}\x1b8`
    else {
      const up = lines.length - s.row
      out += `\x1b7\x1b[${up}A\x1b[${s.col}G${img}\x1b8`
    }
  }
  return out
}

// ---- modes ----------------------------------------------------------------------------------

function printStatic(at: number | undefined): void {
  const lines = screen(at)
  process.stdout.write(lines.map((l) => renderLine(theme, l)).join('\n') + '\n')
  process.stdout.write(imagesOverlay(lines, false))
}

function paintDiff(prev: Line[] | undefined, next: Line[]): string {
  let out = ''
  for (const span of diffFrames(prev, next))
    out += `\x1b[${span.row + 1};${span.col + 1}H` + renderLine(theme, span.segs)
  return out
}

function live(): void {
  const policy = anim.resolveMotion({
    colorLevel: theme.level,
    reduceMotion: args.has('reduce-motion')
  })
  const ticker = new anim.Ticker()
  ticker.setEnabled(policy.animate)
  const out = process.stdout
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J')
  let prev: Line[] | undefined
  const start = performance.now()
  const draw = (now: number): void => {
    const next = screen(policy.animate ? now - start : undefined)
    out.write(paintDiff(prev, next))
    if (!prev) out.write(imagesOverlay(next, true))
    prev = next
  }
  const quit = (): void => {
    ticker.dispose()
    out.write('\x1b[0m\x1b[?25h\x1b[?1049l')
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.exit(0)
  }
  draw(start)
  ticker.subscribe(draw, { fps: policy.transitionFps || 12 })
  if (!policy.animate)
    out.write(`\x1b[${screen(undefined).length + 1};1H  motion off: ${policy.reason}`)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (d) => {
      const s = d.toString()
      if (s === 'q' || s === '\x03' || s === '\x1b') quit()
    })
  }
  const seconds = Number(args.get('seconds'))
  if (seconds > 0) setTimeout(quit, seconds * 1000)
  else setInterval(() => undefined, 1 << 30)
  process.on('SIGINT', quit)
}

function recordCast(file: string): void {
  const seconds = Number(args.get('seconds')) || 10
  const fps = 15
  const rows = screen(undefined).length
  const events: string[] = [
    JSON.stringify({
      version: 2,
      width: WIDTH,
      height: rows,
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    })
  ]
  let prev: Line[] | undefined
  events.push(JSON.stringify([0, 'o', '\x1b[?25l\x1b[2J']))
  for (let i = 0; i <= seconds * fps; i++) {
    const now = (i * 1000) / fps
    const next = screen(now)
    const data = paintDiff(prev, next)
    if (data) events.push(JSON.stringify([now / 1000, 'o', data]))
    prev = next
  }
  writeFileSync(file, events.join('\n') + '\n')
  process.stdout.write(`wrote ${file} (${seconds}s, ${fps} fps, ${WIDTH}x${rows})\n`)
}

// `npm run preview | head` closes the pipe early; that is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

if (record) recordCast(record)
else if (args.has('live')) live()
else printStatic(args.has('at') ? Number(args.get('at')) : undefined)
