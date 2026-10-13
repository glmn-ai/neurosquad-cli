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
  queryGraphics,
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
  createScrollback,
  bufferTop,
  createTermView,
  encodePaste,
  gridRowText,
  linkAt,
  selectionText,
  wheelKeys,
  wheelTarget,
  type CellPos,
  type Compositor,
  type Selection,
  type Scrollback,
  type Tile,
  type TermView
} from '@neurosquad/term-view'
import { formatUsd, type HarnessId } from '@neurosquad/core'
import { DaemonClient } from '../client/client.js'
import {
  busyAgents,
  daemonIsOlder,
  handOver,
  waitingText,
  type Handover
} from '../client/handover.js'
import { DaemonTooOldError, errorText as describeError } from '../client/outdated.js'
import { VERSION } from '../version.js'
import { readConfig } from '../config.js'
import { findDetachKey, parseDetachKey } from '../attach.js'
import { HARNESS_LABEL, costLabel, elapsed } from '../format.js'
import type { AgentView, DaemonEvent, PhoneView, UpdateView } from '../protocol.js'
import { updateBadge } from '../update/describe.js'
import { expandTilde, paths, tildePath } from '../paths.js'
import { copyToSystemClipboard, openInBrowser, osc52 } from '../desktop.js'
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
import { applyScrollKey, applyWheel, scrollKey, scrolledLabel } from './scrolling.js'
import { PhonePanel, type PanelTab } from './phonePanel.js'
import { bindDictation, type DictationBinding } from '../dictation.js'
import {
  endpointsLabel,
  listProviders,
  providerKey,
  providerModels,
  removeProvider,
  saveProvider
} from '../providers.js'
import { nextPreset, presetsLine, providerChoices } from './providerChoices.js'
import { customProviderAddress, type CustomProvider } from '@neurosquad/core'
import { modelNeedsOpenRouter, modelSwitchText, type ModelSwitchApplied } from '../modelRules.js'

/** Leaves the dashboard's terminal modes: colours, focus, paste, mouse, cursor, alternate screen. */
const RESTORE = '\x1b[0m\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l'
const FRAME_MS = 33
const DOUBLE_CLICK_MS = 400
const RESIZE_DEBOUNCE_MS = 150

interface AgentScreen {
  view: TermView
  /** Where the person is in the agent's scrollback (0 = the live screen). */
  scroll: Scrollback
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
      /** The list's source, for the title and the loading line (OpenRouter by default). */
      source?: string
    }
  | { kind: 'message'; title: string; body: string }
  | {
      kind: 'providers'
      list: PickList<CustomProvider & { hasKey: boolean }>
      busy?: string
    }
  | { kind: 'provider-add'; form: ProviderForm }
  | { kind: 'phone'; panel: PhonePanel }

interface NewAgentForm {
  harness: number
  field: number
  name: TextField
  prompt: TextField
  cwd: TextField
  model: TextField
  worktree: boolean
  /** '' = the harness's own login, 'openrouter', or one of the user's providers (its id). */
  provider: string
  dangerous: boolean
}

/** Add (or re-test) one of the user's own servers. */
interface ProviderForm {
  field: number
  name: TextField
  url: TextField
  /** Shown masked; empty keeps the stored key (none for a new provider). */
  key: TextField
  busy: boolean
  error?: string
}
const PROVIDER_FIELDS = ['name', 'url', 'key', 'save'] as const

const HARNESS_CHOICES: { id: HarnessId; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex-cli', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'command', label: 'Command' }
]
const DEFAULT_MODEL_ROW = 'default — the harness’s own login and model'
const FORM_FIELDS = [
  'harness',
  'name',
  'prompt',
  'cwd',
  'worktree',
  'provider',
  'model',
  'dangerous',
  'start'
] as const

/** An error for a person; a daemon too old for the request explains itself (U restarts it). */
const errorText = (error: unknown): string => describeError(error, 'tui')

function statusOf(agent: AgentView): AgentStatus {
  if (!agent.running || agent.status === 'exited') return 'exited'
  return (agent.status ?? 'idle') as AgentStatus
}

/** Working, but nsq flagged it quiet (no new output for its threshold): its episode. */
function quietOf(agent: AgentView): AgentView['quiet'] {
  return statusOf(agent) === 'working' ? agent.quiet : undefined
}

/** "quiet 7m — check it" (what the tile, the sidebar and help say). */
export function quietLabel(quiet: NonNullable<AgentView['quiet']>, now = Date.now()): string {
  return `quiet ${elapsed(quiet.since, now)} — check it`
}

/** What a quiet agent's screen showed: the prompt it seems to ask, else its last line. */
export function quietContext(quiet: NonNullable<AgentView['quiet']>): string {
  if (quiet.asking) return `looks like it's asking: ${quiet.asking}`
  if (quiet.line) return `last line: ${quiet.line}`
  return 'no new output'
}

export class Dashboard {
  private readonly theme: Theme
  private readonly compositor: Compositor
  private readonly parser = new InputParser()
  private readonly agents = new Map<string, AgentView>()
  private readonly screens = new Map<string, AgentScreen>()
  private readonly detachKey: string
  private readonly motion: animations.MotionPolicy
  private graphics: ReturnType<typeof detectGraphicsFromEnv>
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
  /** A left button held down over an agent's text: a drag selects, a click opens a link. */
  private drag: { id: string; anchor: CellPos; moved: boolean } | null = null
  /** Text selected in an agent's tile (shown inverted until the next click or key). */
  private selection: { id: string; range: Selection } | null = null
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private wantedSizes = new Map<string, { cols: number; rows: number }>()
  private unsubscribeTicker: (() => void) | null = null
  private escTimer: ReturnType<typeof setTimeout> | null = null
  private readonly startedAt = Date.now()
  private toast: { text: string; until: number } | null = null
  private closed = false
  private resolveClosed: () => void = () => {}
  /**
   * How the dashboard ended: closed by the person, handed over to an updated daemon, or leaving
   * so this (newer) nsq can restart an older daemon on itself (`handover-now`: U, busy or not).
   */
  private outcome: DashboardOutcome = 'quit'
  /** The daemon is older than this nsq and waits for busy agents before it restarts on it. */
  private handover: Extract<Handover, { kind: 'waiting' }> | null = null
  /** Left through U in the phone panel: the next dashboard opens it again on this tab. */
  reopenPhone: PanelTab | undefined
  private phoneOnStart: PanelTab | undefined
  private update: UpdateView | null = null
  private announcedUpdate = false
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

  /** Before run: the daemon is older and the hand-over waits for busy agents. */
  waitForHandover(wait: Extract<Handover, { kind: 'waiting' }>): void {
    this.handover = wait
  }

  /** Before run: open the phone panel on this tab once the dashboard is up (after U in it). */
  openPhoneOnStart(tab: PanelTab): void {
    this.phoneOnStart = tab
  }

  /** Before run: a note to show once the dashboard is up. */
  notice(text: string): void {
    this.toastMessage(text)
  }

