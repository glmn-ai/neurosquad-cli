// The nsq daemon: one per user (per nsq home). It owns the agents' terminals,
// so agents keep running when the dashboard closes; it hosts the loopback
// endpoint the harnesses' hooks post to and the status machines; it talks to
// clients (the dashboard, `nsq attach`, `nsq ls`…) over a local socket.
import { connect, createServer, type Server, type Socket } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import {
  PtyHost,
  addWorktree,
  agentStatusSnapshot,
  configureStatusHub,
  decideNotification,
  emitHookFact,
  findOnPath,
  forgetAgentStatus,
  formatUsd,
  interruptKeys,
  noteUserInput,
  notificationText,
  observePtys,
  openCodeExecutable,
  openCodeVersionOf,
  isOpenCodeV2,
  prepareLaunch,
  receiveHook,
  readCodexUserConfig,
  removeWorktree,
  resolveHarnessCommand,
  startHookServer,
  statusLife,
  writeFileAtomic,
  type AgentHookEvent,
  type HookServer,
  type LaunchContext,
  type SpawnRequest
} from '@neurosquad/core'
import { ensureDir, ipcPath, paths } from '../paths.js'
import { readConfig, writeConfig } from '../config.js'
import {
  LineDecoder,
  PROTOCOL_VERSION,
  encode,
  type AgentView,
  type PhoneView,
  type DaemonEvent,
  type Request,
  type RequestWithId,
  type RunSpec
} from '../protocol.js'
import { AgentStore, type AgentRecord } from './store.js'
import { Screens } from './screens.js'
import { createNotifier, type Notifier } from './notify.js'
import { openRouterKey, setSecret, OPENROUTER_SECRET } from './secrets.js'
import { UsageTracker } from './usage.js'
import { KEY_GAP_MS, answerKeys, type AnswerKey } from './answers.js'
import { fetchOpenRouterModels } from './models.js'
import {
  checkModelChoice,
  modelNeedsOpenRouter,
  ownModelOnResume,
  type ModelSwitchApplied
} from '../modelRules.js'
import { PACKAGE_DIR, PACKAGE_NAME, VERSION } from '../version.js'
import { Updater, type UpdateView } from '../update/updater.js'
import { PhoneHostError, type PhoneAnswer, type PhoneHost } from '@neurosquad/remote'
import { PhoneAccess } from './phone.js'
import { NtfyPush } from './push.js'
import { lanAddresses } from '@neurosquad/remote'

const execFileAsync = promisify(execFile)

export interface DaemonState {
  pid: number
  ipc: string
  token: string
  hookPort: number
  version: string
  startedAt: number
}

interface Runtime {
  status?: AgentHookEvent['kind'] | 'exited'
  statusAt?: number
  detail?: string
  generation?: number
  cols: number
  rows: number
  queue: string[]
  /** A prompt to submit once the harness is ready (not for Claude/Codex: those take it as an argument). */
  pendingPrompt?: string
  costPico?: string
  unpriced?: number
  tokens?: number
  /** OpenCode 2.x (its plugin asks nsq about dangerous mode on every permission). */
  openCodeV2?: boolean
  /** When the person last typed or pasted into the agent (a model switch waits for a pause). */
  lastInputAt?: number
  /** A model/provider change waiting for the current turn to end (then: restart on the same session). */
  switchPending?: boolean
}

interface Client {
  socket: Socket
  authed: boolean
  name: string
  /** Agents whose output this client follows; `*` = all. */
  output: Set<string> | '*'
  /** Agents being joined: their chunks are held until the screen snapshot is sent. */
  joining: Map<string, string[]>
}

/**
 * The first prompt as launch arguments, where the harness takes one (it is
 * then submitted at start, with no timing guess): Claude Code and Codex take it
 * positionally, OpenCode 1.x as `--prompt`. Empty where it does not.
 */
function promptArgs(
  harness: AgentRecord['harness'],
  openCodeV2: boolean,
  prompt: string
): string[] {
  if (harness === 'claude-code' || harness === 'codex-cli') return [prompt]
  if (harness === 'opencode' && !openCodeV2) return ['--prompt', prompt]
  return []
}

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
/** A prompt is submitted after the harness has been quiet this long after start. */
const READY_QUIET_MS = 1500
const READY_MAX_MS = 30_000
/** After the ready marker shows, a beat for the input to take keys. */
const READY_SETTLE_MS = 1500
/** What a harness's screen shows once its prompt takes input. */
const READY_MARKERS: Partial<Record<AgentRecord['harness'], RegExp>> = {
  opencode: /ctrl\+p commands|Ask anything/
}
/** A model switch restarts the harness only after the person has not typed for this long… */
const SWITCH_QUIET_MS = 3000
/** …waiting at most this long; still typing then → it waits for the end of the turn instead. */
const SWITCH_WAIT_MS = 10_000

type ModelSwitchResult = { applied: ModelSwitchApplied; warnings?: string[] }

/** Between the old process's exit and the new start (a test can widen it: NSQ_RESTART_PAUSE_MS). */
const RESTART_PAUSE_MS = Number(process.env['NSQ_RESTART_PAUSE_MS']) || 800

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** No automatic restart onto an update this soon after someone typed into an agent. */
const UPDATE_QUIET_MS = 5 * 60 * 1000
/** How often a pending update looks for a moment to restart in. */
const UPDATE_POLL_MS = 15_000

/** An agent that comes back on its own session after a daemon restart (not a plain command). */
function resumable(record: AgentRecord): boolean {
  if (record.harness === 'command') return false
  return record.harness === 'claude-code'
    ? record.sessionStarted === true
    : record.harnessSessionId !== undefined
}

export class Daemon {
  private readonly store = new AgentStore()
  private readonly ptys = new PtyHost()
  // Terminal replies go straight to the pty: not the person typing, not a submit.
  private readonly screens = new Screens((id, data) => this.ptys.reply(id, data))
  private readonly runtime = new Map<string, Runtime>()
  private readonly clients = new Set<Client>()
  private readonly usage = new UsageTracker()
  private readonly notifier: Notifier
  private readonly config = readConfig()
  private server: Server | null = null
  private hooks: HookServer | null = null
  private readonly token = randomBytes(24).toString('hex')
  private stopping = false
  private locked = false
  private costTimer: ReturnType<typeof setTimeout> | null = null

