// The dashboard: a sidebar of workspaces and their agents on the left, the
// agents of the selected workspace as a grid of live terminals on the right.
// Any agent opens full screen (Enter, double-click) and goes back to the grid
// (Ctrl+]). The person answers permission prompts, sends prompts and starts
// agents from here; the agents keep running in the daemon when it closes.
//
// Rendering: our chrome (header, sidebar, frames, dialogs) is a cell canvas
// written as a diff; the terminals are painted by the term-view compositor
// into the frames' insides. One frame at most every ~33 ms, only when
// something changed; decorative animation runs on the theme's shared ticker
// and pauses while an agent is open full screen.
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import {
  animations,
  compactMark,
  createTheme,
  detectGraphicsFromEnv,
  frame,
  glyphSet,
  isRemoteSession,
  logoBadge,
  logoImage,
  placeAt,
  seg,
  STATUS_STYLE,
  wordmark,
  wordmarkWidth,
  type AgentStatus,
  type Line,
  type Seg,
  type Theme
} from '@neurosquad/tui-theme'
import {
  createCompositor,
  createTermView,
  encodePaste,
  gridRowText,
  type Compositor,
  type Tile,
  type TermView
} from '@neurosquad/term-view'
import { formatUsd, type HarnessId } from '@neurosquad/core'
import { DaemonClient } from '../client/client.js'
import { readConfig } from '../config.js'
import { findDetachKey, parseDetachKey } from '../attach.js'
import { HARNESS_LABEL, elapsed } from '../format.js'
import type { AgentView, DaemonEvent } from '../protocol.js'
import { Canvas } from './canvas.js'
import {
  InputParser,
  applicationCursor,
  encodeMouse,
  type InputEvent,
  type KeyEvent,
  type MouseEvent
} from './keys.js'
import {
  contains,
  gridShape,
  inner,
  screenLayout,
  tileRects,
  type Layout,
  type Rect
} from './layout.js'
import { PickList, TextField, fitText } from './widgets.js'
import { bindDictation, type DictationBinding } from '../dictation.js'

/** Leaves the dashboard's terminal modes: colours, focus, paste, mouse, cursor, alternate screen. */
const RESTORE = '\x1b[0m\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l'
const FRAME_MS = 33
const DOUBLE_CLICK_MS = 400
const RESIZE_DEBOUNCE_MS = 150

interface AgentScreen {
  view: TermView
  generation: number
  tile?: Tile
  /** When it entered its current status (for the pulse, the sparkle). */
  statusSince: number
  status?: string
  finishedAt?: number
}

type Modal =
  | { kind: 'help' }
  | { kind: 'prompt'; title: string; field: TextField; submit: (text: string) => void }
  | { kind: 'confirm'; title: string; body: string; yes: () => void }
  | { kind: 'new'; form: NewAgentForm }
  | {
      kind: 'models'
      agentId?: string
      list: PickList<{ id: string; name: string; price: string }>
      loading: boolean
      error?: string
      onPick: (id: string) => void
    }
  | { kind: 'message'; title: string; body: string }

interface NewAgentForm {
  harness: number
  field: number
  name: TextField
  prompt: TextField
  cwd: TextField
  model: TextField
  worktree: boolean
  openrouter: boolean
  dangerous: boolean
}

const HARNESS_CHOICES: { id: HarnessId; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex-cli', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'command', label: 'Command' }
]
const FORM_FIELDS = [
  'harness',
  'name',
  'prompt',
  'cwd',
  'worktree',
  'openrouter',
  'model',
  'dangerous',
  'start'
] as const

function statusOf(agent: AgentView): AgentStatus {
  if (!agent.running || agent.status === 'exited') return 'exited'
  return (agent.status ?? 'idle') as AgentStatus
}

export class Dashboard {
  private readonly theme: Theme
  private readonly compositor: Compositor
  private readonly parser = new InputParser()
  private readonly agents = new Map<string, AgentView>()
  private readonly screens = new Map<string, AgentScreen>()
  private readonly detachKey: string
  private readonly motion: animations.MotionPolicy
  private readonly graphics: ReturnType<typeof detectGraphicsFromEnv>
  private selected: string | null = null
  private expanded: string | null = null
  private page = 0
  private sidebarMode: 'auto' | 'shown' | 'hidden' = 'auto'
  private modal: Modal | null = null
  private prev: Canvas | undefined
  private layout: Layout
  private tileAreas = new Map<string, Rect>()
  private sidebarRows: { y: number; id?: string; workspace?: string }[] = []
  private scheduled: ReturnType<typeof setTimeout> | null = null
  private lastFrameAt = 0
  private lastClick = { at: 0, id: '' }
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private wantedSizes = new Map<string, { cols: number; rows: number }>()
  private unsubscribeTicker: (() => void) | null = null
  private escTimer: ReturnType<typeof setTimeout> | null = null
  private readonly startedAt = Date.now()
  private toast: { text: string; until: number } | null = null
  private closed = false
  private resolveClosed: () => void = () => {}
  private logoSlots: { row: number; col: number; harness: string }[] = []
  private readonly launchCwd = process.cwd()
  private dictation: DictationBinding | null = null

  constructor(
    private readonly client: DaemonClient,
    private readonly stdout: NodeJS.WriteStream = process.stdout,
    private readonly stdin: NodeJS.ReadStream = process.stdin
  ) {
    const config = readConfig()
    this.theme = createTheme(
      config.logos && config.logos !== 'auto'
        ? { logos: config.logos === 'neutral' ? 'none' : config.logos }
        : {}
    )
    this.motion = animations.resolveMotion({ colorLevel: this.theme.level })
    this.graphics = detectGraphicsFromEnv(process.env)
    this.detachKey = parseDetachKey(config.detachKey)
    this.layout = screenLayout(this.width, this.height, this.sidebarMode)
    this.compositor = createCompositor({
      write: (text) => this.stdout.write(text),
      paused: true,
      synchronized: false,
      hostSize: { cols: this.width, rows: this.height }
    })
  }

  private get width(): number {
    return Math.max(40, this.stdout.columns || 100)
  }

  private get height(): number {
    return Math.max(12, this.stdout.rows || 30)
  }

  // ---- lifecycle --------------------------------------------------------------------

