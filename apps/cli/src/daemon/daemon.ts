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
import { execFile } from 'node:child_process'
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
import { readConfig } from '../config.js'
import {
  LineDecoder,
  PROTOCOL_VERSION,
  encode,
  type AgentView,
  type DaemonEvent,
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
import { VERSION } from '../version.js'

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

  constructor() {
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
        this.notifier.close(id)
        this.broadcast({ t: 'exit', id, generation })
        this.pushAgent(id)
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
        void this.startAgent(record).catch((error: unknown) =>
          this.log(`resume of ${record.name} failed: ${String(error)}`)
        )
      }
    }
    this.scheduleCost(2000)
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
    if (record) this.broadcast({ t: 'agent', agent: this.view(record) })
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

  private onStatus(event: AgentHookEvent): void {
    const record = this.store.get(event.agentId)
    if (!record) return
    const rt = this.rt(event.agentId)
    rt.status = event.kind
    rt.statusAt = event.at
    rt.detail = event.detail
    this.pushAgent(event.agentId)
    const decision = decideNotification(event)
    if (decision?.action === 'close') this.notifier.close(event.agentId)
    if (decision?.action === 'show') {
      const text = notificationText(record.name, decision.kind, decision.detail)
      // The dashboard rings its terminal unless a desktop notification was actually shown.
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
    if (event.kind === 'finished') {
      this.scheduleCost(1500)
      if (!event.error) this.drainQueue(event.agentId)
    }
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
    const rt = this.rt(record.id)
    const hookBase = this.hooks!.baseFor(record.id)
    const context = (resume: boolean): LaunchContext => ({
      agent: {
        id: record.id,
        harness: record.harness,
        ...(resume && record.harnessSessionId ? { harnessSessionId: record.harnessSessionId } : {}),
        ...(record.dangerousMode ? { dangerousMode: true } : {}),
        ...(record.provider ? { provider: record.provider } : {}),
        ...(record.model ? { model: record.model } : {}),
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

  private async createAgent(spec: RunSpec): Promise<{ agent: AgentView; warnings: string[] }> {
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
    socket.on('close', () => this.clients.delete(client))
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
          hookPort: this.hooks?.port
        }
      case 'subscribe': {
        if (message.output === '*') client.output = '*'
        else if (Array.isArray(message.output)) client.output = new Set(message.output)
        const ids =
          message.agents === '*' ? this.store.all().map((record) => record.id) : message.agents
        this.send(client, { t: 'agents', agents: this.views() })
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
        this.ptys.write(record.id, message.data)
        noteUserInput(record.id, message.data)
        return undefined
      }
      case 'paste': {
        const record = this.need(message.id)
        if (!this.ptys.paste(record.id, message.text))
          throw new Error(`${record.name} is not running`)
        return undefined
      }
      case 'send': {
        const record = this.need(message.id)
        if (!this.ptys.isRunning(record.id)) throw new Error(`${record.name} is not running`)
        const rt = this.rt(record.id)
        const busy = rt.status === 'working' || rt.status === 'needs-input'
        if (message.whenDone && busy) {
          rt.queue.push(message.text)
          this.pushAgent(record.id)
          return { queued: rt.queue.length }
        }
        if (rt.status === 'needs-input') {
          throw new Error(
            `${record.name} is waiting for an answer; answer it first or use --when-done`
          )
        }
        this.ptys.submit(record.id, message.text)
        return { sent: true }
      }
      case 'answer': {
        const record = this.need(message.id)
        const keys = answerKeys(record.harness, message.key as AnswerKey)
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
        return undefined
      }
      case 'interrupt': {
        const record = this.need(message.id)
        this.ptys.interrupt(record.id, interruptKeys(record.harness))
        return undefined
      }
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
        await this.stopAgent(record.id, true)
        await new Promise((resolve) => setTimeout(resolve, 800))
        return { warnings: await this.startAgent(this.store.get(record.id)!) }
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
        this.store.update(record.id, patch)
        this.pushAgent(record.id)
        // Claude Code's dangerous mode is live; a model or provider applies on the next start.
        // (`patch.dangerousMode` is undefined for "off": test the request, not the patch.)
        const live =
          message.dangerousMode !== undefined &&
          message.model === undefined &&
          message.provider === undefined &&
          record.harness === 'claude-code'
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
      default:
        throw new Error('unknown request')
    }
  }

  async shutdown(stopAgents = true): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (stopAgents) {
      // Keep `wantRunning`: `nsq up` (or the next daemon) brings them back.
      await this.ptys.killAll()
    }
    await this.notifier.dispose()
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

export async function runDaemon(): Promise<void> {
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