  private readonly phone: PhoneAccess
  private readonly push = new NtfyPush((line) => this.log(line))
  private readonly updater = new Updater({
    version: VERSION,
    name: PACKAGE_NAME,
    packageDir: PACKAGE_DIR,
    home: paths.home(),
    config: () => readConfig(),
    log: (line) => this.log(line),
    onChange: (view) => {
      this.broadcast({ t: 'update', update: view })
      this.considerRestart()
    }
  })
  /** The last time someone typed into, sent to or answered an agent. */
  private lastInputAt = 0
  /** Restart onto the installed update as soon as nothing is busy (asked for: U, nsq update). */
  private applyWhenIdle: 'forced' | 'safe' | null = null
  private restarting = false
  /** considerRestart is running (setBlockers re-enters it through the updater's onChange). */
  private considering = false
  /** A restart onto this installed version failed: a blocker until U retries or a new version. */
  private restartFailure: { version: string; reason: string } | null = null
  private updatePoll: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.phone = new PhoneAccess(
      this.phoneHost(),
      (line) => this.log(line),
      () => this.phonesChanged()
    )
    this.notifier = createNotifier(this.config.notifications !== false)
  }

  async start(): Promise<DaemonState> {
    ensureDir(paths.home())
    // One daemon per nsq home, decided before anything else is touched (hook server, socket,
    // agents): two commands that autostart a daemon at the same moment must not both win.
    await acquireDaemonLock(lockPath(), ipcPath())
    this.locked = true
    this.hooks = await startHookServer({
      knows: (id) => this.store.get(id) !== undefined,
      arrive: (id) => statusLife(id),
      handle: (id, event, body, life) => receiveHook(id, event, body, life)
    })
    configureStatusHub({
      harnessOf: (id) => this.store.get(id)?.harness,
      dangerousModeOf: (id) => this.store.get(id)?.dangerousMode === true,
      codexAutoReview: () =>
        readCodexUserConfig(process.env['CODEX_HOME'] || undefined).approvalsReviewer ===
        'auto_review',
      onSessionId: (id, sessionId) => this.adoptSession(id, sessionId),
      onStatus: (event) => this.onStatus(event),
      onSubagents: (id) => this.pushAgent(id)
    })
    observePtys({
      onSpawn: (id, generation, info) => {
        this.screens.spawn(id, generation, info.cols, info.rows)
        const rt = this.rt(id)
        rt.generation = generation
        rt.cols = info.cols
        rt.rows = info.rows
        this.pushAgent(id)
      },
      onData: (id, generation, chunk) => {
        this.screens.write(id, generation, chunk)
        this.forward(id, { t: 'data', id, generation, data: chunk })
      },
      onResize: (id, cols, rows) => {
        this.screens.resize(id, cols, rows)
        const rt = this.rt(id)
        rt.cols = cols
        rt.rows = rows
        this.broadcast({ t: 'resized', id, cols, rows })
      },
      onExit: (id, generation) => {
        const rt = this.rt(id)
        rt.status = 'exited'
        rt.statusAt = Date.now()
        this.phone.emit({ type: 'status', agentId: id, status: 'exited', at: rt.statusAt })
        this.notifier.close(id)
        this.broadcast({ t: 'exit', id, generation })
        this.pushAgent(id)
        this.considerRestart()
      }
    })
    const ipc = ipcPath()
    // Another daemon already serves this home: never take its socket over.
    if (!ownsDaemonLock(lockPath()) || (await isListening(ipc))) {
      await this.hooks.close()
      throw new DaemonRunningError()
    }
    if (process.platform !== 'win32' && existsSync(ipc)) rmSync(ipc, { force: true })
    this.server = createServer((socket) => this.accept(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(ipc, () => resolve())
      })
    } catch (error) {
      await this.hooks.close()
      throw (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? new DaemonRunningError()
        : error
    }
    if (process.platform !== 'win32') chmodSync(ipc, 0o600)
    const state: DaemonState = {
      pid: process.pid,
      ipc,
      token: this.token,
      hookPort: this.hooks.port,
      version: VERSION,
      startedAt: Date.now()
    }
    writeFileAtomic(paths.daemonState(), JSON.stringify(state, null, 2))
    if (process.platform !== 'win32') chmodSync(paths.daemonState(), 0o600)
    // Agents that were running when the daemon stopped come back, resumed.
    for (const record of this.store.all()) {
      if (record.wantRunning) {
        void this.startAgent(record).then(
          (warnings) => warnings.forEach((warning) => this.log(`${record.name}: ${warning}`)),
          (error: unknown) => this.log(`resume of ${record.name} failed: ${String(error)}`)
        )
      }
    }
    this.scheduleCost(2000)
    this.updater.noteStarted()
    this.updater.start(() => this.considerRestart())
    this.updatePoll = setInterval(() => this.considerRestart(), UPDATE_POLL_MS)
    this.updatePoll.unref()
    if (this.config.phone?.enabled) {
      void this.phone
        .start(this.config.phone)
        .catch((error: unknown) => this.log(`phone access did not start: ${String(error)}`))
    }
    return state
  }

  private log(line: string): void {
    process.stdout.write(`${new Date().toISOString()} ${line}\n`)
  }

  private rt(id: string): Runtime {
    let rt = this.runtime.get(id)
    if (!rt) {
      rt = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS, queue: [] }
      this.runtime.set(id, rt)
    }
    return rt
  }

  // ---- views and broadcasts --------------------------------------------------------

  private view(record: AgentRecord): AgentView {
    const rt = this.rt(record.id)
    const running = this.ptys.isRunning(record.id)
    const snapshot = agentStatusSnapshot(record.id)
    return {
      id: record.id,
      name: record.name,
      harness: record.harness,
      workspace: record.workspace,
      cwd: record.cwd,
      ...(record.worktree
        ? { worktree: { path: record.worktree.path, branch: record.worktree.branch } }
        : {}),
      ...(record.command ? { command: record.command } : {}),
      ...(record.provider ? { provider: record.provider } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.dangerousMode ? { dangerousMode: true } : {}),
      createdAt: record.createdAt,
      running,
      ...(running
        ? snapshot
          ? {
              status: snapshot.kind,
              statusAt: snapshot.at,
              ...(snapshot.detail ? { detail: snapshot.detail } : {})
            }
          : rt.status && rt.status !== 'exited'
            ? { status: rt.status, statusAt: rt.statusAt }
            : {}
        : { status: 'exited' as const, statusAt: rt.statusAt }),
      ...(snapshot?.subagents ? { subagents: snapshot.subagents } : {}),
      ...(rt.costPico !== undefined ? { costPico: rt.costPico } : {}),
      ...(rt.unpriced ? { unpricedRequests: rt.unpriced } : {}),
      ...(rt.tokens !== undefined ? { tokens: rt.tokens } : {}),
      ...(running ? { cols: rt.cols, rows: rt.rows } : {}),
      ...(rt.queue.length ? { queued: rt.queue.length } : {})
    }
  }

  private views(): AgentView[] {
    return this.store.all().map((record) => this.view(record))
  }

  private send(client: Client, event: DaemonEvent): void {
    if (client.socket.destroyed) return
    client.socket.write(encode(event))
  }

  private broadcast(event: DaemonEvent): void {
    for (const client of this.clients) if (client.authed) this.send(client, event)
  }

  private pushAgent(id: string): void {
    const record = this.store.get(id)
    if (!record) return
    this.broadcast({ t: 'agent', agent: this.view(record) })
    // Cheap for the phone server: it re-reads the list and compares a signature.
    this.phone.emit({ type: 'agents-changed' })
  }

  private forward(id: string, event: DaemonEvent & { t: 'data' }): void {
    for (const client of this.clients) {
      if (!client.authed) continue
      const joining = client.joining.get(id)
      if (joining) {
        joining.push(event.data)
        continue
      }
      if (client.output === '*' || client.output.has(id)) this.send(client, event)
    }
  }

  private async joinScreen(client: Client, id: string): Promise<void> {
    if (client.joining.has(id)) return
    client.joining.set(id, [])
    const screen = await this.screens.join(id)
    const held = client.joining.get(id) ?? []
    client.joining.delete(id)
    if (!screen) return
    this.send(client, { t: 'screen', id, ...screen })
    for (const data of held)
      this.send(client, { t: 'data', id, generation: screen.generation, data })
  }

  // ---- status ------------------------------------------------------------------------

  private notificationsOff(): boolean {
    return this.config.notifications === false || process.env['NSQ_NO_NOTIFY'] === '1'
  }

  private onStatus(event: AgentHookEvent): void {
    const record = this.store.get(event.agentId)
    if (!record) return
    const rt = this.rt(event.agentId)
    rt.status = event.kind
    rt.statusAt = event.at
    rt.detail = event.detail
    this.pushAgent(event.agentId)
    this.phone.emit({ type: 'status', agentId: event.agentId, status: event.kind, at: event.at })
    if (event.kind !== 'needs-input') this.push.answered(event.agentId)
    const decision = decideNotification(event)
    if (decision?.action === 'close') this.notifier.close(event.agentId)
    if (decision?.action === 'show') {
      this.phone.emit({
        type: 'attention',
        agentId: event.agentId,
        kind: decision.kind,
        ...(decision.detail ? { detail: decision.detail } : {}),
        at: event.at
      })
      if (decision.kind === 'needs-input') {
        // Push (ntfy), when set up: the name and the question, nothing else.
        const phone = this.phone.status()
        const host = phone.running && phone.lan ? lanAddresses()[0] : undefined
        void this.push.needsYou({
          agentId: event.agentId,
          agentName: record.name,
          ...(decision.detail ? { question: decision.detail } : {}),
          ...(host ? { click: `http://${host}:${phone.port}/` } : {})
        })
      }
    }
    // The dashboard rings its terminal unless a desktop notification was actually shown;
    // notifications switched off (config or NSQ_NO_NOTIFY=1) means no bell either.
    if (decision?.action === 'show' && !this.notificationsOff()) {
      const text = notificationText(record.name, decision.kind, decision.detail)
      void this.notifier
        .show(event.agentId, text.title, text.body, decision.kind, this.config.sound !== false)
        .then((via) =>
          this.broadcast({
            t: 'notify',
            id: event.agentId,
            kind: decision.kind,
            ...text,
            ring: via !== 'os'
          })
        )
    }
    if (event.kind === 'finished') this.scheduleCost(1500)
    if (rt.switchPending && (event.kind === 'finished' || event.kind === 'idle')) {
      // The turn is over (or was interrupted): the model change waiting for it goes in now;
      // the restart then sends the queued prompts on the new model.
      void this.applyModelSwitch(event.agentId).catch((error: unknown) =>
        this.log(`${record.name}: model switch failed: ${String(error)}`)
      )
    } else if (event.kind === 'finished' && !event.error) this.drainQueue(event.agentId)
    this.considerRestart()
  }

  private adoptSession(id: string, sessionId: string): void {
    const record = this.store.get(id)
    if (!record) return
    const ids = record.sessionIds ?? []
    if (record.harnessSessionId === sessionId && ids.includes(sessionId)) return
    this.store.update(id, {
      harnessSessionId: sessionId,
      sessionIds: ids.includes(sessionId) ? ids : [...ids, sessionId].slice(-200)
    })
  }

  private drainQueue(id: string): void {
    const rt = this.rt(id)
    const next = rt.queue.shift()
    if (next === undefined) return
    this.ptys.submit(id, next)
    this.pushAgent(id)
  }

  private scheduleCost(delay: number): void {
    if (this.costTimer) clearTimeout(this.costTimer)
    this.costTimer = setTimeout(() => {
      this.costTimer = null
      void this.refreshCost()
    }, delay)
    this.costTimer.unref?.()
  }

  private async refreshCost(): Promise<void> {
    const agents = this.store.all()
    if (agents.length === 0) return
    await this.usage.scan(agents)
    for (const agent of agents) {
      const cost = this.usage.costOf(agent)
      const rt = this.rt(agent.id)
      const tokens =
        cost.totals.input + cost.totals.output + cost.totals.cacheRead + cost.totals.cacheWrite
      const changed = rt.tokens !== tokens || rt.costPico !== cost.pico.toString()
      rt.costPico = cost.totals.requests > 0 ? cost.pico.toString() : undefined
      rt.unpriced = cost.unpricedRequests
      rt.tokens = cost.totals.requests > 0 ? tokens : undefined
      if (changed) this.pushAgent(agent.id)
    }
  }

  // ---- agents --------------------------------------------------------------------------

  private async resolveExecutable(record: AgentRecord): Promise<string> {
    if (record.harness === 'command') {
      const argv0 = record.command?.[0]
      if (!argv0) throw new Error('no command to run')
      const found = findOnPath(argv0, process.env['PATH'] ?? process.env['Path'])
      if (!found) throw new Error(`command not found: ${argv0}`)
      return found
    }
    const found = resolveHarnessCommand(record.harness)
    if (!found) throw new Error(`${record.harness} is not installed (not found on PATH)`)
    return found
  }

  /** Starts in flight, per agent: a second request waits for the first instead of spawning twice. */
  private readonly starting = new Map<string, Promise<string[]>>()

  private startAgent(
    record: AgentRecord,
    options: { prompt?: string; fresh?: boolean } = {}
  ): Promise<string[]> {
    const inFlight = this.starting.get(record.id)
    if (inFlight) return inFlight
    const start = this.startAgentNow(record, options).finally(() => this.starting.delete(record.id))
    this.starting.set(record.id, start)
    return start
  }

  private async startAgentNow(
    record: AgentRecord,
    options: { prompt?: string; fresh?: boolean } = {}
  ): Promise<string[]> {
    if (this.ptys.isRunning(record.id)) return []
    const warnings: string[] = []
    const executable = await this.resolveExecutable(record)
    let openCodeV2 = false
    if (record.harness === 'opencode') {
      openCodeV2 = isOpenCodeV2(await openCodeVersionOf(openCodeExecutable(executable)))
      this.rt(record.id).openCodeV2 = openCodeV2
    }
    // A model only OpenRouter knows on an agent still on its own login (nsq 0.1.1's model
    // picker left agents like that): the harness would answer "model not found".
    let launchModel = record.model
    // Only with no provider at all: another provider (a custom one) has its own id format.
    if (record.provider === undefined && modelNeedsOpenRouter(record.harness, record.model)) {
      const model = record.model!
      if (await openRouterKey()) {
        record = this.store.update(record.id, { provider: 'openrouter' }) ?? record
        warnings.push(
          `${model} is an OpenRouter model id: ${record.name} now runs on OpenRouter (back to its own login: nsq set ${record.name} --provider none --model none)`
        )
      } else {
        launchModel = undefined
        warnings.push(
          `${model} is an OpenRouter model id, but there is no OpenRouter key: ${record.name} runs on its own login and default model (nsq openrouter set-key, then nsq set ${record.name} --provider openrouter; or nsq set ${record.name} --model none)`
        )
      }
    }
    const key = record.provider === 'openrouter' ? await openRouterKey() : undefined
    if (record.provider === 'openrouter' && !key) {
      warnings.push(
        'no OpenRouter key (nsq openrouter set-key, or OPENROUTER_API_KEY): running on the harness’s own login'
      )
    }
    const resumed =
      !options.fresh &&
      record.sessionStarted === true &&
      record.harness !== 'command' &&
      (record.harness === 'claude-code' || record.harnessSessionId !== undefined)
    if (resumed && record.provider === undefined && !launchModel) {
      // Back from OpenRouter on the same session: the CLI would resume on the session's slug.
      const own = ownModelOnResume(record.harness, record.harnessSessionId ?? record.id)
      if (own.model) launchModel = own.model
      if (own.warning) warnings.push(`${own.warning} (nsq set ${record.name} --model <id>)`)
    }
    const rt = this.rt(record.id)
    const hookBase = this.hooks!.baseFor(record.id)
    const context = (resume: boolean): LaunchContext => ({
      agent: {
        id: record.id,
        harness: record.harness,
        ...(resume && record.harnessSessionId ? { harnessSessionId: record.harnessSessionId } : {}),
        ...(record.dangerousMode ? { dangerousMode: true } : {}),
        ...(record.provider ? { provider: record.provider } : {}),
        ...(launchModel ? { model: launchModel } : {}),
        ...(record.command ? { command: record.command } : {})
      },
      executable,
      cwd: record.cwd,
      hookBase,
      layerDir: paths.layers(record.harness),
      resumed: resume,
      ...(key ? { openRouterKey: key } : {}),
      ...(process.env['NSQ_OPENROUTER_BASE_URL']
        ? { openRouterApiBase: process.env['NSQ_OPENROUTER_BASE_URL'] }
        : {}),
      env: process.env
    })
    const request = (resume: boolean, prompt?: string): SpawnRequest => {
      const plan = prepareLaunch(context(resume), { openCodeV2 })
      if (plan.sessionId) this.adoptSession(record.id, plan.sessionId)
      const args = prompt
        ? [...plan.args, ...promptArgs(record.harness, openCodeV2, prompt)]
        : plan.args
      return {
        agentId: record.id,
        harness: record.harness,
        command: plan.command,
        args,
        cwd: record.cwd,
        env: plan.env,
        cols: rt.cols,
        rows: rt.rows,
        useConptyDll: plan.useConptyDll,
        ...(plan.trustPrompt ? { trustPrompt: plan.trustPrompt } : {}),
        ...(resume && plan.sessionNotFound ? { sessionNotFound: plan.sessionNotFound } : {})
      }
    }
    const prompt = resumed ? undefined : options.prompt
    if (prompt && promptArgs(record.harness, openCodeV2, prompt).length === 0) {
      rt.pendingPrompt = prompt
    }
    try {
      await this.ptys.spawn(request(resumed, prompt), {
        onSessionNotFound: () => {
          this.log(`${record.name}: the session to resume does not exist; starting a fresh one`)
          const fresh = this.store.update(record.id, {
            sessionStarted: false,
            harnessSessionId: undefined
          })
          if (fresh) record = fresh
          return request(false)
        }
      })
    } catch (error) {
      // Never typed into a later start that did not ask for it.
      rt.pendingPrompt = undefined
      throw error
    }
    this.store.update(record.id, { sessionStarted: true, wantRunning: true })
    // A resumed agent sits at its prompt until a hook says otherwise.
    if (resumed && !agentStatusSnapshot(record.id)) {
      rt.status = 'idle'
      rt.statusAt = Date.now()
    }
    if (rt.pendingPrompt) this.deliverWhenReady(record.id)
    this.pushAgent(record.id)
    return warnings
  }

  /** Submits the pending first prompt once the harness's output has been quiet for a moment. */
  private deliverWhenReady(id: string): void {
    const started = Date.now()
    let lastOutput = Date.now()
    let sawOutput = false
    let readyAt: number | undefined
    const marker = READY_MARKERS[this.store.get(id)?.harness ?? 'command']
    const stop = observePtys({
      onSpawn: () => {},
      onData: (agentId) => {
        if (agentId !== id) return
        sawOutput = true
        lastOutput = Date.now()
      },
      onExit: (agentId) => {
        if (agentId === id) finish()
      }
    })
    const timer = setInterval(() => {
      const now = Date.now()
      // A harness with a known prompt: its input box is on screen, plus a beat
      // for it to take keys. Others: the output went quiet.
      if (marker && readyAt === undefined && marker.test(this.screens.tail(id, 60).join('\n'))) {
        readyAt = now
      }
      const ready = marker
        ? readyAt !== undefined && now - readyAt >= READY_SETTLE_MS
        : sawOutput && now - lastOutput >= READY_QUIET_MS
      if (!ready && now - started <= READY_MAX_MS) return
      const rt = this.rt(id)
      const prompt = rt.pendingPrompt
      rt.pendingPrompt = undefined
      if (prompt) {
        this.log(
          `${this.store.get(id)?.name ?? id}: first prompt submitted${ready ? '' : ' (no ready signal in time)'}`
        )
        this.ptys.submit(id, prompt)
      }
      finish()
    }, 200)
    const finish = (): void => {
      clearInterval(timer)
      stop()
    }
  }

  /** Stop, a beat, start again — on the same session where the harness has one. */
  private async restartAgent(id: string): Promise<string[]> {
    this.store.update(id, { wantRunning: true })
    await this.stopAgent(id, true)
    await sleep(RESTART_PAUSE_MS)
    // Stopped (or removed) during the pause: that stop wins, nothing starts.
    const record = this.store.get(id)
    if (!record?.wantRunning) return []
    return this.startAgent(record)
  }

  /** Model switches in flight, per agent: a second request joins the first instead of racing it. */
  private readonly switching = new Map<string, Promise<ModelSwitchResult>>()

  /**
   * Puts an agent's stored model/provider into effect: a restart on the same session, now if
   * the agent is not mid-turn and the person is not typing into it, else once the turn ends.
   * One at a time per agent; the restart reads the record when it happens, so a change made
   * meanwhile is not lost (and a change during the restart restarts once more).
   */
  private applyModelSwitch(id: string): Promise<ModelSwitchResult> {
    const inFlight = this.switching.get(id)
    if (inFlight) return inFlight
    const run = this.applyModelSwitchNow(id).finally(() => this.switching.delete(id))
    this.switching.set(id, run)
    return run
  }

  private async applyModelSwitchNow(id: string): Promise<ModelSwitchResult> {
    const rt = this.rt(id)
    if (!this.ptys.isRunning(id)) {
      rt.switchPending = false
      return { applied: 'next-start' }
    }
    const deadline = Date.now() + SWITCH_WAIT_MS
    for (;;) {
      if (rt.status === 'working' || rt.status === 'needs-input') {
        rt.switchPending = true
        return { applied: 'after-turn' }
      }
      if (Date.now() >= deadline) {
        // Still typing, nothing submitted: no status event may come to pick the switch up.
        rt.switchPending = true
        setTimeout(() => {
          if (rt.switchPending)
            void this.applyModelSwitch(id).catch((error: unknown) =>
              this.log(`model switch failed: ${String(error)}`)
            )
        }, SWITCH_QUIET_MS).unref?.()
        return { applied: 'after-turn' }
      }
      const quietFor = Date.now() - (rt.lastInputAt ?? 0)
      if (quietFor >= SWITCH_QUIET_MS) break
      await sleep(Math.min(500, SWITCH_QUIET_MS - quietFor))
    }
    rt.switchPending = false
    const warnings: string[] = []
    for (;;) {
      const record = this.store.get(id)
      if (!record) return { applied: 'now' }
      // Stopped (or exited) while waiting: the new model applies on the next start.
      if (!record.wantRunning || !this.ptys.isRunning(id)) return { applied: 'next-start' }
      const launched = `${record.provider ?? ''} ${record.model ?? ''}`
      this.log(
        `${record.name}: model ${record.model ?? 'default'}${record.provider === 'openrouter' ? ' on OpenRouter' : ''}: restarting on the same session`
      )
      warnings.splice(0, warnings.length, ...(await this.restartAgent(id)))
      if (!this.ptys.isRunning(id)) return { applied: 'next-start' }
      const now = this.store.get(id)
      if (!now || `${now.provider ?? ''} ${now.model ?? ''}` === launched) break
    }
    // Prompts queued for the end of the turn go to the restarted harness once it is ready.
    const next = rt.queue.shift()
    if (next !== undefined) {
      rt.pendingPrompt = next
      this.deliverWhenReady(id)
      this.pushAgent(id)
    }
    return { applied: 'now', ...(warnings.length ? { warnings } : {}) }
  }

  private async createAgent(spec: RunSpec): Promise<{ agent: AgentView; warnings: string[] }> {
    checkModelChoice(spec.harness, spec.provider, spec.model)
    const id = randomUUID()
    const workspace = spec.cwd
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw new Error(`not a folder: ${workspace}`)
    }
    const base =
      spec.name ??
      (spec.harness === 'command'
        ? basename(spec.command?.[0] ?? 'cmd').replace(/\.(exe|cmd|bat)$/i, '')
        : spec.harness.replace(/-cli$|-code$/, ''))
    const name = this.store.uniqueName(base)
    let cwd = workspace
    let worktree: AgentRecord['worktree']
    if (spec.worktree) {
      const repo = (
        await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
          cwd: workspace,
          windowsHide: true
        })
      ).stdout.trim()
      if (!repo) throw new Error('--worktree needs a git repository')
      const dir = join(paths.worktrees(), `${basename(repo)}-${id.slice(0, 8)}`)
      const branch = `nsq/${name}`
      const made = await addWorktree(repo, dir, branch)
      if (!made) throw new Error(`could not create a worktree on branch ${branch}`)
      cwd = dir
      worktree = { path: dir, branch, repo }
    }
    const record: AgentRecord = {
      id,
      name,
      harness: spec.harness,
      workspace,
      cwd,
      ...(worktree ? { worktree } : {}),
      ...(spec.command ? { command: spec.command } : {}),
      ...(spec.provider ? { provider: spec.provider } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.dangerousMode ? { dangerousMode: true } : {}),
      createdAt: Date.now(),
      wantRunning: true
    }
    this.store.put(record)
    const rt = this.rt(id)
    if (spec.cols && spec.rows) {
      rt.cols = spec.cols
      rt.rows = spec.rows
    }
    let warnings: string[] = []
    try {
      warnings = await this.startAgent(record, spec.prompt ? { prompt: spec.prompt } : {})
    } catch (error) {
      this.store.update(id, { wantRunning: false })
      this.pushAgent(id)
      throw error
    }
    return { agent: this.view(this.store.get(id)!), warnings }
  }

  private async stopAgent(id: string, keepWanted = false): Promise<void> {
    if (!keepWanted) this.store.update(id, { wantRunning: false })
    await this.ptys.kill(id)
  }

  private async removeAgent(id: string, removeTree: boolean): Promise<void> {
    const record = this.store.get(id)
    if (!record) return
    await this.stopAgent(id)
    this.notifier.close(id)
    forgetAgentStatus(id)
    this.screens.dispose(id)
    this.runtime.delete(id)
    this.store.remove(id)
    for (const file of [`${id}.json`, `${id}.curlrc`]) {
      rmSync(join(paths.layers(record.harness), file), { force: true })
    }
    if (removeTree && record.worktree) {
      await removeWorktree(record.worktree.repo, record.worktree.path, {
        ownedRoot: paths.worktrees()
      })
    }
    this.broadcast({ t: 'removed', id })
    this.phone.emit({ type: 'agents-changed' })
  }

  private sendPrompt(
    record: AgentRecord,
    text: string,
    whenDone: boolean
  ): { queued: number } | { sent: true } {
    if (!this.ptys.isRunning(record.id)) throw new Error(`${record.name} is not running`)
    const rt = this.rt(record.id)
    const busy = rt.status === 'working' || rt.status === 'needs-input'
    if (whenDone && busy) {
      rt.queue.push(text)
      this.pushAgent(record.id)
      return { queued: rt.queue.length }
    }
    if (rt.status === 'needs-input') {
      throw new Error(`${record.name} is waiting for an answer; answer it first or use --when-done`)
    }
    this.ptys.submit(record.id, text)
    return { sent: true }
  }

  private async answerPrompt(record: AgentRecord, key: AnswerKey): Promise<void> {
    const keys = answerKeys(record.harness, key)
    if (!keys) throw new Error(`${record.harness} has no permission prompt to answer`)
    // Only into a prompt that is open: elsewhere the keys would land in its input box.
    if (agentStatusSnapshot(record.id)?.kind !== 'needs-input') {
      throw new Error(`${record.name} is not waiting for an answer`)
    }
    for (const [index, press] of keys.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS))
      this.ptys.write(record.id, press)
      noteUserInput(record.id, press)
    }
  }

  // ---- phone ---------------------------------------------------------------------------

  /** The daemon as the phone server's host: the same paths its own clients take. */
  private phoneHost(): Omit<PhoneHost, 'subscribe'> {
    const running = (id: string): AgentRecord => {
      const record = this.store.get(id)
      if (!record) throw new PhoneHostError('not-found', 'No such agent')
      if (!this.ptys.isRunning(id))
        throw new PhoneHostError('not-running', 'The agent is not running')
      return record
    }
    const refusal = (error: unknown): never => {
      if (error instanceof PhoneHostError) throw error
      throw new PhoneHostError('refused', error instanceof Error ? error.message : 'Refused')
    }
    return {
      listAgents: () =>
        this.views().map((view) => ({
          id: view.id,
          name: view.name,
          harness: view.harness,
          workspace: view.workspace,
          running: view.running,
          ...(view.status ? { status: view.status } : {}),
          ...(view.detail ? { detail: view.detail } : {}),
          ...(view.queued ? { queued: view.queued } : {})
        })),
      screen: (id, lines) => {
        if (!this.store.get(id) || !this.screens.has(id)) return null
        return this.screens.tail(id, lines).join('\n')
      },
      // A busy agent gets it when its turn ends, as `nsq send --when-done`.
      submit: (id, text) => {
        try {
          this.sendPrompt(running(id), text, true)
        } catch (error) {
          refusal(error)
        }
      },
      answer: async (id, answer: PhoneAnswer) => {
        try {
          await this.answerPrompt(running(id), answer)
        } catch (error) {
          refusal(error)
        }
      },
      interrupt: (id) => {
        const record = running(id)
        this.ptys.interrupt(record.id, interruptKeys(record.harness))
      }
    }
  }

  private lastPhones = ''

  private phoneView(): PhoneView {
    const status = this.phone.status()
    return {
      running: status.running,
      lan: status.lan,
      ...(status.port !== undefined ? { port: status.port } : {}),
      phones: status.phones
    }
  }

  /** Every client learns who is connected; only real changes go out. */
  private phonesChanged(): void {
    const view = this.phoneView()
    const signature = JSON.stringify({
      ...view,
      phones: view.phones.map((p) => [p.address, p.device, p.firstSeen, p.open > 0])
    })
    if (signature === this.lastPhones) return
    this.lastPhones = signature
    if (view.phones.length || view.running) {
      this.log(
        `phone: ${view.running ? 'on' : 'off'}, ${view.phones.length} connected${view.phones.length ? ` (${view.phones.map((p) => `${p.device} ${p.address}`).join(', ')})` : ''}`
      )
    }
    this.broadcast({ t: 'phones', phone: view })
  }

  private async phoneRequest(message: Request & { t: 'phone' }): Promise<unknown> {
    const saved = (change: {
      enabled: boolean
      lan?: boolean
      port?: number
    }): NonNullable<ReturnType<typeof readConfig>['phone']> => {
      const config = readConfig()
      const phone = { ...config.phone, ...change }
      writeConfig({ ...config, phone })
      this.config.phone = phone
      return phone
    }
    switch (message.action) {
      case 'on': {
        // Saved only once the server listens: a port in use leaves the old settings (and a
        // server that was running keeps running).
        const previous = this.config.phone
        const wasRunning = this.phone.status().running
        const change = {
          enabled: true,
          ...(message.lan !== undefined ? { lan: message.lan } : {}),
          ...(message.port !== undefined ? { port: message.port } : {})
        }
        let status: Awaited<ReturnType<PhoneAccess['start']>>
        try {
          status = await this.phone.start({ ...readConfig().phone, ...change })
        } catch (error) {
          if (wasRunning && previous) {
            await this.phone.start(previous).catch((again: unknown) => {
              this.log(
                `phone: could not restart with the previous settings, phone access is off: ${again instanceof Error ? again.message : String(again)}`
              )
            })
          }
          throw error
        }
        saved(change)
        return { status, links: this.phone.pairingLinks() }
      }
      case 'off':
        saved({ enabled: false })
        await this.phone.stop()
        return { status: this.phone.status() }
      case 'rotate':
        this.phone.rotate()
        return { status: this.phone.status() }
      case 'pair':
        return { status: this.phone.status(), links: this.phone.pairingLinks() }
      default:
        return { status: this.phone.status() }
    }
  }

  private need(ref: string): AgentRecord {
    const record = this.store.find(ref)
    if (!record) throw new Error(`no agent "${ref}"`)
    return record
  }

  // ---- the socket ---------------------------------------------------------------------

  private accept(socket: Socket): void {
    const client: Client = {
      socket,
      authed: false,
      name: '?',
      output: new Set(),
      joining: new Map()
    }
    this.clients.add(client)
    socket.setEncoding('utf8')
    const decoder = new LineDecoder<RequestWithId>((message) => {
      void this.handle(client, message)
    })
    socket.on('data', (chunk: string) => decoder.push(chunk))
    socket.on('error', () => {})
    socket.on('close', () => {
      this.clients.delete(client)
      this.considerRestart()
    })
  }

  private reply(
    client: Client,
    rid: number,
    result: { ok: true; data?: unknown } | { ok: false; error: string }
  ): void {
    this.send(client, { t: 'reply', rid, ...result } as DaemonEvent)
  }

  private async handle(client: Client, message: RequestWithId): Promise<void> {
    const rid = typeof message?.rid === 'number' ? message.rid : -1
    if (!client.authed) {
      if (message.t !== 'hello' || message.token !== this.token) {
        this.reply(client, rid, { ok: false, error: 'unauthorized' })
        client.socket.destroy()
        return
      }
      client.authed = true
      client.name = String(message.client ?? '?')
      this.reply(client, rid, {
        ok: true,
        data: { version: VERSION, protocol: PROTOCOL_VERSION, pid: process.pid }
      })
      return
    }
    try {
      const data = await this.dispatch(client, message)
      this.reply(client, rid, { ok: true, ...(data === undefined ? {} : { data }) })
    } catch (error) {
      this.reply(client, rid, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async dispatch(client: Client, message: RequestWithId): Promise<unknown> {
    switch (message.t) {
      case 'hello':
        return undefined
      case 'list':
        return this.views()
      case 'status':
        return {
          pid: process.pid,
          version: VERSION,
          agents: this.store.all().length,
          running: this.store.all().filter((record) => this.ptys.isRunning(record.id)).length,
          clients: this.clients.size,
          hookPort: this.hooks?.port,
          update: this.updater.view()
        }
      case 'subscribe': {
        if (message.output === '*') client.output = '*'
        else if (Array.isArray(message.output)) client.output = new Set(message.output)
        const ids =
          message.agents === '*' ? this.store.all().map((record) => record.id) : message.agents
        this.send(client, { t: 'agents', agents: this.views() })
        this.send(client, { t: 'phones', phone: this.phoneView() })
        this.send(client, { t: 'update', update: this.updater.view() })
        for (const id of ids) void this.joinScreen(client, id)
        return undefined
      }
      case 'snapshot': {
        const record = this.need(message.id)
        await this.joinScreen(client, record.id)
        return undefined
      }
      case 'run':
        return this.createAgent(message.spec)
      case 'input': {
        const record = this.need(message.id)
        this.rt(record.id).lastInputAt = Date.now()
        this.lastInputAt = Date.now()
        this.ptys.write(record.id, message.data)
        noteUserInput(record.id, message.data)
        return undefined
      }
      case 'paste': {
        const record = this.need(message.id)
        this.rt(record.id).lastInputAt = Date.now()
        this.lastInputAt = Date.now()
        if (!this.ptys.paste(record.id, message.text))
          throw new Error(`${record.name} is not running`)
        return undefined
      }
      case 'send':
        this.lastInputAt = Date.now()
        return this.sendPrompt(this.need(message.id), message.text, message.whenDone === true)
      case 'answer':
        this.lastInputAt = Date.now()
        await this.answerPrompt(this.need(message.id), message.key)
        return undefined
      case 'interrupt': {
        const record = this.need(message.id)
        this.ptys.interrupt(record.id, interruptKeys(record.harness))
        return undefined
      }
      case 'phone':
        return this.phoneRequest(message)
      case 'resize': {
        const record = this.need(message.id)
        const cols = Math.max(20, Math.min(1000, Math.floor(message.cols)))
        const rows = Math.max(5, Math.min(500, Math.floor(message.rows)))
        const rt = this.rt(record.id)
        if (!this.ptys.isRunning(record.id)) {
          rt.cols = cols
          rt.rows = rows
        }
        this.ptys.resize(record.id, cols, rows)
        return undefined
      }
      case 'stop': {
        const record = this.need(message.id)
        await this.stopAgent(record.id)
        return undefined
      }
      case 'start': {
        const record = this.need(message.id)
        return { warnings: await this.startAgent(record) }
      }
      case 'restart': {
        const record = this.need(message.id)
        return { warnings: await this.restartAgent(record.id) }
      }
      case 'remove': {
        const record = this.need(message.id)
        await this.removeAgent(record.id, message.removeWorktree === true)
        return undefined
      }
      case 'rename': {
        const record = this.need(message.id)
        const name = this.store.uniqueName(message.name, record.id)
        this.store.update(record.id, { name })
        this.pushAgent(record.id)
        return { name }
      }
      case 'set': {
        const record = this.need(message.id)
        const patch: Partial<AgentRecord> = {}
        if (message.dangerousMode !== undefined)
          patch.dangerousMode = message.dangerousMode || undefined
        if (message.model !== undefined) patch.model = message.model ?? undefined
        if (message.provider !== undefined) patch.provider = message.provider ?? undefined
        const provider = 'provider' in patch ? patch.provider : record.provider
        const model = 'model' in patch ? patch.model : record.model
        checkModelChoice(record.harness, provider, model, message.provider === null)
        this.store.update(record.id, patch)
        this.pushAgent(record.id)
        if (
          record.harness !== 'command' &&
          (provider !== record.provider || model !== record.model)
        ) {
          // The model and the provider are fixed when the harness starts (flags, env), and no
          // harness has a safe in-session switch (docs/guide/agents.md, "Models"): restart it on the same
          // session as soon as it is not mid-turn — the conversation is kept.
          return { restartNeeded: false, ...(await this.applyModelSwitch(record.id)) }
        }
        // Claude Code's dangerous mode is live; a model or provider applies on the next start.
        // (`patch.dangerousMode` is undefined for "off": test the request, not the patch.)
        const live =
          message.dangerousMode !== undefined &&
          message.model === undefined &&
          message.provider === undefined &&
          (record.harness === 'claude-code' ||
            // OpenCode 2's plugin asks nsq on every permission (live); 1.x reads it at start.
            (record.harness === 'opencode' && this.rt(record.id).openCodeV2 === true))
        return { restartNeeded: !live && this.ptys.isRunning(record.id) }
      }
      case 'cost': {
        await this.refreshCost()
        const agents = this.store.all()
        return agents.map((agent) => {
          const cost = this.usage.costOf(agent, message.since)
          return {
            id: agent.id,
            name: agent.name,
            harness: agent.harness,
            requests: cost.totals.requests,
            totals: cost.totals,
            pico: cost.pico.toString(),
            usd: formatUsd(cost.pico),
            unpricedRequests: cost.unpricedRequests,
            models: cost.models
          }
        })
      }
      case 'models':
        return fetchOpenRouterModels(message.query)
      case 'openrouter-key':
        await setSecret(OPENROUTER_SECRET, message.key ?? undefined)
        return { stored: message.key !== null }
      case 'shutdown':
        setTimeout(() => void this.shutdown(message.stopAgents !== false), 50)
        return undefined
      case 'update':
        return this.updateRequest(message.action)
      default:
        throw new Error('unknown request')
    }
  }

  // ---- updates -------------------------------------------------------------------------

  private async updateRequest(
    action: 'status' | 'check' | 'install' | 'apply'
  ): Promise<{ update: UpdateView; waitingFor?: string[]; restarting?: boolean }> {
    switch (action) {
      case 'status':
        return { update: this.updater.view() }
      case 'check':
        return { update: await this.updater.check(true) }
      case 'install': {
        let view = await this.updater.check(true)
        if (view.state === 'available') view = await this.updater.install()
        // Asked for by hand: restart onto it at the first safe moment, even with checks off.
        if (view.installed) this.applyWhenIdle ??= 'safe'
        return { update: this.updater.view() }
      }
      case 'apply': {
        if (!this.updater.view().installed) return { update: this.updater.view() }
        this.applyWhenIdle = 'forced'
        this.restartFailure = null
        const waitingFor = this.restartBlockers('forced')
        if (waitingFor.length) {
          this.updater.setBlockers(waitingFor, true)
          return { update: this.updater.view(), waitingFor }
        }
        setTimeout(() => this.considerRestart(), 50)
        return { update: this.updater.view(), restarting: true }
      }
    }
  }

  /**
   * Why the daemon cannot restart onto an installed update right now. Never while an agent works,
   * needs you, starts, or has prompts waiting. Unless asked for (`forced`: U in the dashboard),
   * also not while a dashboard, attach or phone is open, someone typed lately, or a running agent
   * would not come back on its session (a plain command starts over).
   */
  private restartBlockers(how: 'auto' | 'safe' | 'forced'): string[] {
    const blockers: string[] = []
    for (const record of this.store.all()) {
      const starting = this.starting.has(record.id)
      if (!starting && !this.ptys.isRunning(record.id)) continue
      const status = this.view(record).status
      const rt = this.rt(record.id)
      if (starting) blockers.push(`${record.name} is starting`)
      else if (status === 'working') blockers.push(`${record.name} is working`)
      else if (status === 'needs-input') blockers.push(`${record.name} needs you`)
      else if (rt.switchPending) blockers.push(`${record.name} has a model change waiting`)
      else if (rt.queue.length || rt.pendingPrompt) {
        blockers.push(`${record.name} has prompts waiting`)
      } else if (how !== 'forced' && !resumable(record)) {
        blockers.push(`${record.name} would start over (a command has no session to resume)`)
      }
    }
    if (how === 'forced') return blockers
    const windows = [...this.clients].filter((client) => client.authed).length
    if (windows) blockers.push(`${windows} nsq window${windows === 1 ? ' is' : 's are'} open`)
    if (this.phone.status().connections) blockers.push('a phone is connected')
    if (this.lastInputAt && Date.now() - this.lastInputAt < UPDATE_QUIET_MS) {
      blockers.push('an agent got input in the last 5 minutes')
    }
    return blockers
  }

  /** Restarts onto an installed update when nothing stands in the way (see restartBlockers). */
  private considerRestart(): void {
    if (this.restarting || this.stopping || this.considering) return
    this.considering = true
    try {
      const view = this.updater.view()
      if (!view.installed || view.state === 'installing') return
      const how = this.applyWhenIdle ?? (view.auto === 'off' ? null : 'auto')
      if (!how) {
        this.updater.setBlockers(['automatic updates are off'])
        return
      }
      const blockers = this.restartBlockers(how)
      if (this.restartFailure?.version === view.installed) blockers.push(this.restartFailure.reason)
      this.updater.setBlockers(blockers, how === 'forced')
      if (blockers.length) return
      void this.restartForUpdate(view.installed)
    } finally {
      this.considering = false
    }
  }

  /**
   * Hands over to a daemon running the new version: it is started first (and waits for this one
   * to exit), then this one shuts down the usual way. The agents keep `wantRunning`, so the new
   * daemon resumes them on their sessions, exactly like `nsq down` + `nsq up`.
   */
  private async restartForUpdate(version: string): Promise<void> {
    if (this.restarting || this.stopping) return
    const successor = this.updater.successor()
    if (!successor) {
      this.restartFailure = {
        version,
        reason: `the new version was not found in ${this.updater.info.stableDir}`
      }
      this.updater.setBlockers([this.restartFailure.reason])
      return
    }
    // Never trade a working daemon for one that does not start: the new version must at least
    // run and say it is the version that was installed. Otherwise this daemon and every agent
    // keep running on the old one.
    const probe = spawnSync(successor.node, [successor.script, '--version'], {
      cwd: paths.home(),
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, NSQ_DAEMON: undefined, NSQ_SUCCESSOR_OF: undefined }
    })
    const said = (probe.stdout ?? '').trim().split(/\r?\n/)[0]
    if (probe.status !== 0 || said !== version) {
      const why =
        probe.error?.message ??
        (probe.status !== 0
          ? (probe.stderr ?? '').trim().split(/\r?\n/).at(-1) || `exit code ${probe.status}`
          : `it reports ${said || 'no version'}`)
      this.restartFailure = {
        version,
        reason: `installed ${version} but it does not start (${why.slice(0, 160)}); run nsq update or reinstall`
      }
      this.log(this.restartFailure.reason)
      this.updater.setBlockers([this.restartFailure.reason])
      return
    }
    this.restarting = true
    try {
      ensureDir(paths.home())
      const log = openSync(paths.daemonLog(), 'a')
      try {
        const child = spawn(successor.node, [successor.script, 'daemon', '--foreground'], {
          detached: true,
          windowsHide: true,
          stdio: ['ignore', log, log],
          cwd: paths.home(),
          env: { ...process.env, NSQ_DAEMON: '1', NSQ_SUCCESSOR_OF: String(process.pid) }
        })
        child.unref()
      } finally {
        closeSync(log)
      }
    } catch (error) {
      this.restarting = false
      this.log(`could not start the new daemon: ${String(error)}`)
      this.restartFailure = { version, reason: `could not start ${version}: ${String(error)}` }
      this.updater.setBlockers([this.restartFailure.reason])
      return
    }
    this.log(`restarting on ${version}; the agents resume on their sessions`)
    this.updater.markRestarting()
    // Let the "restarting" event reach the clients before the socket closes.
    await new Promise((resolve) => setTimeout(resolve, 300))
    await this.shutdown(true)
  }

  async shutdown(stopAgents = true): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.updater.stop()
    if (this.updatePoll) clearInterval(this.updatePoll)
    if (stopAgents) {
      // Keep `wantRunning`: `nsq up` (or the next daemon) brings them back.
      await this.ptys.killAll()
    }
    await this.notifier.dispose()
    await this.phone.stop().catch(() => {})
    for (const client of this.clients) client.socket.destroy()
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    )
    await this.hooks?.close()
    rmSync(paths.daemonState(), { force: true })
    if (this.locked && ownsDaemonLock(lockPath())) rmSync(lockPath(), { force: true })
    process.exit(0)
  }

  /** For `emitHookFact` callers inside the daemon (tests). */
  fact(id: string, kind: 'working' | 'needs-input' | 'finished', detail?: string): void {
    emitHookFact(id, kind, detail)
  }
}