  async run(): Promise<void> {
    this.stdout.write(
      '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[2J'
    )
    if (this.stdin.isTTY) this.stdin.setRawMode(true)
    this.stdin.setEncoding('utf8')
    this.stdin.resume()
    this.stdin.on('data', this.onInput)
    this.stdout.on('resize', this.onResize)
    const off = this.client.on((event) => this.onEvent(event))
    this.client.onClose(() => this.quit('the daemon stopped'))
    process.on('SIGINT', this.onSignal)
    process.on('SIGTERM', this.onSignal)
    process.on('SIGHUP', this.onSignal)
    process.on('uncaughtException', this.onCrash)
    process.on('unhandledRejection', this.onCrash)
    process.on('exit', this.onExit)
    if (this.motion.animate) {
      this.unsubscribeTicker = animations.sharedTicker.subscribe(() => this.schedule(), {
        fps: this.motion.fps
      })
    }
    await this.client.request({ t: 'subscribe', agents: '*', output: '*' })
    this.schedule()
    // Dictation (optional): the text goes into the open agent, else the selected one — pasted, never sent.
    void bindDictation({
      target: () => this.expanded ?? this.selected,
      paste: (id, text) => this.client.post({ t: 'paste', id, text }),
      changed: () => this.schedule(),
      notice: (text) => this.toastMessage(text)
    }).then(
      (binding) => {
        // Quit meanwhile: release the hotkey and the microphone at once.
        if (this.closed) {
          void binding?.dispose()
          return
        }
        this.dictation = binding
        this.schedule()
      },
      (error: unknown) => {
        // Optional: a hotkey or native part that fails never takes the dashboard down.
        this.toastMessage(
          `dictation unavailable: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    )
    await new Promise<void>((resolve) => {
      this.resolveClosed = resolve
    })
    off()
    await this.dictation?.dispose()
  }

  private readonly onSignal = (): void => this.quit()

  /** A crash anywhere: the terminal comes back first (raw mode, screen, mouse), then the error. */
  private readonly onCrash = (error: unknown): void => {
    try {
      this.quit()
    } catch {
      // Restoring failed too: still report the original error below.
      this.onExit()
    }
    process.stderr.write(
      `nsq: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    process.exit(1)
  }

  /** Last resort on any exit while the dashboard is up: restore synchronously. */
  private readonly onExit = (): void => {
    if (this.closed) return
    try {
      if (this.stdin.isTTY) this.stdin.setRawMode(false)
      this.stdout.write(RESTORE)
    } catch {
      // The terminal is gone.
    }
  }

  private quit(message?: string): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeTicker?.()
    if (this.scheduled) clearTimeout(this.scheduled)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    if (this.escTimer) clearTimeout(this.escTimer)
    this.stdin.off('data', this.onInput)
    this.stdout.off('resize', this.onResize)
    process.off('SIGINT', this.onSignal)
    process.off('SIGTERM', this.onSignal)
    process.off('SIGHUP', this.onSignal)
    process.off('uncaughtException', this.onCrash)
    process.off('unhandledRejection', this.onCrash)
    process.off('exit', this.onExit)
    this.compositor.dispose()
    for (const screen of this.screens.values()) screen.view.dispose()
    if (this.stdin.isTTY) this.stdin.setRawMode(false)
    this.stdin.pause()
    this.stdout.write(RESTORE + (this.graphics.protocol === 'kitty' ? '\x1b_Ga=d\x1b\\' : ''))
    if (message) this.stdout.write(`nsq: ${message}\n`)
    this.client.close()
    this.resolveClosed()
  }

  private readonly onResize = (): void => {
    this.compositor.setHostSize({ cols: this.width, rows: this.height })
    this.prev = undefined
    this.stdout.write('\x1b[2J')
    this.compositor.invalidateAll()
    this.schedule()
  }

  // ---- daemon events ------------------------------------------------------------------

  private screenOf(id: string, cols = 80, rows = 24): AgentScreen {
    let screen = this.screens.get(id)
    if (!screen) {
      const view = createTermView({ cols, rows, owner: false, scrollback: 1000 })
      view.onChange(() => this.schedule())
      screen = { view, generation: 0, statusSince: Date.now() }
      this.screens.set(id, screen)
    }
    return screen
  }

  private noteAgent(agent: AgentView): void {
    const before = this.agents.get(agent.id)
    this.agents.set(agent.id, agent)
    const screen = this.screenOf(agent.id, agent.cols, agent.rows)
    const status = statusOf(agent)
    if (screen.status !== status) {
      screen.status = status
      screen.statusSince = Date.now()
      if (status === 'finished' && before) screen.finishedAt = Date.now()
    }
    if (!this.selected) this.selected = agent.id
  }

  private onEvent(event: DaemonEvent): void {
    switch (event.t) {
      case 'agents':
        for (const agent of event.agents) this.noteAgent(agent)
        for (const id of [...this.agents.keys()])
          if (!event.agents.some((a) => a.id === id)) this.dropAgent(id)
        break
      case 'agent':
        this.noteAgent(event.agent)
        break
      case 'removed':
        this.dropAgent(event.id)
        break
      case 'screen': {
        const screen = this.screenOf(event.id, event.cols, event.rows)
        screen.generation = event.generation
        screen.view.respawn(true)
        screen.view.resize(event.cols, event.rows)
        screen.view.write(event.data)
        break
      }
      case 'data': {
        const screen = this.screens.get(event.id)
        if (!screen) return
        if (event.generation !== screen.generation) {
          // A new process: start from a clean screen.
          screen.generation = event.generation
          screen.view.respawn(true)
        }
        screen.view.write(event.data)
        return
      }
      case 'resized':
        this.screens.get(event.id)?.view.resize(event.cols, event.rows)
        break
      case 'notify':
        // No desktop notification (switched off, none here, or over SSH where it would show on
        // the other machine): ring this terminal instead — bell and OSC 9.
        if (event.ring || isRemoteSession(process.env)) {
          this.stdout.write(
            // eslint-disable-next-line no-control-regex -- real escape sequences
            `\x07\x1b]9;${event.title}: ${event.body.replace(/[\x00-\x1f]/g, ' ')}\x07`
          )
        }
        break
      default:
        return
    }
    this.schedule()
  }

  private dropAgent(id: string): void {
    this.agents.delete(id)
    const screen = this.screens.get(id)
    screen?.tile?.remove()
    screen?.view.dispose()
    this.screens.delete(id)
    if (this.selected === id) this.selected = this.ordered()[0]?.id ?? null
    if (this.expanded === id) this.collapse()
  }

  // ---- model ------------------------------------------------------------------------------

  /** Workspaces in order of their first agent, each with its agents. */
  private workspaces(): { path: string; agents: AgentView[] }[] {
    const groups = new Map<string, AgentView[]>()
    for (const agent of [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      const list = groups.get(agent.workspace) ?? []
      list.push(agent)
      groups.set(agent.workspace, list)
    }
    return [...groups.entries()].map(([path, agents]) => ({ path, agents }))
  }

  private ordered(): AgentView[] {
    return this.workspaces().flatMap((ws) => ws.agents)
  }

  private currentWorkspace(): { path: string; agents: AgentView[] } | undefined {
    const all = this.workspaces()
    const selected = this.selected ? this.agents.get(this.selected) : undefined
    return all.find((ws) => ws.path === selected?.workspace) ?? all[0]
  }

  // ---- frames ------------------------------------------------------------------------------

  private schedule(): void {
    if (this.scheduled || this.closed) return
    const wait = Math.max(0, FRAME_MS - (Date.now() - this.lastFrameAt))
    this.scheduled = setTimeout(() => {
      this.scheduled = null
      this.lastFrameAt = Date.now()
      try {
        this.render()
      } catch (error) {
        this.quit(`display error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, wait)
  }

  private render(): void {
    const now = this.motion.animate ? Date.now() : undefined
    this.layout = screenLayout(this.width, this.height, this.sidebarMode)
    const canvas = new Canvas(this.width, this.height, { bg: 'appBg' })
    this.logoSlots = []
    this.drawHeader(canvas)
    if (this.layout.sidebar) this.drawSidebar(canvas, this.layout.sidebar, now)
    const tiles = this.drawMain(canvas, this.layout.main, now)
    this.drawFooter(canvas)
    if (this.modal) this.drawModal(canvas)
    if (this.toast && Date.now() > this.toast.until) this.toast = null
    // Tiles: one per visible agent, removed for the rest.
    const visible = new Set<string>()
    if (!this.modal) {
      for (const [id, rect] of tiles) {
        visible.add(id)
        const screen = this.screens.get(id)
        if (!screen) continue
        const options =
          id === this.expanded
            ? { showCursor: true, fit: 'follow' as const }
            : { fit: 'follow' as const }
        if (!screen.tile) screen.tile = this.compositor.addTile(screen.view, rect, options)
        else {
          screen.tile.setRect(rect)
          screen.tile.setOptions(options)
        }
      }
    }
    for (const [id, screen] of this.screens) {
      if (!visible.has(id) && screen.tile) {
        screen.tile.remove()
        screen.tile = undefined
      }
    }
    const { out, rows } = canvas.diff(this.theme, this.prev)
    const repaintAll = this.prev === undefined
    this.prev = canvas
    let text = '\x1b[?2026h'
    if (!this.expanded) text += '\x1b[?25l'
    text += out
    text += this.logos(repaintAll ? null : rows)
    if (!this.modal) {
      if (repaintAll) this.compositor.invalidateAll()
      text += this.compositor.renderFrame()
    }
    text += '\x1b[?2026l'
    this.stdout.write(text)
    this.requestSizes(tiles)
  }

  /** Real logos over the glyph badges, where the terminal can draw images. */
  private logos(rows: Set<number> | null): string {
    if (this.theme.logos !== 'images' || this.graphics.protocol === 'none') return ''
    let out = ''
    this.logoSlots.forEach((slot, index) => {
      if (rows && !rows.has(slot.row)) return
      const image = logoImage(slot.harness, {
        protocol: this.graphics.protocol,
        cols: 2,
        rows: 1,
        id: 900 + index,
        tmux: this.graphics.tmux
      })
      if (image) out += placeAt(slot.row + 1, slot.col + 1, image)
    })
    return out
  }

  /** Each visible agent's pty takes the size of its tile (debounced; latest client wins). */
  private requestSizes(tiles: Map<string, Rect>): void {
    let changed = false
    for (const [id, rect] of tiles) {
      const agent = this.agents.get(id)
      if (!agent?.running) continue
      const wanted = { cols: rect.width, rows: rect.height }
      const last = this.wantedSizes.get(id)
      if (last && last.cols === wanted.cols && last.rows === wanted.rows) continue
      this.wantedSizes.set(id, wanted)
      if (agent.cols !== wanted.cols || agent.rows !== wanted.rows) changed = true
    }
    if (!changed) return
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      for (const [id, size] of this.wantedSizes) {
        const agent = this.agents.get(id)
        if (agent?.running && (agent.cols !== size.cols || agent.rows !== size.rows)) {
          this.client.post({ t: 'resize', id, cols: size.cols, rows: size.rows })
        }
      }
    }, RESIZE_DEBOUNCE_MS)
  }

  // ---- drawing --------------------------------------------------------------------------------

  private statusSeg(agent: AgentView, now: number | undefined, bg: Seg['bg']): Seg {
    const status = statusOf(agent)
    const screen = this.screens.get(agent.id)
    const g = glyphSet(this.theme.unicode)
    if (status === 'working') return animations.spinner(this.theme, now, { bg })
    if (status === 'needs-input')
      return animations.attentionDot(this.theme, now, screen?.statusSince ?? 0, bg)
    if (status === 'finished' && screen?.finishedAt) {
      const sparkle = animations.sparkle(this.theme, now, screen.finishedAt, bg)
      if (!sparkle.done) return sparkle.seg
    }
    return seg(g.status[status], { fg: STATUS_STYLE[status].role, bg })
  }

  private drawHeader(canvas: Canvas): void {
    const { width } = this.layout.header
    canvas.fill(0, 0, width, 1, { bg: 'headerBg' })
    const agents = [...this.agents.values()]
    const needs = agents.filter((a) => statusOf(a) === 'needs-input').length
    const working = agents.filter((a) => statusOf(a) === 'working').length
    let total = 0n
    let unpriced = false
    for (const agent of agents) {
      if (agent.costPico) total += BigInt(agent.costPico)
      if (agent.unpricedRequests) unpriced = true
    }
    const ws = this.currentWorkspace()
    const left: Line = [
      seg(' ', { bg: 'headerBg' }),
      ...compactMark(this.theme).map((s) => ({ ...s, bg: 'headerBg' as const })),
      seg(' neurosquad', { fg: 'text', bg: 'headerBg', bold: true }),
      seg(ws ? `  ${ws.path}` : '', { fg: 'mutedText', bg: 'headerBg' })
    ]
    const g = glyphSet(this.theme.unicode)
    const right: Line = [
      ...(needs
        ? [
            seg(`${g.status['needs-input']} ${needs} need${needs === 1 ? 's' : ''} you  `, {
              fg: 'needsYou',
              bg: 'headerBg',
              bold: true
            })
          ]
        : []),
      ...(working
        ? [seg(`${g.status.working} ${working} working  `, { fg: 'accentText', bg: 'headerBg' })]
        : []),
      seg(agents.length ? `${formatUsd(total)}${unpriced ? '+' : ''}  ` : '', {
        fg: 'mutedText',
        bg: 'headerBg'
      }),
      ...this.dictationBadge(),
      seg('? help ', { fg: 'faintText', bg: 'headerBg' })
    ]
    const rightWidth = right.reduce((w, s) => w + [...s.text].length, 0)
    canvas.put(0, 0, left, width - rightWidth - 1)
    canvas.put(width - rightWidth, 0, right)
  }

  private dictationBadge(): Seg[] {
    const d = this.dictation
    if (!d) return []
    switch (d.state) {
      case 'recording':
        return [
          seg(' ● REC ', { fg: 'accentFg', bg: 'danger', bold: true }),
          seg('  ', { bg: 'headerBg' })
        ]
      case 'transcribing':
        return [seg('transcribing…  ', { fg: 'accentText', bg: 'headerBg' })]
      case 'downloading':
        return [
          seg(`model ${Math.floor((d.progress ?? 0) * 100)}%  `, {
            fg: 'accentText',
            bg: 'headerBg'
          })
        ]
      default:
        return []
    }
  }

  private toggleDictation(): void {
    const d = this.dictation
    if (!d) {
      this.toastMessage(
        'dictation is not available (the @neurosquad/dictation package is not installed)'
      )
      return
    }
    if (d.state === 'downloading') return
    if (!d.installed()) {
      this.modal = {
        kind: 'confirm',
        title: 'Dictation model',
        body: `Download ${d.modelName} (${Math.round(d.modelBytes / 1e6)} MB, checked by SHA-256)? Speech stays on this machine.`,
        yes: () => this.request(d.ensureModel(), `${d.modelName} is ready — press v to dictate`)
      }
      return
    }
    d.toggle()
  }

  private drawSidebar(canvas: Canvas, rect: Rect, now: number | undefined): void {
    canvas.fill(rect.x, rect.y, rect.width, rect.height, { bg: 'sidebarBg' })
    for (let y = rect.y; y < rect.y + rect.height; y++)
      canvas.put(rect.x + rect.width - 1, y, [seg('│', { fg: 'separator', bg: 'sidebarBg' })])
    this.sidebarRows = []
    const w = rect.width - 1
    let y = rect.y
    const g = glyphSet(this.theme.unicode)
    canvas.put(rect.x, y, [
      seg(fitText(' WORKSPACES', w), { fg: 'faintText', bg: 'sidebarBg', bold: true })
    ])
    y += 1
    const current = this.currentWorkspace()
    for (const ws of this.workspaces()) {
      if (y >= rect.y + rect.height - 2) break
      const active = ws.path === current?.path
      const needs = ws.agents.some((a) => statusOf(a) === 'needs-input')
      const name = basename(ws.path) || ws.path
      canvas.put(rect.x, y, [
        seg(` ${active ? g.chevronDown : g.chevronRight} `, {
          fg: active ? 'accentText' : 'mutedText',
          bg: 'sidebarBg'
        }),
        seg(fitText(name, w - 6), {
          fg: active ? 'text' : 'mutedText',
          bg: 'sidebarBg',
          bold: active
        }),
        needs
          ? animations.attentionDot(this.theme, now, 0, 'sidebarBg')
          : seg(' ', { bg: 'sidebarBg' }),
        seg(' ', { bg: 'sidebarBg' })
      ])
      this.sidebarRows.push({ y, workspace: ws.path })
      y += 1
      for (const agent of ws.agents) {
        if (y >= rect.y + rect.height - 2) break
        const isSelected = agent.id === this.selected
        const bg = isSelected ? 'selectionBg' : 'sidebarBg'
        const status = statusOf(agent)
        const badge = logoBadge(this.theme, agent.harness).map((s) => ({ ...s }))
        const rightText =
          status === 'needs-input'
            ? null
            : agent.costPico !== undefined
              ? formatUsd(BigInt(agent.costPico))
              : ''
        const right: Seg =
          status === 'needs-input'
            ? animations.attentionBadge(
                this.theme,
                now,
                this.screens.get(agent.id)?.statusSince ?? 0,
                this.theme.unicode ? '!' : '!'
              )
            : seg(rightText ?? '', { fg: 'faintText', bg })
        const rightWidth = [...right.text].length
        const nameWidth = Math.max(4, w - 8 - rightWidth - 1)
        const col = rect.x + 5
        canvas.put(rect.x, y, [
          seg(isSelected ? '▌' : ' ', { fg: 'accent', bg }),
          seg('  ', { bg }),
          this.statusSeg(agent, now, bg),
          seg(' ', { bg })
        ])
        canvas.put(col, y, badge)
        this.logoSlots.push({ row: y, col, harness: agent.harness })
        canvas.put(col + 2, y, [
          seg(' ', { bg }),
          seg(fitText(agent.name, nameWidth), {
            fg: status === 'exited' ? 'faintText' : 'text',
            bg,
            bold: isSelected
          }),
          seg(' ', { bg })
        ])
        canvas.put(rect.x + w - rightWidth - 1, y, [right, seg(' ', { bg })])
        this.sidebarRows.push({ y, id: agent.id })
        y += 1
      }
    }
    const bottom = rect.y + rect.height - 1
    canvas.put(rect.x, bottom, [
      seg(fitText(' + new agent  c', w), { fg: 'accentText', bg: 'sidebarBg' })
    ])
    this.sidebarRows.push({ y: bottom, workspace: '+new' })
  }

  /** Draws the grid (or the open agent); returns the tile rectangles by agent id. */
  private drawMain(canvas: Canvas, area: Rect, now: number | undefined): Map<string, Rect> {
    const tiles = new Map<string, Rect>()
    this.tileAreas.clear()
    if (this.agents.size === 0) {
      this.drawEmpty(canvas, area, now)
      return tiles
    }
    let ids: string[]
    let rects: Rect[]
    if (this.expanded && this.agents.has(this.expanded)) {
      ids = [this.expanded]
      rects = [area]
    } else {
      const agents = this.currentWorkspace()?.agents ?? []
      const shape = gridShape(agents.length, area)
      const pages = Math.max(1, Math.ceil(agents.length / shape.perPage))
      const selectedIndex = agents.findIndex((a) => a.id === this.selected)
      if (selectedIndex >= 0) this.page = Math.floor(selectedIndex / shape.perPage)
      this.page = Math.min(this.page, pages - 1)
      const pageAgents = agents.slice(this.page * shape.perPage, (this.page + 1) * shape.perPage)
      ids = pageAgents.map((a) => a.id)
      rects = tileRects(shape, pageAgents.length, area)
      if (pages > 1) {
        const label = ` page ${this.page + 1}/${pages}  [ ] `
        canvas.put(area.x + area.width - label.length - 1, area.y + area.height - 1, [
          seg(label, { fg: 'mutedText', bg: 'appBg' })
        ])
      }
    }
    ids.forEach((id, index) => {
      const agent = this.agents.get(id)
      const rect = rects[index]
      if (!agent || !rect) return
      this.tileAreas.set(id, rect)
      const status = statusOf(agent)
      const focused = id === this.selected
      const attention = status === 'needs-input'
      const screen = this.screens.get(id)
      const pulse = attention ? animations.attentionPulse(now, screen?.statusSince ?? 0) : undefined
      const style = STATUS_STYLE[status]
      const badge = logoBadge(this.theme, agent.harness)
      const title: Line = [
        ...badge,
        seg(' ', { bg: 'tileBg' }),
        seg(agent.name, { fg: 'text', bg: 'tileBg', bold: true }),
        seg('  ', { bg: 'tileBg' }),
        this.statusSeg(agent, now, 'tileBg'),
        seg(` ${style.label}`, { fg: style.role, bg: 'tileBg', bold: style.bold }),
        ...(agent.dangerousMode ? [seg('  dangerous', { fg: 'danger', bg: 'tileBg' })] : []),
        ...(agent.queued
          ? [seg(`  +${agent.queued} queued`, { fg: 'mutedText', bg: 'tileBg' })]
          : [])
      ]
      const titleRight: Line = [
        seg(
          `${HARNESS_LABEL[agent.harness]}${agent.model ? ` · ${agent.model}` : ''} · ${elapsed(agent.statusAt ?? agent.createdAt)}`,
          { fg: 'mutedText', bg: 'tileBg' }
        ),
        ...(agent.costPico !== undefined
          ? [
              seg(` · ${formatUsd(BigInt(agent.costPico))}${agent.unpricedRequests ? '+' : ''}`, {
                fg: 'mutedText',
                bg: 'tileBg'
              })
            ]
          : agent.unpricedRequests
            ? [seg(' · no price', { fg: 'faintText', bg: 'tileBg' })]
            : [])
      ]
      const footer: Line = attention
        ? [
            seg(agent.detail ?? 'waiting for your answer', { fg: 'needsYou', bg: 'tileBg' }),
            seg('   y yes · a always · n no', { fg: 'mutedText', bg: 'tileBg' })
          ]
        : id === this.expanded
          ? [seg(`Ctrl+] back to the grid`, { fg: 'faintText', bg: 'tileBg' })]
          : agent.worktree
            ? [seg(`⎇ ${agent.worktree.branch}`, { fg: 'faintText', bg: 'tileBg' })]
            : focused
              ? [seg('⏎ open', { fg: 'faintText', bg: 'tileBg' })]
              : []
      const lines = frame(this.theme, {
        width: rect.width,
        height: rect.height,
        state: attention ? 'attention' : focused ? 'focused' : 'normal',
        title,
        titleRight,
        footer,
        ...(pulse ? { borderColor: pulse.color } : {})
      })
      lines.forEach((line, row) => canvas.put(rect.x, rect.y + row, line, rect.width))
      // The logo badge sits after the corner and the focus marker.
      this.logoSlots.push({
        row: rect.y,
        col: rect.x + (focused && !attention ? 4 : 3),
        harness: agent.harness
      })
      const body = inner(rect)
      if (this.modal) {
        // Under a dialog the terminal is shown dimmed and still.
        const grid = screen?.view.snapshot()
        for (let row = 0; row < body.height; row++) {
          const text =
            grid && row < grid.rows
              ? gridRowText(grid, Math.max(0, grid.rows - body.height) + row)
              : ''
          canvas.put(
            body.x,
            body.y + row,
            [seg(fitText(text, body.width), { fg: 'faintText', bg: 'tileBg' })],
            body.width
          )
        }
      } else {
        canvas.clear(body.x, body.y, body.width, body.height)
        tiles.set(id, body)
      }
    })
    return tiles
  }

  private drawEmpty(canvas: Canvas, area: Rect, now: number | undefined): void {
    const lines = wordmark(this.theme, {})
    const swept =
      this.motion.animate && Date.now() - this.startedAt < 1200
        ? animations.wordmarkSweep(this.theme, now, this.startedAt).lines
        : lines
    const top = area.y + Math.max(0, Math.floor(area.height / 2) - lines.length - 2)
    const left = area.x + Math.max(0, Math.floor((area.width - wordmarkWidth()) / 2))
    swept.forEach((line, i) => canvas.put(left, top + i, line, area.width))
    const hint: Line = [
      seg('No agents yet. ', { fg: 'mutedText', bg: 'appBg' }),
      seg('c', { fg: 'accentText', bg: 'appBg', bold: true }),
      seg(' starts one — or run ', { fg: 'mutedText', bg: 'appBg' }),
      seg('nsq run claude "…"', { fg: 'text', bg: 'appBg' })
    ]
    const hintWidth = hint.reduce((w, s) => w + [...s.text].length, 0)
    canvas.put(
      area.x + Math.max(0, Math.floor((area.width - hintWidth) / 2)),
      top + swept.length + 2,
      hint
    )
  }

  private drawFooter(canvas: Canvas): void {
    const { y, width } = this.layout.footer
    canvas.fill(0, y, width, 1, { bg: 'headerBg' })
    if (this.dictation?.state === 'downloading') {
      const label = ` dictation model ${Math.floor((this.dictation.progress ?? 0) * 100)}% `
      canvas.put(0, y, [
        seg(label, { fg: 'mutedText', bg: 'headerBg' }),
        ...animations.progressBar(this.theme, this.motion.animate ? Date.now() : undefined, {
          width: Math.min(40, width - label.length - 2),
          ratio: this.dictation.progress
        })
      ])
      return
    }
    if (this.toast) {
      canvas.put(0, y, [
        seg(fitText(` ${this.toast.text}`, width), { fg: 'warning', bg: 'headerBg' })
      ])
      return
    }
    const selected = this.selected ? this.agents.get(this.selected) : undefined
    const hints: [string, string][] = this.expanded
      ? [
          ['Ctrl+]', 'grid'],
          ['', 'keys go to the agent']
        ]
      : selected && statusOf(selected) === 'needs-input'
        ? [
            ['y', 'yes'],
            ['a', 'always'],
            ['n', 'no'],
            ['⏎', 'open'],
            ['s', 'send'],
            ['c', 'new'],
            ['?', 'help'],
            ['q', 'quit']
          ]
        : [
            ['⏎', 'open'],
            ['s', 'send'],
            ['c', 'new'],
            ['i', 'interrupt'],
            ['x', 'stop'],
            ['m', 'model'],
            ['?', 'help'],
            ['q', 'quit']
          ]
    const line: Line = [seg(' ', { bg: 'headerBg' })]
    for (const [k, label] of hints) {
      if (k) line.push(seg(k, { fg: 'accentText', bg: 'headerBg', bold: true }))
      line.push(seg(` ${label}   `, { fg: 'mutedText', bg: 'headerBg' }))
    }
    canvas.put(0, y, line, width)
  }

  private box(canvas: Canvas, width: number, height: number, title: string): Rect {
    const w = Math.min(width, this.width - 4)
    const h = Math.min(height, this.height - 2)
    const x = Math.floor((this.width - w) / 2)
    const y = Math.floor((this.height - h) / 2)
    const lines = frame(this.theme, {
      width: w,
      height: h,
      state: 'focused',
      title: [seg(title, { fg: 'text', bg: 'tileBg', bold: true })],
      bg: 'tileBg'
    })
    lines.forEach((line, row) => canvas.put(x, y + row, line, w))
    return { x: x + 2, y: y + 1, width: w - 4, height: h - 2 }
  }

  private drawModal(canvas: Canvas): void {
    const modal = this.modal
    if (!modal) return
    const text = (r: Rect, row: number, line: Line): void => {
      if (row < r.height) canvas.put(r.x, r.y + row, line, r.width)
    }
    switch (modal.kind) {
      case 'help': {
        const rows: [string, string][] = [
          ['↑↓←→ hjkl, Tab', 'select an agent'],
          ['Enter / double-click', 'open full screen (Ctrl+] back)'],
          ['y  a  n', 'answer a permission prompt: yes / always / no'],
          ['s / S', 'send a prompt / send when the turn is done'],
          ['c', 'start a new agent'],
          ['i', 'interrupt the turn'],
          ['x / X', 'stop / remove the agent'],
          ['r', 'restart (resumes the session)'],
          ['m', 'model (OpenRouter models with --provider openrouter)'],
          ['d', 'dangerous mode on/off'],
          ['R', 'rename'],
          ['[ ]', 'previous / next page of tiles'],
          ['b', 'sidebar on/off'],
          ['v', 'dictate into the agent (also the global hotkey) — pasted, never sent'],
          ['q', 'quit — agents keep running (nsq down stops them)']
        ]
        const r = this.box(canvas, 90, rows.length + 4, 'Keys')
        rows.forEach(([k, d], i) =>
          text(r, i + 1, [
            seg(fitText(k, 24), { fg: 'accentText', bg: 'tileBg', bold: true }),
            seg(d, { fg: 'bodyText', bg: 'tileBg' })
          ])
        )
        return
      }
      case 'message': {
        const r = this.box(canvas, 70, 7, modal.title)
        text(r, 1, [seg(modal.body, { fg: 'bodyText', bg: 'tileBg' })])
        text(r, 3, [seg('any key to close', { fg: 'faintText', bg: 'tileBg' })])
        return
      }
      case 'confirm': {
        const r = this.box(canvas, 64, 7, modal.title)
        text(r, 1, [seg(modal.body, { fg: 'bodyText', bg: 'tileBg' })])
        text(r, 3, [
          seg('y', { fg: 'accentText', bg: 'tileBg', bold: true }),
          seg(' yes   ', { fg: 'mutedText', bg: 'tileBg' }),
          seg('n / Esc', { fg: 'accentText', bg: 'tileBg', bold: true }),
          seg(' no', { fg: 'mutedText', bg: 'tileBg' })
        ])
        return
      }
      case 'prompt': {
        const r = this.box(canvas, 80, 6, modal.title)
        text(r, 1, modal.field.render(r.width, true))
        text(r, 3, [seg('Enter send · Esc cancel', { fg: 'faintText', bg: 'tileBg' })])
        return
      }
      case 'models': {
        const r = this.box(canvas, 84, Math.min(24, this.height - 4), 'Model')
        text(r, 0, [
          seg('filter ', { fg: 'mutedText', bg: 'tileBg' }),
          ...modal.list.filter.render(r.width - 7, true)
        ])
        if (modal.loading)
          text(r, 2, [seg('loading the OpenRouter model list…', { fg: 'mutedText', bg: 'tileBg' })])
        if (modal.error) text(r, 2, [seg(modal.error, { fg: 'danger', bg: 'tileBg' })])
        const items = modal.list.visible()
        const rows = r.height - 3
        if (modal.list.selected < modal.list.scroll) modal.list.scroll = modal.list.selected
        if (modal.list.selected >= modal.list.scroll + rows)
          modal.list.scroll = modal.list.selected - rows + 1
        items.slice(modal.list.scroll, modal.list.scroll + rows).forEach((item, i) => {
          const sel = modal.list.scroll + i === modal.list.selected
          const bg = sel ? 'selectionBg' : 'tileBg'
          text(r, i + 2, [
            seg(fitText(` ${item.id}`, Math.floor(r.width * 0.6)), { fg: 'text', bg, bold: sel }),
            seg(fitText(item.price, r.width - Math.floor(r.width * 0.6)), { fg: 'mutedText', bg })
          ])
        })
        return
      }
      case 'new': {
        const f = modal.form
        const r = this.box(canvas, 76, 16, 'New agent')
        const label = (row: number, name: string, focus: boolean): void =>
          text(r, row, [
            seg(fitText(name, 12), {
              fg: focus ? 'accentText' : 'mutedText',
              bg: 'tileBg',
              bold: focus
            })
          ])
        const field = (row: number, index: number, name: string, input: TextField): void => {
          const focus = FORM_FIELDS[f.field] === FORM_FIELDS[index]
          label(row, name, focus)
          canvas.put(r.x + 12, r.y + row, input.render(r.width - 12, focus))
        }
        const toggle = (
          row: number,
          index: number,
          name: string,
          on: boolean,
          hint: string
        ): void => {
          const focus = FORM_FIELDS[f.field] === FORM_FIELDS[index]
          label(row, name, focus)
          canvas.put(r.x + 12, r.y + row, [
            seg(on ? '[x] ' : '[ ] ', {
              fg: on ? 'accentText' : 'mutedText',
              bg: 'tileBg',
              bold: focus
            }),
            seg(hint, { fg: 'faintText', bg: 'tileBg' })
          ])
        }
        label(0, 'Harness', f.field === 0)
        const harnessLine: Line = []
        HARNESS_CHOICES.forEach((choice, i) => {
          const on = i === f.harness
          harnessLine.push(...(on ? logoBadge(this.theme, choice.id) : []))
          harnessLine.push(
            seg(` ${choice.label} `, {
              fg: on ? 'text' : 'faintText',
              bg: on ? 'selectionBg' : 'tileBg',
              bold: on
            })
          )
          harnessLine.push(seg(' ', { bg: 'tileBg' }))
        })
        canvas.put(r.x + 12, r.y, harnessLine, r.width - 12)
        field(2, 1, 'Name', f.name)
        field(3, 2, HARNESS_CHOICES[f.harness].id === 'command' ? 'Command' : 'Prompt', f.prompt)
        field(4, 3, 'Folder', f.cwd)
        toggle(6, 4, 'Worktree', f.worktree, 'its own git branch and checkout')
        toggle(7, 5, 'OpenRouter', f.openrouter, 'route through OpenRouter (needs a key)')
        field(8, 6, 'Model', f.model)
        toggle(9, 7, 'Dangerous', f.dangerous, 'approve its permission prompts')
        const startFocus = FORM_FIELDS[f.field] === 'start'
        text(r, 11, [
          seg(' Start ', {
            fg: startFocus ? 'accentFg' : 'text',
            bg: startFocus ? 'accent' : 'chipBg',
            bold: true
          }),
          seg('   Tab/↑↓ move · ←→ harness · Space toggle · F2 models · Esc cancel', {
            fg: 'faintText',
            bg: 'tileBg'
          })
        ])
        return
      }
    }
  }

  // ---- input ---------------------------------------------------------------------------------

  private readonly onInput = (chunk: string | Buffer): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (this.escTimer) {
      clearTimeout(this.escTimer)
      this.escTimer = null
    }
    for (const event of this.parser.feed(text)) this.handle(event)
    // A lone Escape may be the start of a sequence: decide after a beat.
    if (this.parser.waiting) {
      this.escTimer = setTimeout(() => {
        this.escTimer = null
        for (const event of this.parser.flush()) this.handle(event)
      }, 40)
    }
  }

  private handle(event: InputEvent): void {
    if (process.env['NSQ_TUI_TRACE']) {
      try {
        appendFileSync(
          process.env['NSQ_TUI_TRACE'],
          `${JSON.stringify({ ...event, seq: undefined })}
`
        )
      } catch {
        // tracing only
      }
    }
    if (event.type === 'focus') {
      if (event.focused) animations.sharedTicker.resume('background')
      else animations.sharedTicker.pause('background')
      return
    }
    if (this.modal) {
      this.handleModal(event)
      this.schedule()
      return
    }
    if (this.expanded) {
      this.handleExpanded(event)
      return
    }
    if (event.type === 'mouse') this.handleMouse(event)
    else if (event.type === 'key') this.handleKey(event)
    this.schedule()
  }

  /** Full screen: everything goes to the agent except the way back and clicks on our chrome. */
  private handleExpanded(event: InputEvent): void {
    const id = this.expanded as string
    const screen = this.screens.get(id)
    // Only the key itself (as a control byte, kitty CSI u or modifyOtherKeys), never a
    // sequence that merely contains the byte.
    const detach = event.type === 'key' ? findDetachKey(event.seq, this.detachKey) : null
    if (detach && detach.at === 0 && detach.length === event.seq.length) {
      this.collapse()
      return
    }
    if (event.type === 'mouse') {
      const rect = this.tileAreas.get(id)
      const body = rect ? inner(rect) : undefined
      if (body && contains(body, event.x, event.y)) {
        const modes = screen?.view.modes()
        if (modes && modes.mouseTracking !== 'none') {
          this.client.post({
            t: 'input',
            id,
            data: encodeMouse(event, event.x - body.x, event.y - body.y)
          })
        }
        return
      }
      if (event.action === 'down') this.handleMouse(event)
      this.schedule()
      return
    }
    if (event.type === 'paste') {
      const modes = screen?.view.modes()
      this.client.post({
        t: 'input',
        id,
        data: modes?.bracketedPaste ? encodePaste(event.text, { bracketedPaste: true }) : event.text
      })
      return
    }
    const modes = screen?.view.modes()
    const data = modes?.applicationCursorKeys ? applicationCursor(event.seq) : event.seq
    this.client.post({ t: 'input', id, data })
  }

  private expand(id: string): void {
    this.expanded = id
    this.selected = id
    animations.sharedTicker.pause('attached')
    this.prev = undefined
    this.stdout.write('\x1b[2J')
    this.schedule()
  }

  private collapse(): void {
    this.expanded = null
    animations.sharedTicker.resume('attached')
    this.prev = undefined
    this.stdout.write('\x1b[?25l\x1b[2J')
    this.schedule()
  }

  private handleMouse(event: MouseEvent): void {
    if (event.action !== 'down' || typeof event.button !== 'number') {
      if (event.button === 'wheelup' || event.button === 'wheeldown')
        this.moveSelection(event.button === 'wheelup' ? -1 : 1, true)
      return
    }
    const sidebar = this.layout.sidebar
    if (sidebar && contains(sidebar, event.x, event.y)) {
      const row = this.sidebarRows.find((r) => r.y === event.y)
      if (row?.workspace === '+new') this.openNewAgent()
      else if (row?.workspace) {
        const ws = this.workspaces().find((w) => w.path === row.workspace)
        if (ws?.agents[0]) this.select(ws.agents[0].id)
      } else if (row?.id) this.click(row.id)
      return
    }
    for (const [id, rect] of this.tileAreas) {
      if (contains(rect, event.x, event.y)) {
        this.click(id)
        return
      }
    }
  }

  private click(id: string): void {
    const now = Date.now()
    const double = this.lastClick.id === id && now - this.lastClick.at < DOUBLE_CLICK_MS
    this.lastClick = { at: now, id }
    if (this.expanded && this.expanded !== id) {
      this.expand(id)
      return
    }
    this.select(id)
    if (double) this.expand(id)
  }

  private select(id: string): void {
    this.selected = id
  }

  /** Moves the selection: in the grid by position, or through all agents in order. */
  private moveSelection(step: number, linear = false, vertical = false): void {
    const all = linear ? this.ordered() : (this.currentWorkspace()?.agents ?? [])
    if (all.length === 0) return
    let index = all.findIndex((a) => a.id === this.selected)
    if (index < 0) index = 0
    if (vertical && !linear) {
      const shape = gridShape(all.length, this.layout.main)
      index = Math.max(0, Math.min(all.length - 1, index + step * shape.cols))
    } else index = (index + step + all.length) % all.length
    this.selected = all[index].id
  }

  private toastMessage(text: string): void {
    this.toast = { text, until: Date.now() + 4000 }
    setTimeout(() => this.schedule(), 4100)
  }

  private request(promise: Promise<unknown>, ok?: string): void {
    promise.then(
      (data) => {
        const warnings = (data as { warnings?: string[] } | undefined)?.warnings
        if (warnings?.length) this.toastMessage(warnings.join('; '))
        else if (ok) this.toastMessage(ok)
        this.schedule()
      },
      (error: unknown) => {
        this.toastMessage(error instanceof Error ? error.message : String(error))
        this.schedule()
      }
    )
  }

  private handleKey(event: KeyEvent): void {
    const agent = this.selected ? this.agents.get(this.selected) : undefined
    const status = agent ? statusOf(agent) : undefined
    const k = event.name
    if ((event.ctrl && k === 'c') || k === 'q') {
      this.quit()
      return
    }
    switch (k) {
      case 'left':
      case 'h':
        this.moveSelection(-1)
        return
      case 'right':
      case 'l':
        this.moveSelection(1)
        return
      case 'up':
      case 'k':
        this.moveSelection(-1, false, true)
        return
      case 'down':
      case 'j':
        this.moveSelection(1, false, true)
        return
      case 'tab':
        this.moveSelection(event.shift ? -1 : 1, true)
        return
      case '?':
        this.modal = { kind: 'help' }
        return
      case 'c':
      case '+':
        this.openNewAgent()
        return
      case 'v':
        this.toggleDictation()
        return
      case 'b':
        this.sidebarMode = this.layout.sidebar ? 'hidden' : 'shown'
        this.prev = undefined
        return
      case '[':
        this.page = Math.max(0, this.page - 1)
        this.selectFirstOnPage()
        return
      case ']':
        this.page += 1
        this.selectFirstOnPage()
        return
    }
    if (!agent) return
    switch (k) {
      case 'enter':
        if (agent.running) this.expand(agent.id)
        else this.request(this.client.request({ t: 'start', id: agent.id }))
        return
      case 'y':
      case 'a':
      case 'n':
        if (status === 'needs-input') {
          this.client.post({
            t: 'answer',
            id: agent.id,
            key: k === 'y' ? 'yes' : k === 'a' ? 'always' : 'no'
          })
        }
        return
      case 's':
      case 'S': {
        const whenDone = k === 'S'
        this.modal = {
          kind: 'prompt',
          title: `${whenDone ? 'When the turn is done, send' : 'Send'} to ${agent.name}`,
          field: new TextField(),
          submit: (text) =>
            this.request(
              this.client.request({
                t: 'send',
                id: agent.id,
                text,
                whenDone: whenDone || status === 'working'
              })
            )
        }
        return
      }
      case 'R':
        this.modal = {
          kind: 'prompt',
          title: `Rename ${agent.name}`,
          field: new TextField(agent.name),
          submit: (name) => this.request(this.client.request({ t: 'rename', id: agent.id, name }))
        }
        return
      case 'i':
        this.client.post({ t: 'interrupt', id: agent.id })
        return
      case 'x':
        if (!agent.running) return
        this.modal = {
          kind: 'confirm',
          title: `Stop ${agent.name}?`,
          body: 'The process ends; r or Enter starts it again on the same session.',
          yes: () => this.request(this.client.request({ t: 'stop', id: agent.id }))
        }
        return
      case 'X':
        this.modal = {
          kind: 'confirm',
          title: `Remove ${agent.name}?`,
          body: agent.worktree
            ? `Stops it and forgets it. The worktree ${agent.worktree.branch} is kept.`
            : 'Stops it and forgets it.',
          yes: () => this.request(this.client.request({ t: 'remove', id: agent.id }))
        }
        return
      case 'r':
        this.request(
          this.client.request({ t: agent.running ? 'restart' : 'start', id: agent.id }),
          `${agent.running ? 'restarting' : 'starting'} ${agent.name}`
        )
        return
      case 'd':
        if (agent.dangerousMode) {
          this.request(
            this.client.request({ t: 'set', id: agent.id, dangerousMode: false }),
            'dangerous mode off'
          )
        } else {
          this.modal = {
            kind: 'confirm',
            title: 'Dangerous mode',
            body: `${agent.name} will approve its own permission prompts.`,
            yes: () =>
              this.request(
                this.client
                  .request({ t: 'set', id: agent.id, dangerousMode: true })
                  .then((r) =>
                    (r as { restartNeeded?: boolean }).restartNeeded
                      ? { warnings: ['applies after a restart (r)'] }
                      : r
                  )
              )
          }
        }
        return
      case 'm':
        this.openModels(agent.id, (model) =>
          this.request(
            this.client
              .request({ t: 'set', id: agent.id, model })
              .then((r) =>
                (r as { restartNeeded?: boolean }).restartNeeded
                  ? { warnings: [`model ${model}: applies after a restart (r)`] }
                  : r
              )
          )
        )
        return
    }
  }

  private selectFirstOnPage(): void {
    const agents = this.currentWorkspace()?.agents ?? []
    const shape = gridShape(agents.length, this.layout.main)
    const pages = Math.max(1, Math.ceil(agents.length / shape.perPage))
    this.page = Math.min(this.page, pages - 1)
    const first = agents[this.page * shape.perPage]
    if (first) this.selected = first.id
  }

  private openNewAgent(): void {
    const selected = this.selected ? this.agents.get(this.selected) : undefined
    this.modal = {
      kind: 'new',
      form: {
        harness: 0,
        field: 2,
        name: new TextField('', 'automatic'),
        prompt: new TextField('', 'optional first prompt'),
        cwd: new TextField(selected?.workspace ?? this.launchCwd),
        model: new TextField('', 'default'),
        worktree: false,
        openrouter: false,
        dangerous: false
      }
    }
  }

  private openModels(agentId: string | undefined, onPick: (id: string) => void): void {
    const list = new PickList<{ id: string; name: string; price: string }>(
      [],
      (m) => m.id,
      (m) => m.name
    )
    const modal: Modal = { kind: 'models', agentId, list, loading: true, onPick }
    this.modal = modal
    this.client
      .request<{ id: string; name: string; promptPerMTok?: number; completionPerMTok?: number }[]>({
        t: 'models'
      })
      .then(
        (models) => {
          list.items = models.map((m) => ({
            id: m.id,
            name: m.name,
            price:
              m.promptPerMTok !== undefined && m.completionPerMTok !== undefined
                ? `$${m.promptPerMTok} / $${m.completionPerMTok} per M`
                : ''
          }))
          modal.loading = false
          this.schedule()
        },
        (error: unknown) => {
          modal.loading = false
          modal.error = error instanceof Error ? error.message : String(error)
          this.schedule()
        }
      )
  }

  private handleModal(event: InputEvent): void {
    const modal = this.modal as Modal
    if (event.type === 'mouse') return
    if (event.type === 'focus') return
    const key = event.type === 'key' ? event : undefined
    if (key?.name === 'escape' && modal.kind !== 'models') {
      this.modal = null
      return
    }
    switch (modal.kind) {
      case 'help':
      case 'message':
        this.modal = null
        return
      case 'confirm':
        if (key?.name === 'y' || key?.name === 'enter') {
          this.modal = null
          modal.yes()
        } else if (key?.name === 'n') this.modal = null
        return
      case 'prompt':
        if (key?.name === 'enter') {
          const text = modal.field.value.trim()
          this.modal = null
          if (text) modal.submit(text)
          return
        }
        modal.field.handle(event as KeyEvent)
        return
      case 'models':
        if (key?.name === 'escape') {
          this.modal = null
          return
        }
        if (key?.name === 'enter') {
          const pick = modal.list.current()
          this.modal = null
          if (pick) modal.onPick(pick.id)
          return
        }
        modal.list.handle(event as KeyEvent)
        return
      case 'new':
        this.handleForm(modal.form, event as KeyEvent)
        return
    }
  }

  private handleForm(form: NewAgentForm, event: KeyEvent): void {
    const name = event.type === 'key' ? event.name : ''
    const current = FORM_FIELDS[form.field]
    if (name === 'tab' || name === 'down' || name === 'up') {
      const step = name === 'up' || (name === 'tab' && event.shift) ? -1 : 1
      form.field = (form.field + step + FORM_FIELDS.length) % FORM_FIELDS.length
      return
    }
    if (name === 'f2' || (event.ctrl && name === 'o')) {
      const back = this.modal
      this.openModels(undefined, (id) => {
        form.model.value = id
        form.model.cursor = id.length
        form.openrouter = true
        this.modal = back
      })
      return
    }
    if (name === 'enter' && current !== 'start' && current !== 'harness') {
      form.field = FORM_FIELDS.indexOf('start')
      return
    }
    switch (current) {
      case 'harness':
        if (name === 'left')
          form.harness = (form.harness + HARNESS_CHOICES.length - 1) % HARNESS_CHOICES.length
        else if (name === 'right' || name === 'space')
          form.harness = (form.harness + 1) % HARNESS_CHOICES.length
        else if (name === 'enter') form.field = 2
        return
      case 'worktree':
      case 'openrouter':
      case 'dangerous':
        if (name === 'space' || name === 'enter' || name === 'x') form[current] = !form[current]
        return
      case 'start':
        if (name === 'enter' || name === 'space') this.startFromForm(form)
        return
      default:
        form[current].handle(event)
    }
  }

  private startFromForm(form: NewAgentForm): void {
    const harness = HARNESS_CHOICES[form.harness].id
    const prompt = form.prompt.value.trim()
    if (harness === 'command' && !prompt) {
      this.toastMessage('a command agent needs a command')
      return
    }
    this.modal = null
    const command =
      harness === 'command'
        ? prompt.match(/"[^"]*"|\S+/g)?.map((part) => part.replace(/^"|"$/g, ''))
        : undefined
    this.request(
      this.client
        .request<{ agent: AgentView; warnings: string[] }>({
          t: 'run',
          spec: {
            harness,
            cwd: form.cwd.value.trim() || this.launchCwd,
            ...(form.name.value.trim() ? { name: form.name.value.trim() } : {}),
            ...(harness !== 'command' && prompt ? { prompt } : {}),
            ...(command ? { command } : {}),
            ...(form.worktree ? { worktree: true } : {}),
            ...(form.openrouter ? { provider: 'openrouter' as const } : {}),
            ...(form.model.value.trim() ? { model: form.model.value.trim() } : {}),
            ...(form.dangerous ? { dangerousMode: true } : {})
          }
        })
        .then((result) => {
          this.noteAgent(result.agent)
          this.selected = result.agent.id
          return result
        })
    )
  }
}

export async function runDashboard(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error('the dashboard needs an interactive terminal (try `nsq ls`)')
  }
  const client = await DaemonClient.open('dashboard')
  await new Dashboard(client).run()
}