  /** An older daemon that the client restarts (before 0.2.1): as soon as no agent is busy. */
  private considerHandover(): void {
    const wait = this.handover
    if (!wait || wait.byDaemon || this.closed) return
    if (busyAgents([...this.agents.values()]).length) return
    this.outcome = 'handover'
    this.quit()
  }

  async run(): Promise<DashboardOutcome> {
    // Image logos: known terminals come from the environment; the rest (Windows Terminal, VS Code,
    // Konsole…) are asked once. The probe never holds the first frame back: it owns stdin for at
    // most its timeout (150 ms), then our input handler takes over with whatever was typed meanwhile.
    const probing =
      this.graphics.source === 'unknown' && this.theme.logos === 'images' && this.stdin.isTTY
        ? queryGraphics(this.stdin, this.stdout, { tmux: this.graphics.tmux })
        : null
    this.stdout.write(
      '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[2J'
    )
    const takeInput = (typedMeanwhile: string): void => {
      if (this.closed) return
      if (this.stdin.isTTY) this.stdin.setRawMode(true)
      this.stdin.setEncoding('utf8')
      this.stdin.resume()
      this.stdin.on('data', this.onInput)
      if (typedMeanwhile) this.onInput(typedMeanwhile)
    }
    if (probing) {
      void probing.then((probe) => {
        if (!this.closed && probe.protocol !== 'none') {
          this.graphics = {
            protocol: probe.protocol,
            source: 'query',
            tmux: this.graphics.tmux,
            reason: 'the terminal answered the graphics probe'
          }
          this.prev = undefined // repaint everything once, now with the logos
          this.schedule()
        }
        takeInput(probe.rest)
      })
    } else {
      takeInput('')
    }
    this.stdout.on('resize', this.onResize)
    const off = this.client.on((event) => this.onEvent(event))
    this.client.onClose(() => {
      // The daemon hands over to its updated version: reconnect instead of leaving.
      if (this.update?.state === 'restarting') {
        this.outcome = 'restart'
        this.quit()
      } else {
        this.quit('the daemon stopped')
      }
    })
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
    if (this.phoneOnStart) this.openPhonePanel(this.phoneOnStart)
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
    return this.outcome
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
    for (const screen of this.screens.values()) {
      screen.scroll.dispose()
      screen.view.dispose()
    }
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
      screen = { view, scroll: createScrollback(view), generation: 0, statusSince: Date.now() }
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
        this.considerHandover()
        break
      case 'agent':
        this.noteAgent(event.agent)
        this.considerHandover()
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
      case 'phones':
        this.phone = event.phone
        if (this.modal?.kind === 'phone') this.modal.panel.phoneChanged()
        break
      case 'update':
        this.update = event.update
        if (
          !this.announcedUpdate &&
          event.update.updatedFrom &&
          event.update.updatedAt &&
          Date.now() - event.update.updatedAt < 10 * 60_000
        ) {
          this.announcedUpdate = true
          this.toastMessage(
            `nsq updated to ${event.update.current} (was ${event.update.updatedFrom})`
          )
        }
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
    screen?.scroll.dispose()
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
        const scrollOffset = screen.scroll.offset
        // Scrolled back, the agent's cursor is somewhere below the view: not shown.
        const selection = this.selection?.id === id ? this.selection.range : null
        const options =
          id === this.expanded
            ? { showCursor: scrollOffset === 0, fit: 'follow' as const, scrollOffset, selection }
            : { fit: 'follow' as const, scrollOffset, selection }
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
    if (!this.expanded || (this.screens.get(this.expanded)?.scroll.scrolled ?? false))
      text += '\x1b[?25l'
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
    if (quietOf(agent)) return seg(this.theme.unicode ? '◌' : '?', { fg: 'quiet', bg, bold: true })
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
    const quiet = agents.filter((a) => quietOf(a)).length
    const working = agents.filter((a) => statusOf(a) === 'working' && !quietOf(a)).length
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
      seg(ws ? `  ${tildePath(ws.path)}` : '', { fg: 'mutedText', bg: 'headerBg' })
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
      ...(quiet
        ? [
            seg(`${needs ? '· ' : ''}${this.theme.unicode ? '◌' : '?'} ${quiet} quiet  `, {
              fg: 'quiet',
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
      ...this.updateSegments(),
      ...this.phoneBadge(),
      seg('? help ', { fg: 'faintText', bg: 'headerBg' })
    ]
    const rightWidth = right.reduce((w, s) => w + [...s.text].length, 0)
    canvas.put(0, 0, left, width - rightWidth - 1)
    canvas.put(width - rightWidth, 0, right)
  }

  private phone: PhoneView | null = null

  /** The update, while there is something to say: found, installing, installed (U), failed. */
  private updateSegments(): Seg[] {
    if (this.handover) {
      const text = `daemon ${this.handover.from} → ${VERSION} when agents are free · U`
      return [
        seg(`${fitText(text, Math.max(16, Math.floor(this.width / 3)))}  `, {
          fg: 'warning',
          bg: 'headerBg'
        })
      ]
    }
    const badge = updateBadge(this.update)
    if (!badge) return []
    return [
      seg(`${fitText(badge.text, Math.max(16, Math.floor(this.width / 3)))}  `, {
        fg: badge.tone === 'warn' ? 'warning' : 'accentText',
        bg: 'headerBg'
      })
    ]
  }

  /** U: what the update is doing, and the way to apply or install it now. */
  private showUpdate(): void {
    const from = this.handover?.from ?? this.client.daemonVersion
    if (this.handover || daemonIsOlder(from)) {
      const busy = busyAgents([...this.agents.values()])
      this.modal = {
        kind: 'confirm',
        title: `Restart the daemon on ${VERSION} now?`,
        body: [
          `The daemon runs nsq ${from}; this is ${VERSION}. It restarts on ${VERSION} by itself once no agent is busy.`,
          'Running agents stop and come back on their sessions (like nsq down / nsq up).',
          ...(busy.length ? [`Busy now: ${busy.join(', ')} — their current turn is cut off.`] : []),
          'Other nsq windows (nsq attach) close; open them again after.'
        ].join('\n'),
        yes: () => {
          this.outcome = 'handover-now'
          this.quit()
        }
      }
      return
    }
    const update = this.update
    if (!update) return
    const agents = [...this.agents.values()].filter((agent) => agent.running)
    switch (update.state) {
      case 'installed': {
        const busy = agents.filter((agent) => {
          const status = statusOf(agent)
          return status === 'working' || status === 'needs-input' || (agent.queued ?? 0) > 0
        })
        const commands = agents.filter((agent) => agent.harness === 'command')
        const lines = [
          `The daemon restarts on ${update.installed}; this dashboard reconnects.`,
          ...(agents.length
            ? ['Running agents stop and come back on their sessions (like nsq down / nsq up).']
            : []),
          ...(commands.length
            ? [`Commands start over: ${commands.map((agent) => agent.name).join(', ')}.`]
            : []),
          ...(busy.length
            ? [
                `Busy now: ${busy.map((agent) => agent.name).join(', ')} — the restart waits until they are done.`
              ]
            : []),
          'Other nsq windows (nsq attach) close; open them again after.'
        ]
        this.modal = {
          kind: 'confirm',
          title: `Restart nsq on ${update.installed}?`,
          body: lines.join('\n'),
          yes: () =>
            this.request(
              this.client
                .request<{ waitingFor?: string[] }>({ t: 'update', action: 'apply' })
                .then((result) => ({
                  warnings: result.waitingFor?.length
                    ? [`restarts when done: ${result.waitingFor.join('; ')}`]
                    : []
                }))
            )
        }
        return
      }
      case 'available':
        if (update.canInstall && !update.reason) {
          this.modal = {
            kind: 'confirm',
            title: `Install nsq ${update.latest}?`,
            body: `With ${update.manager}, in the background (log: ${paths.updateLog()}).\nThe agents keep running; the daemon restarts on it once they are idle.`,
            yes: () => this.request(this.client.request({ t: 'update', action: 'install' }))
          }
        } else {
          this.modal = {
            kind: 'message',
            title: `nsq ${update.latest} is out`,
            body: `${update.reason ? `${update.reason}. ` : ''}Run: ${update.command ?? 'nsq update'}`
          }
        }
        return
      case 'failed':
      case 'waiting':
        this.modal = {
          kind: 'message',
          title: update.state === 'failed' ? 'The update failed' : `nsq ${update.latest} is out`,
          body: `${update.reason ?? ''}${update.command ? ` — run: ${update.command}` : ''} (log: ${paths.updateLog()})`
        }
        return
      case 'installing':
        this.toastMessage(`installing nsq ${update.latest} with ${update.manager}…`)
        return
      default:
        this.toastMessage(
          update.auto === 'off'
            ? `nsq ${update.current}; automatic updates are off (${update.offReason ?? 'off'}) — nsq update checks by hand`
            : `nsq ${update.current} is up to date`
        )
    }
  }

  /**
   * Who is connected from a phone — always in the header while anyone is: the count and the
   * first device. Phone access on with nobody connected shows a quiet "phone on".
   */
  private phoneBadge(): Seg[] {
    const phone = this.phone
    if (!phone) return []
    const phones = phone.phones
    // Online is never quiet: reachable from the internet is said in the header, in red.
    const online = phone.online
    const reach: Seg[] =
      online?.state === 'running'
        ? [
            seg(' ONLINE ', { fg: 'accentFg', bg: 'danger', bold: true }),
            seg('  ', { bg: 'headerBg' })
          ]
        : online?.state === 'installing'
          ? [
              seg(`cloudflared ${Math.floor((online.progress ?? 0) * 100)}%  `, {
                fg: 'accentText',
                bg: 'headerBg'
              })
            ]
          : online?.state === 'starting'
            ? [seg('going online…  ', { fg: 'accentText', bg: 'headerBg' })]
            : online?.state === 'error'
              ? [seg('online failed (Q)  ', { fg: 'danger', bg: 'headerBg' })]
              : []
    if (!phones.length) {
      if (reach.length) return reach
      return phone.running ? [seg('phone on  ', { fg: 'faintText', bg: 'headerBg' })] : []
    }
    const first = phones[0]!
    const who = `${first.device} ${first.address}${first.via ? ' (internet)' : ''}${phones.length > 1 ? ` +${phones.length - 1}` : ''}`
    return [
      ...reach,
      seg(` ${phones.length} phone${phones.length > 1 ? 's' : ''} `, {
        fg: 'accentFg',
        bg: 'accent',
        bold: true
      }),
      seg(` ${fitText(who, 34)}  `, { fg: 'accentText', bg: 'headerBg' })
    ]
  }

  /** p: who is connected, with the way to cut everyone off. */
  private showPhones(): void {
    const phone = this.phone
    if (!phone?.running && !phone?.phones.length) {
      this.modal = {
        kind: 'message',
        title: 'Phone access',
        body: 'Off. Turn it on with: nsq phone on --lan'
      }
      return
    }
    const lines = phone.phones.length
      ? phone.phones.map(
          (p) =>
            `${p.device}  ${p.address}${p.via ? '  (internet)' : ''}  since ${new Date(p.firstSeen).toLocaleTimeString()}${p.open ? '  live' : ''}`
        )
      : ['Nobody is connected.']
    const online = phone.online
    const onlineLines =
      online?.state === 'running'
        ? [
            `ONLINE at ${online.url ?? '?'} — anyone with this link and token`,
            'can control your agents. O turns it off.'
          ]
        : online?.state === 'error'
          ? [`Online failed: ${online.error ?? 'unknown error'}`]
          : online
            ? [`Online: ${online.state}…`]
            : ['Not online (O: from anywhere, through a Cloudflare tunnel).']
    this.modal = {
      kind: 'confirm',
      title: `Phone access — ${phone.lan ? 'local network' : 'this machine only'}, port ${phone.port ?? '?'}`,
      body: `${lines.join('\n')}\n\n${onlineLines.join('\n')}\n\nNew pairing token? Every connected phone is cut off (Q shows the new QR).`,
      yes: () =>
        this.request(this.client.request({ t: 'phone', action: 'rotate' }), 'new pairing token')
    }
  }

  /** O: online on/off — an explicit yes, with what it means, both ways. */
  private toggleOnline(): void {
    const phone = this.phone
    const online = phone?.online && phone.online.state !== 'error' ? phone.online : undefined
    const lan = phone?.running ? phone.lan : undefined
    if (online) {
      this.modal = {
        kind: 'confirm',
        title: 'Go offline?',
        body: 'The tunnel stops; phones connected from the internet are cut off.\nPhone access on this machine / the Wi-Fi stays as it is.',
        yes: () =>
          this.request(
            this.client.request({
              t: 'phone',
              action: 'on',
              online: false,
              ...(lan !== undefined ? { lan } : {})
            }),
            'offline: the tunnel is stopped'
          )
      }
      return
    }
    this.modal = {
      kind: 'confirm',
      title: 'Go online?',
      body: [
        'Phone access from anywhere through a Cloudflare tunnel (https): your named',
        'tunnel if you set one up, else a quick tunnel.',
        'Anyone with this link and the pairing token can control your agents.',
        "A quick tunnel's address changes every time it starts: the QR to pair is shown next (Q).",
        'The first time, cloudflared is downloaded (sha256-checked) into the nsq home.',
        'Turn it off: O again, or nsq phone off.'
      ].join('\n'),
      yes: () => {
        this.toastMessage('going online…')
        this.client
          .request({
            t: 'phone',
            action: 'on',
            online: true,
            ...(lan !== undefined ? { lan } : {})
          })
          .then(
            (data) => {
              const status = (data as { status?: { online?: PhoneView['online'] } }).status
              if (status?.online?.state === 'running') {
                // Online is pairing: the QR, right here (unless another dialog is open now).
                if (!this.modal) this.openPhonePanel()
                else this.toastMessage(`ONLINE at ${status.online.url} — the QR: Q`)
              } else {
                this.toastMessage(
                  `could not go online: ${status?.online?.error ?? 'the tunnel did not start'}`
                )
              }
              this.schedule()
            },
            (error: unknown) => {
              this.errorToast(error)
              this.schedule()
            }
          )
      }
    }
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
      const quietHere = !needs && ws.agents.some((a) => quietOf(a))
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
          : quietHere
            ? seg(this.theme.unicode ? '◌' : '?', { fg: 'quiet', bg: 'sidebarBg', bold: true })
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
        const quiet = quietOf(agent)
        const right: Seg = quiet
          ? seg(`quiet ${elapsed(quiet.since, now ?? Date.now())}`, { fg: 'quiet', bg, bold: true })
          : status === 'needs-input'
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
      const quiet = quietOf(agent)
      const badge = logoBadge(this.theme, agent.harness)
      const title: Line = [
        ...badge,
        seg(' ', { bg: 'tileBg' }),
        seg(agent.name, { fg: 'text', bg: 'tileBg', bold: true }),
        seg('  ', { bg: 'tileBg' }),
        this.statusSeg(agent, now, 'tileBg'),
        quiet
          ? seg(` ${quietLabel(quiet, now ?? Date.now())}`, {
              fg: 'quiet',
              bg: 'tileBg',
              bold: true
            })
          : seg(` ${style.label}`, { fg: style.role, bg: 'tileBg', bold: style.bold }),
        ...(agent.dangerousMode ? [seg('  dangerous', { fg: 'danger', bg: 'tileBg' })] : []),
        ...(agent.queued
          ? [seg(`  +${agent.queued} queued`, { fg: 'mutedText', bg: 'tileBg' })]
          : [])
      ]
      const titleRight: Line = [
        seg(
          `${HARNESS_LABEL[agent.harness]}${agent.model ? ` · ${agent.model}` : ''}${agent.provider === 'custom' && agent.customProviderId ? ` @${agent.customProviderId}` : ''} · ${elapsed(agent.statusAt ?? agent.createdAt)}`,
          { fg: 'mutedText', bg: 'tileBg' }
        ),
        ...(agent.costPico !== undefined || agent.unpricedRequests
          ? [
              seg(` · ${costLabel(agent)}`, {
                fg: costLabel(agent) === 'no price' ? 'faintText' : 'mutedText',
                bg: 'tileBg'
              })
            ]
          : [])
      ]
      const scrolledBack = screen?.scroll.offset ?? 0
      const footer: Line = attention
        ? [
            seg(agent.detail ?? 'waiting for your answer', { fg: 'needsYou', bg: 'tileBg' }),
            seg('   y yes · a always · n no', { fg: 'mutedText', bg: 'tileBg' })
          ]
        : quiet && scrolledBack === 0
          ? [
              // No answer keys: nsq does not know what it waits for. Open it and look.
              seg(quietContext(quiet), { fg: 'quiet', bg: 'tileBg' }),
              seg(id === this.expanded ? '' : '   ⏎ open', {
                fg: 'mutedText',
                bg: 'tileBg'
              })
            ]
          : scrolledBack > 0
            ? [
                seg(scrolledLabel(scrolledBack, id === this.expanded), {
                  fg: 'accentText',
                  bg: 'tileBg'
                })
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
    const open = this.expanded ? this.screens.get(this.expanded) : undefined
    const hints: [string, string][] = this.expanded
      ? [
          ['Ctrl+]', 'grid'],
          ...(open && !open.view.modes().alternateScreen
            ? ([['wheel, Shift+PgUp', 'scroll back']] as [string, string][])
            : []),
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
      case 'phone':
        modal.panel.draw(canvas, this.theme, { width: this.width, height: this.height })
        return
      case 'help': {
        const rows: [string, string][] = [
          ['↑↓←→ hjkl, Tab', 'select an agent'],
          ['Enter / double-click', 'open full screen (Ctrl+] back)'],
          ['drag / click a link', 'copy the text / open the link in the browser'],
          ['wheel, Shift+PgUp/PgDn', 'scroll an agent back (Shift+Home/End: oldest / live)'],
          ['y  a  n', 'answer a permission prompt: yes / always / no'],
          ['s / S', 'send a prompt / send when the turn is done'],
          ['c', 'start a new agent'],
          ['i', 'interrupt the turn'],
          ['x / X', 'stop / remove the agent'],
          ['r', 'restart (resumes the session)'],
          ['m', 'model: OpenRouter’s (switches the agent to it), "default", or its own server’s'],
          ['P', 'providers: your own servers — llama.cpp, Ollama, LM Studio, vLLM…'],
          ['d', 'dangerous mode on/off'],
          ['R', 'rename'],
          ['[ ]', 'previous / next page of tiles'],
          ['b', 'sidebar on/off'],
          ['v', 'dictate into the agent (also the global hotkey) — pasted, never sent'],
          ['p', 'phones: who is connected; a new pairing token cuts them off'],
          ['O', 'online on/off: phone access from anywhere (Cloudflare tunnel)'],
          ['Q', 'phone panel: the pairing QR, online / LAN, notifications (ntfy)'],
          ['U', 'update: install it now, or restart onto an installed one'],
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
        const lines = modal.body.split('\n')
        const r = this.box(
          canvas,
          Math.max(64, Math.min(96, Math.max(...lines.map((l) => l.length)) + 6)),
          lines.length + 6,
          modal.title
        )
        lines.forEach((line, i) => text(r, 1 + i, [seg(line, { fg: 'bodyText', bg: 'tileBg' })]))
        text(r, lines.length + 2, [
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
        const r = this.box(
          canvas,
          84,
          Math.min(24, this.height - 4),
          modal.source ? `Model — ${modal.source}` : 'Model'
        )
        text(r, 0, [
          seg('filter ', { fg: 'mutedText', bg: 'tileBg' }),
          ...modal.list.filter.render(r.width - 7, true)
        ])
        if (modal.loading)
          text(r, 3, [
            seg(`loading the ${modal.source ?? 'OpenRouter'} model list…`, {
              fg: 'mutedText',
              bg: 'tileBg'
            })
          ])
        if (modal.error) text(r, 3, [seg(modal.error, { fg: 'danger', bg: 'tileBg' })])
        const items = modal.list.visible()
        const rows = r.height - 3
        if (modal.list.selected < modal.list.scroll) modal.list.scroll = modal.list.selected
        if (modal.list.selected >= modal.list.scroll + rows)
          modal.list.scroll = modal.list.selected - rows + 1
        items.slice(modal.list.scroll, modal.list.scroll + rows).forEach((item, i) => {
          const sel = modal.list.scroll + i === modal.list.selected
          const bg = sel ? 'selectionBg' : 'tileBg'
          text(r, i + 2, [
            seg(fitText(` ${item.id || item.name}`, Math.floor(r.width * 0.6)), {
              fg: item.id ? 'text' : 'mutedText',
              bg,
              bold: sel
            }),
            seg(fitText(item.price, r.width - Math.floor(r.width * 0.6)), { fg: 'mutedText', bg })
          ])
        })
        return
      }
      case 'providers': {
        const r = this.box(
          canvas,
          90,
          Math.min(20, this.height - 4),
          'Providers — your own servers'
        )
        const items = modal.list.items
        if (items.length === 0)
          text(r, 1, [
            seg(
              'None yet. a adds one: llama.cpp, Ollama, LM Studio, vLLM, SGLang, Unsloth Studio',
              {
                fg: 'mutedText',
                bg: 'tileBg'
              }
            )
          ])
        items.forEach((p, i) => {
          if (i + 1 >= r.height - 2) return
          const sel = i === modal.list.selected
          const bg = sel ? 'selectionBg' : 'tileBg'
          text(r, i + 1, [
            seg(fitText(` ${p.id}`, 16), { fg: 'text', bg, bold: sel }),
            seg(fitText(customProviderAddress(p), 24), { fg: 'mutedText', bg }),
            seg(fitText(endpointsLabel(p), 26), { fg: 'mutedText', bg }),
            seg(fitText(`${p.models.length} model${p.models.length === 1 ? '' : 's'}`, 11), {
              fg: 'mutedText',
              bg
            }),
            seg(fitText(p.hasKey ? 'key ••••' : 'no key', Math.max(0, r.width - 77)), {
              fg: 'faintText',
              bg
            })
          ])
        })
        text(r, r.height - 1, [
          seg(modal.busy ?? 'a add · t test · Enter models · x remove · Esc close', {
            fg: modal.busy ? 'accentText' : 'faintText',
            bg: 'tileBg'
          })
        ])
        return
      }
      case 'provider-add': {
        const f = modal.form
        const r = this.box(canvas, 84, 13, 'Add a provider')
        const row = (at: number, index: number, name: string, input: TextField): void => {
          const focus = f.field === index
          text(r, at, [
            seg(fitText(name, 8), {
              fg: focus ? 'accentText' : 'mutedText',
              bg: 'tileBg',
              bold: focus
            })
          ])
          canvas.put(r.x + 8, r.y + at, input.render(r.width - 8, focus))
        }
        row(0, 0, 'Name', f.name)
        row(1, 1, 'URL', f.url)
        row(2, 2, 'Key', f.key)
        const presets = presetsLine().split(' · ')
        text(r, 4, [
          seg(fitText(`F2 defaults: ${presets.slice(0, 3).join(' · ')}`, r.width), {
            fg: 'faintText',
            bg: 'tileBg'
          })
        ])
        text(r, 5, [
          seg(fitText(`             ${presets.slice(3).join(' · ')}`, r.width), {
            fg: 'faintText',
            bg: 'tileBg'
          })
        ])
        text(r, 6, [
          seg('The key is optional (local servers) and goes to the OS keyring, never a file.', {
            fg: 'faintText',
            bg: 'tileBg'
          })
        ])
        if (f.error) text(r, 8, [seg(fitText(f.error, r.width), { fg: 'danger', bg: 'tileBg' })])
        const saveFocus = f.field === 3
        text(r, 10, [
          seg(f.busy ? ' Testing… ' : ' Test & save ', {
            fg: saveFocus ? 'accentFg' : 'text',
            bg: saveFocus ? 'accent' : 'chipBg',
            bold: true
          }),
          seg('   Tab move · F2 defaults · Esc back', { fg: 'faintText', bg: 'tileBg' })
        ])
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
        {
          const focus = FORM_FIELDS[f.field] === 'provider'
          const { choices, unfit } = providerChoices(HARNESS_CHOICES[f.harness].id)
          const choice = choices.find((c) => c.id === f.provider) ?? choices[0]!
          label(7, 'Provider', focus)
          canvas.put(r.x + 12, r.y + 7, [
            seg(choices.length > 1 ? '◂ ' : '  ', { fg: 'mutedText', bg: 'tileBg' }),
            seg(` ${choice.label} `, {
              fg: 'text',
              bg: focus ? 'selectionBg' : 'chipBg',
              bold: focus
            }),
            seg(choices.length > 1 ? ' ▸  ' : '    ', { fg: 'mutedText', bg: 'tileBg' }),
            seg(choice.hint, { fg: 'faintText', bg: 'tileBg' })
          ])
          if (focus && unfit.length > 0) {
            text(r, 12, [
              seg(
                fitText(
                  `not offered: ${unfit.map((u) => `${u.id} — ${u.reason}`).join('; ')}`,
                  r.width
                ),
                { fg: 'faintText', bg: 'tileBg' }
              )
            ])
          }
        }
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
    if (event.type === 'key' || event.type === 'paste' || this.modal) this.clearSelection()
    if (this.modal) {
      this.handleModal(event)
      this.schedule()
      return
    }
    if (event.type === 'mouse' && this.selectWithMouse(event)) {
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
        if (screen) this.mouseOnAgent(id, screen, event, body, true)
        return
      }
      if (event.action === 'down') this.handleMouse(event)
      this.schedule()
      return
    }
    if (!screen) return
    const modes = screen.view.modes()
    if (event.type === 'key') {
      const action = scrollKey(event, {
        scrolled: screen.scroll.scrolled,
        alternate: modes.alternateScreen
      })
      if (action) {
        if (applyScrollKey(screen.scroll, action)) this.scrolled(screen)
        return
      }
    }
    // Anything that goes to the agent brings the live screen back first.
    if (screen.scroll.toBottom()) this.scrolled(screen)
    if (event.type === 'paste') {
      this.client.post({
        t: 'input',
        id,
        data: modes.bracketedPaste ? encodePaste(event.text, { bracketedPaste: true }) : event.text
      })
      return
    }
    const data = modes.applicationCursorKeys ? applicationCursor(event.seq) : event.seq
    this.client.post({ t: 'input', id, data })
  }

  /**
   * A mouse event over an agent's terminal (`body`): to the agent when it asked for the mouse;
   * a wheel notch otherwise scrolls the scrollback — or, on the alternate screen of the open
   * agent (`open`), becomes cursor keys the way terminals send it (a TUI scrolls itself).
   */
  private mouseOnAgent(
    id: string,
    screen: AgentScreen,
    event: MouseEvent,
    body: Rect,
    open: boolean
  ): void {
    const wheel = event.button === 'wheelup' || event.button === 'wheeldown'
    const modes = screen.view.modes()
    const target = wheelTarget(modes)
    if (target === 'mouse') {
      // In the grid only the wheel goes to the agent: a click there selects the tile.
      if (open || wheel) {
        // Over the tile's frame in the grid: the nearest cell of the terminal.
        const x = Math.max(0, Math.min(body.width - 1, event.x - body.x))
        const y = Math.max(0, Math.min(body.height - 1, event.y - body.y))
        this.client.post({ t: 'input', id, data: encodeMouse(event, x, y) })
      }
      return
    }
    if (!wheel) return
    if (target === 'keys') {
      if (open) {
        this.client.post({
          t: 'input',
          id,
          data: wheelKeys(event.button === 'wheelup' ? 'up' : 'down', modes)
        })
      }
      return
    }
    if (applyWheel(screen.scroll, event)) this.scrolled(screen)
  }

  /** The agent's text cell under the mouse, clamped to its tile; null off every tile. */
  private cellAt(id: string, event: MouseEvent, clamp: boolean): CellPos | null {
    const rect = this.tileAreas.get(id)
    const screen = this.screens.get(id)
    if (!rect || !screen) return null
    const body = inner(rect)
    if (!clamp && !contains(body, event.x, event.y)) return null
    const viewport = screen.tile?.renderer.viewport ?? { left: 0, top: 0 }
    const x = Math.max(0, Math.min(body.width - 1, event.x - body.x)) + viewport.left
    const y = Math.max(0, Math.min(body.height - 1, event.y - body.y)) + viewport.top
    return {
      line: bufferTop(screen.view, screen.scroll.offset) + y,
      col: Math.min(x, screen.view.cols - 1)
    }
  }

  /**
   * The dashboard has the mouse, so the host terminal can no longer select text or open links;
   * we do it: drag over an agent's text to copy it, click a link to open it. An open agent that
   * asked for the mouse itself (a full-screen TUI) still gets it. Returns whether it was ours.
   */
  private selectWithMouse(event: MouseEvent): boolean {
    if (event.button !== 0) return false
    if (event.action === 'down') {
      this.clearSelection()
      const id =
        this.expanded ?? [...this.tileAreas].find(([, r]) => contains(r, event.x, event.y))?.[0]
      const screen = id ? this.screens.get(id) : undefined
      if (!id || !screen) return false
      if (this.expanded && wheelTarget(screen.view.modes()) === 'mouse') return false
      const anchor = this.cellAt(id, event, false)
      if (!anchor) return false
      this.drag = { id, anchor, moved: false }
      // In the grid a press still selects the tile; a double click opens it (and no link).
      if (!this.expanded) {
        this.click(id)
        if (this.expanded) this.drag = null
      }
      return true
    }
    const drag = this.drag
    if (!drag) return false
    const at = this.cellAt(drag.id, event, true)
    if (event.action === 'move') {
      if (at && (drag.moved || at.line !== drag.anchor.line || at.col !== drag.anchor.col)) {
        drag.moved = true
        this.setSelection(drag.id, { start: drag.anchor, end: at })
      }
      return true
    }
    // Released.
    this.drag = null
    const screen = this.screens.get(drag.id)
    if (!screen) return true
    if (drag.moved && this.selection) {
      const text = selectionText(screen.view, this.selection.range)
      if (text.trim()) {
        this.copy(text)
        this.toastMessage(`copied ${text.length} characters`, 2000)
      } else this.clearSelection()
      return true
    }
    const link = linkAt(screen.view, drag.anchor)
    if (link) this.openLink(link)
    return true
  }

  private setSelection(id: string, range: Selection | null): void {
    this.selection = range ? { id, range } : null
    // The next frame hands it to the tile; a change of the selection alone repaints by diff.
    this.schedule()
  }

  private clearSelection(): void {
    if (this.selection) this.setSelection(this.selection.id, null)
    this.drag = null
  }

  /** To the host terminal's clipboard (OSC 52, reaches it over SSH too) and, locally, the system's. */
  private copy(text: string): void {
    this.stdout.write(osc52(text))
    if (!isRemoteSession(process.env)) copyToSystemClipboard(text)
  }

  /** Over SSH the browser would open on the wrong machine: the link is copied instead. */
  private openLink(url: string): void {
    const copyInstead = (): void => {
      this.copy(url)
      this.toastMessage(`link copied: ${url}`, 3000)
    }
    // No opener on this machine (no xdg-open) fails after the fact: copied then.
    if (!isRemoteSession(process.env) && openInBrowser(url, copyInstead)) {
      this.toastMessage(`opening ${url}`, 3000)
      return
    }
    copyInstead()
  }

  /** The scroll position changed: repaint the tile and its footer. */
  private scrolled(screen: AgentScreen): void {
    screen.tile?.update()
    this.schedule()
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
      if (event.button !== 'wheelup' && event.button !== 'wheeldown') return
      // Over a tile the wheel scrolls that agent; anywhere else (the sidebar) it moves the selection.
      if (!this.expanded) {
        for (const [id, rect] of this.tileAreas) {
          if (!contains(rect, event.x, event.y)) continue
          const screen = this.screens.get(id)
          if (screen) this.mouseOnAgent(id, screen, event, inner(rect), false)
          return
        }
      }
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

  private toastMessage(text: string, ms = 4000): void {
    this.toast = { text, until: Date.now() + ms }
    setTimeout(() => this.schedule(), ms + 100)
  }

  /** A failed request: its error; a daemon too old for it explains why and offers U, longer. */
  private errorToast(error: unknown): void {
    this.toastMessage(errorText(error), error instanceof DaemonTooOldError ? 10_000 : 4000)
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
        this.errorToast(error)
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
    // Shift+PgUp / PgDn / Home / End scroll the selected agent's tile.
    const selectedScreen = agent ? this.screens.get(agent.id) : undefined
    if (selectedScreen && event.shift) {
      const action = scrollKey(event, {
        scrolled: false,
        alternate: selectedScreen.view.modes().alternateScreen
      })
      if (action) {
        if (applyScrollKey(selectedScreen.scroll, action)) this.scrolled(selectedScreen)
        return
      }
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
      case 'p':
        this.showPhones()
        return
      case 'O':
        this.toggleOnline()
        return
      case 'Q':
        this.openPhonePanel()
        return
      case 'U':
        this.showUpdate()
        return
      case 'P':
        this.openProviders()
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
      case 'm': {
        if (agent.harness === 'command') {
          this.toastMessage('a command agent has no model to pick')
          return
        }
        if (agent.provider === 'custom' && agent.customProviderId) {
          // An agent on one of the user's own servers: that server's models, the provider stays.
          // (Its ids look like OpenRouter slugs — `qwen/qwen3-coder-30b` — but are the server's.)
          this.openCustomModels(agent.customProviderId, (model) =>
            this.request(
              this.client
                .request<{ applied?: ModelSwitchApplied; warnings?: string[] }>({
                  t: 'set',
                  id: agent.id,
                  model
                })
                .then((r) => ({
                  warnings: [
                    modelSwitchText(model, 'custom', r.applied, agent.customProviderId),
                    ...(r.warnings ?? [])
                  ]
                }))
            )
          )
          return
        }
        // A pick from OpenRouter's list puts the agent on OpenRouter too: on its own login the
        // harness does not know `vendor/model` slugs ("model not found"). "Default" goes back.
        this.openModels(agent.id, (picked) => {
          const model = picked || undefined
          const provider = model ? ('openrouter' as const) : undefined
          this.request(
            this.client
              .request<{ applied?: ModelSwitchApplied; warnings?: string[] }>({
                t: 'set',
                id: agent.id,
                model: model ?? null,
                provider: provider ?? null
              })
              .then((r) => ({
                warnings: [modelSwitchText(model, provider, r.applied), ...(r.warnings ?? [])]
              }))
          )
        })
        return
      }
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
        cwd: new TextField(tildePath(selected?.workspace ?? this.launchCwd)),
        model: new TextField('', 'default'),
        worktree: false,
        provider: '',
        dangerous: false
      }
    }
  }

  private openModels(agentId: string | undefined, onPick: (id: string) => void): void {
    // First row: back to the harness's own login and default model (picked as '').
    const fallback = { id: '', name: DEFAULT_MODEL_ROW, price: '' }
    const list = new PickList<{ id: string; name: string; price: string }>(
      [fallback],
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
          list.items = [
            fallback,
            ...models.map((m) => ({
              id: m.id,
              name: m.name,
              price:
                m.promptPerMTok !== undefined && m.completionPerMTok !== undefined
                  ? `$${m.promptPerMTok} / $${m.completionPerMTok} per M`
                  : ''
            }))
          ]
          modal.loading = false
          this.schedule()
        },
        (error: unknown) => {
          modal.loading = false
          modal.error = errorText(error)
          this.schedule()
        }
      )
  }

  /** The model picker over one of the user's own servers (asked now; the stored list if it is down). */
  private openCustomModels(providerId: string, onPick: (id: string) => void): void {
    const list = new PickList<{ id: string; name: string; price: string }>(
      [],
      (m) => m.id,
      (m) => m.name
    )
    const modal: Modal = { kind: 'models', list, loading: true, onPick, source: providerId }
    this.modal = modal
    providerModels(providerId).then(
      ({ models, error }) => {
        list.items = models.map((m) => ({
          id: m.id,
          name: m.name ?? '',
          price: m.contextWindow ? `${m.contextWindow.toLocaleString('en-US')} ctx` : ''
        }))
        modal.loading = false
        if (error) modal.error = `${error}${models.length ? ' — the stored list' : ''}`
        this.schedule()
      },
      (error: unknown) => {
        modal.loading = false
        modal.error = errorText(error)
        this.schedule()
      }
    )
  }

  private openProviders(): void {
    const list = new PickList<CustomProvider & { hasKey: boolean }>(
      [],
      (p) => p.id,
      (p) => customProviderAddress(p)
    )
    const modal: Modal = { kind: 'providers', list }
    this.modal = modal
    this.refreshProviders(modal)
  }

  private refreshProviders(modal: Extract<Modal, { kind: 'providers' }>): void {
    let providers: CustomProvider[] = []
    try {
      providers = listProviders()
    } catch (error) {
      modal.busy = String(error)
    }
    void Promise.all(
      providers.map(async (p) => ({ ...p, hasKey: Boolean(await providerKey(p.id)) }))
    ).then(
      (items) => {
        modal.list.items = items
        modal.list.selected = Math.min(modal.list.selected, Math.max(0, items.length - 1))
        this.schedule()
      },
      (error: unknown) => {
        modal.busy = errorText(error)
        this.schedule()
      }
    )
  }

  private handleProviders(modal: Extract<Modal, { kind: 'providers' }>, key: KeyEvent): void {
    const current = modal.list.items[modal.list.selected]
    switch (key.name) {
      case 'escape':
        this.modal = null
        return
      case 'up':
      case 'down':
        modal.list.selected = Math.max(
          0,
          Math.min(modal.list.items.length - 1, modal.list.selected + (key.name === 'up' ? -1 : 1))
        )
        return
      case 'a':
      case '+':
        this.modal = {
          kind: 'provider-add',
          form: {
            field: 0,
            name: new TextField('', 'e.g. lmstudio'),
            url: new TextField('', 'e.g. http://localhost:1234 (F2: defaults)'),
            key: new TextField('', 'optional — local servers need none', true),
            busy: false
          }
        }
        return
      case 'enter':
        if (current) this.openCustomModels(current.id, () => this.openProviders())
        return
      case 't':
        if (!current || modal.busy) return
        modal.busy = `testing ${current.id}…`
        void saveProvider(current.id, undefined, 'keep').then(
          (result) => {
            modal.busy = undefined
            this.toastMessage(
              result.ok
                ? `${current.id}: ${result.test.models.length} models, endpoints: ${endpointsLabel(result.provider)}`
                : `${current.id}: ${result.error}`
            )
            this.refreshProviders(modal)
          },
          (error: unknown) => {
            modal.busy = undefined
            this.toastMessage(`${current.id}: ${errorText(error)}`)
            this.schedule()
          }
        )
        return
      case 'x':
      case 'delete':
        if (!current) return
        this.modal = {
          kind: 'confirm',
          title: `Remove ${current.id}?`,
          body: `${customProviderAddress(current)} and its key. Agents on it will not start until moved to another provider.`,
          yes: () => {
            void removeProvider(current.id).then(
              () => this.openProviders(),
              (error: unknown) => this.toastMessage(`${current.id}: ${errorText(error)}`)
            )
          }
        }
        return
    }
  }

  private handleProviderForm(form: ProviderForm, event: KeyEvent): void {
    if (form.busy) return
    const name = event.type === 'key' ? event.name : ''
    if (name === 'escape') {
      this.openProviders()
      return
    }
    if (name === 'tab' || name === 'down' || name === 'up') {
      const step = name === 'up' || (name === 'tab' && event.shift) ? -1 : 1
      form.field = (form.field + step + PROVIDER_FIELDS.length) % PROVIDER_FIELDS.length
      return
    }
    if (name === 'f2' || (event.ctrl && name === 'o')) {
      const preset = nextPreset(form.url.value, event.shift ? -1 : 1)
      form.url.value = preset.url
      form.url.cursor = preset.url.length
      if (!form.name.value.trim()) {
        form.name.value = preset.name
        form.name.cursor = preset.name.length
      }
      return
    }
    const field = PROVIDER_FIELDS[form.field]
    if (name === 'enter') {
      if (field !== 'save') {
        form.field = PROVIDER_FIELDS.indexOf('save')
        return
      }
      const id = form.name.value.trim().toLowerCase()
      const url = form.url.value.trim()
      if (!id || !url) {
        form.error = 'a name and the server address, please'
        return
      }
      form.busy = true
      form.error = undefined
      const keyText = form.key.value.trim()
      void saveProvider(id, url, keyText ? { set: keyText } : 'keep').then(
        (result) => {
          form.busy = false
          if (!result.ok) {
            form.error = result.error
            this.schedule()
            return
          }
          form.key.value = ''
          this.toastMessage(
            `${result.provider.id}: ${result.test.models.length} models, endpoints: ${endpointsLabel(result.provider)}`
          )
          if (this.modal?.kind === 'provider-add') this.openProviders()
          this.schedule()
        },
        (error: unknown) => {
          form.busy = false
          form.error = errorText(error)
          this.schedule()
        }
      )
      return
    }
    if (field !== 'save') form[field].handle(event)
  }

  private handleModal(event: InputEvent): void {
    const modal = this.modal as Modal
    if (event.type === 'mouse') return
    if (event.type === 'focus') return
    const key = event.type === 'key' ? event : undefined
    if (
      key?.name === 'escape' &&
      modal.kind !== 'models' &&
      modal.kind !== 'providers' &&
      modal.kind !== 'provider-add' &&
      modal.kind !== 'phone'
    ) {
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
      case 'providers':
        if (key) this.handleProviders(modal, key)
        return
      case 'provider-add':
        this.handleProviderForm(modal.form, event as KeyEvent)
        return
      case 'phone':
        if (key && modal.panel.handleKey(key) === 'close') this.closeModal()
        return
    }
  }

  /** Closes the dialog; the phone panel forgets the links it held. */
  private closeModal(): void {
    if (this.modal?.kind === 'phone') this.modal.panel.close()
    this.modal = null
  }

  /** Q: the phone panel — the pairing QR, online / LAN, notifications. */
  private openPhonePanel(tab: PanelTab = 'pairing'): void {
    if (this.modal?.kind === 'phone') this.modal.panel.close()
    const panel: PhonePanel = new PhonePanel(
      {
        request: (request) => this.client.request(request),
        phone: () => this.phone,
        redraw: () => this.schedule(),
        supports: (capability) => this.client.supports(capability),
        daemonVersion: () => this.client.daemonVersion,
        // U in the panel: the daemon restarts on this nsq at once (busy or not, like U on the
        // dashboard), and the panel opens again on the new one, on the same tab.
        ...(daemonIsOlder(this.client.daemonVersion)
          ? {
              restartDaemon: () => {
                this.reopenPhone = panel.tab
                this.outcome = 'handover-now'
                this.quit()
              }
            }
          : {})
      },
      tab
    )
    this.modal = { kind: 'phone', panel }
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
      const pick = (id: string): void => {
        form.model.value = id
        form.model.cursor = id.length
        this.modal = back
      }
      if (form.provider && form.provider !== 'openrouter') {
        // One of the user's own servers: its own models.
        this.openCustomModels(form.provider, pick)
        return
      }
      this.openModels(undefined, (id) => {
        pick(id)
        // An OpenRouter slug needs OpenRouter; "default" is the harness's own login.
        form.provider = id !== '' ? 'openrouter' : ''
      })
      return
    }
    if (name === 'enter' && current !== 'start' && current !== 'harness') {
      form.field = FORM_FIELDS.indexOf('start')
      return
    }
    switch (current) {
      case 'harness': {
        if (name === 'left')
          form.harness = (form.harness + HARNESS_CHOICES.length - 1) % HARNESS_CHOICES.length
        else if (name === 'right' || name === 'space')
          form.harness = (form.harness + 1) % HARNESS_CHOICES.length
        else if (name === 'enter') form.field = 2
        // A provider this harness cannot speak to is not kept.
        const { choices } = providerChoices(HARNESS_CHOICES[form.harness].id)
        if (!choices.some((c) => c.id === form.provider)) form.provider = ''
        return
      }
      case 'provider': {
        const { choices } = providerChoices(HARNESS_CHOICES[form.harness].id)
        const at = Math.max(
          0,
          choices.findIndex((c) => c.id === form.provider)
        )
        const step = name === 'left' ? -1 : name === 'right' || name === 'space' ? 1 : 0
        if (step === 0) return
        const next = choices[(at + step + choices.length) % choices.length]!
        if (next.id !== form.provider) {
          form.provider = next.id
          // A model belongs to its provider.
          form.model.value = ''
          form.model.cursor = 0
        }
        return
      }
      case 'worktree':
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
    const model = form.model.value.trim()
    let notice: string | undefined
    // Only on the own login: a custom server's ids look like slugs but are the server's.
    if (harness !== 'command' && form.provider === '' && modelNeedsOpenRouter(harness, model)) {
      // Typed by hand: a `vendor/model` slug only runs through OpenRouter.
      form.provider = 'openrouter'
      notice = `${model} is an OpenRouter model id: OpenRouter turned on`
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
            cwd: expandTilde(form.cwd.value.trim()) || this.launchCwd,
            ...(form.name.value.trim() ? { name: form.name.value.trim() } : {}),
            ...(harness !== 'command' && prompt ? { prompt } : {}),
            ...(command ? { command } : {}),
            ...(form.worktree ? { worktree: true } : {}),
            ...(form.provider === 'openrouter'
              ? { provider: 'openrouter' as const }
              : form.provider
                ? // Unchanged even if the server was removed meanwhile: the daemon refuses with the
                  // reason, never starts it on the CLI's own login.
                  { provider: 'custom' as const, customProviderId: form.provider }
                : {}),
            ...(harness !== 'command' && model ? { model } : {}),
            ...(form.dangerous ? { dangerousMode: true } : {})
          }
        })
        .then((result) => {
          this.noteAgent(result.agent)
          this.selected = result.agent.id
          return notice ? { warnings: [notice, ...result.warnings] } : result
        })
    )
  }
}

export type DashboardOutcome = 'quit' | 'restart' | 'handover' | 'handover-now'

/**
 * An older daemon (the package was upgraded under it): restarted on this copy now when nothing
 * is busy, else the dashboard says so and it happens once the agents are free (or on U).
 */
async function handOverForDashboard(
  client: DaemonClient,
  now: boolean
): Promise<{ client: DaemonClient; wait?: Extract<Handover, { kind: 'waiting' }>; note?: string }> {
  if (process.env['NSQ_NO_HANDOVER'] === '1') return { client }
  try {
    const result = await handOver(client, 'dashboard', { now })
    if (result.kind === 'restarted') {
      return {
        client: result.client,
        note: `the daemon was nsq ${result.from}; it now runs ${VERSION} (agents resumed on their sessions)`
      }
    }
    if (result.kind === 'waiting') return { client, wait: result }
    return { client }
  } catch (error) {
    const note = `could not restart the daemon on ${VERSION}: ${error instanceof Error ? error.message : String(error)}`
    return { client: client.isClosed ? await DaemonClient.open('dashboard') : client, note }
  }
}

export async function runDashboard(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error('the dashboard needs an interactive terminal (try `nsq ls`)')
  }
  let state = await handOverForDashboard(await DaemonClient.open('dashboard'), false)
  let reopenPhone: PanelTab | undefined
  for (;;) {
    const dashboard = new Dashboard(state.client)
    if (reopenPhone) dashboard.openPhoneOnStart(reopenPhone)
    if (state.wait) dashboard.waitForHandover(state.wait)
    if (state.note) dashboard.notice(state.note)
    else if (state.wait) dashboard.notice(waitingText(state.wait))
    const outcome = await dashboard.run()
    reopenPhone = dashboard.reopenPhone
    if (outcome === 'quit') return
    if (outcome === 'restart') {
      process.stdout.write('nsq: the daemon is restarting on the new version…\n')
      state = { client: await reconnect() }
      continue
    }
    process.stdout.write(`nsq: restarting the daemon on ${VERSION}…\n`)
    state = await handOverForDashboard(
      await DaemonClient.open('dashboard'),
      outcome === 'handover-now'
    )
  }
}

/** The updated daemon comes up after the old one exits: connect to it (never start another). */
async function reconnect(): Promise<DaemonClient> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      return await DaemonClient.open('dashboard', { autostart: false })
    } catch {
      // not up yet
    }
  }
  throw new Error(`the daemon did not come back within a minute (see ${paths.daemonLog()})`)
}