/** Another daemon already serves this nsq home. */
export class DaemonRunningError extends Error {
  constructor() {
    super('the nsq daemon is already running')
  }
}

function lockPath(): string {
  return join(paths.home(), 'daemon.lock')
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLockPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8'), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Creates the lock holding our pid, atomically: the pid is written to a file of our own first and
 * then hard-linked to the lock name, so the lock never exists empty. Where hard links are not
 * available, an exclusive create.
 */
function createLock(file: string): boolean {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, String(process.pid), { mode: 0o600 })
  try {
    linkSync(temp, file)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw error
    try {
      const fd = openSync(file, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw fallback
    }
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Removes the lock only if it still holds `pid` (another starter may have replaced it). */
function removeStaleLock(file: string, pid: number | null): void {
  const aside = `${file}.${process.pid}.stale`
  try {
    renameSync(file, aside)
  } catch {
    return
  }
  if (readLockPid(aside) !== pid) {
    // A fresh lock of someone else: put it back (unless yet another one appeared meanwhile).
    try {
      linkSync(aside, file)
    } catch {
      // There is a lock again either way.
    }
  }
  rmSync(aside, { force: true })
}

/**
 * Takes `daemon.lock`. A lock whose daemon answers on the socket, or whose live pid starts
 * answering within a few seconds, means another daemon owns this home. A lock of a dead process,
 * or of a reused pid that never answers, is stale and taken over — removed only while it still
 * holds that pid. A lock without a readable pid is given a moment (it may be being replaced).
 */
async function acquireDaemonLock(file: string, ipc: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (createLock(file)) return
    let pid = readLockPid(file)
    if (pid === null) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      pid = readLockPid(file)
      if (pid === null && existsSync(file)) {
        let age = 0
        try {
          age = Date.now() - statSync(file).mtimeMs
        } catch {
          continue
        }
        if (age < 5000) continue
      }
    }
    if (await isListening(ipc)) throw new DaemonRunningError()
    if (pid !== null && pidAlive(pid)) {
      // Probably starting up: give it a moment to listen.
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (await isListening(ipc)) throw new DaemonRunningError()
        if (!pidAlive(pid)) break
      }
    }
    removeStaleLock(file, pid)
  }
  throw new DaemonRunningError()
}

/** Ours still? Checked right before the socket is taken: a lost race ends here. */
function ownsDaemonLock(file: string): boolean {
  return readLockPid(file) === process.pid
}

function isListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/** A daemon started by an update waits for the one it replaces to exit (that one holds the lock). */
async function waitForPredecessor(): Promise<void> {
  const pid = Number(process.env['NSQ_SUCCESSOR_OF'])
  delete process.env['NSQ_SUCCESSOR_OF']
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function runDaemon(): Promise<void> {
  await waitForPredecessor()
  const daemon = new Daemon()
  let state: DaemonState
  try {
    state = await daemon.start()
  } catch (error) {
    if (error instanceof DaemonRunningError) {
      process.stdout.write(`${new Date().toISOString()} ${error.message}; this one exits\n`)
      process.exit(0)
    }
    throw error
  }
  process.stdout.write(
    `${new Date().toISOString()} nsq daemon ${state.version} pid ${state.pid}, hooks on 127.0.0.1:${state.hookPort}\n`
  )
  const stop = (): void => void daemon.shutdown(true)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', () => {})
  process.on('uncaughtException', (error) => {
    process.stdout.write(`${new Date().toISOString()} uncaught: ${error.stack ?? String(error)}\n`)
  })
  process.on('unhandledRejection', (error) => {
    process.stdout.write(`${new Date().toISOString()} unhandled rejection: ${String(error)}\n`)
  })
}
