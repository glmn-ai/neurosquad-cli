// The phone API: a small token-guarded HTTP server that lets a paired phone watch nsq's agents and
// answer them — status, the terminal mirror as text, needs-you events, a prompt, the three
// permission answers and the interrupt. Nothing else (capabilities.ts).
//
// ---- THREAT MODEL -------------------------------------------------------
//
// Bound to loopback unless the host passes another address: a phone on the Wi-Fi needs the LAN
// address (or 0.0.0.0), and that is the host's explicit, opt-in choice. Anyone who can reach the
// port and holds the pairing token can read every agent's screen and send prompts — so:
//   - the pairing token (24 random bytes) is required on every `/api/**` request, including the
//     event stream, compared in constant time; there is no unauthenticated read path and no
//     "loopback is trusted" shortcut;
//   - repeated wrong tokens from one address are throttled (the 48 hex characters cannot be
//     walked), writes are rate-limited per address and bodies are capped;
//   - no CORS headers: a web page in the phone's (or the desktop's) browser cannot read answers
//     cross-origin, and a DNS-rebinding page still needs the token;
//   - `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `nosniff`, `X-Frame-Options: DENY`;
//   - errors from the host are answered generically unless they are a `PhoneHostError`;
//   - `rotateToken()` is the revoke button: every open stream and held poll is closed at once and
//     the old token stops working.
//
// Not a substitute for HTTPS: plain HTTP on a home network leaks the token to anyone sniffing it.
// Through a tunnel or a reverse proxy with a real certificate it is fine (docs/remote-proposal.md).
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename } from 'node:path'
import { PHONE_BLOCKED, PHONE_CAPABILITIES } from './capabilities.js'
import { tokenMatches } from './token.js'
import {
  PhoneHostError,
  type PhoneAgentSummary,
  type PhoneAnswer,
  type PhoneEvent,
  type PhoneHost,
  type PhoneHostAgent,
  type PhoneHostEvent,
  type PhoneScreen,
  type PhoneState,
  type PhoneWorkspaceDetail,
  type PhoneWorkspaceSummary
} from './types.js'

export const DEFAULT_PHONE_PORT = 8766
export const MAX_PHONE_PROMPT_CHARS = 4000
export const MAX_PHONE_BODY_BYTES = 64 * 1024
const DEFAULT_SCREEN_LINES = 200
const MAX_SCREEN_LINES = 600
const MAX_DETAIL_CHARS = 500
const EVENT_LOG_MAX = 200
const MAX_STREAM_BACKLOG_BYTES = 4 * 1024 * 1024
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/
/** C0 controls except tab and newline, DEL and C1 controls. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const ANSWERS: readonly PhoneAnswer[] = ['yes', 'always', 'no']

export interface PhoneServerLimits {
  /** Wrong tokens per address per window before 429. */
  failures: number
  /** Writes per address per window before 429. */
  writes: number
  windowMs: number
}

export interface PhoneServerOptions {
  host: PhoneHost
  /** The pairing token (generatePairingToken); the host persists it. */
  token: string
  /** Default `127.0.0.1`. Pass a LAN address (or `0.0.0.0`) to let a phone on the Wi-Fi in. */
  bindAddress?: string
  /** Default 8766 (the desktop app uses 8765). 0 = any free port. */
  port?: number
  limits?: Partial<PhoneServerLimits>
  /** How long a long poll is held open. Default 25 s. */
  pollHoldMs?: number
  /** How often the agent list is re-read while someone listens. Default 2 s. */
  statePollMs?: number
  keepAliveMs?: number
  /** Diagnostics; lines never contain the token or request bodies. */
  log?: (line: string) => void
  /**
   * Called when the set of connected phones may have changed (a phone appeared, opened or closed
   * its event stream or poll, the token was rotated, the server stopped). A phone that only goes
   * quiet drops out of `connections()` after a minute without a call; re-read on a timer for that.
   */
  onConnectionsChange?: () => void
  now?: () => number
}

/** A paired phone (or another client holding the token) seen recently. */
export interface PhoneConnection {
  /** The remote address as the socket reports it. */
  address: string
  /** A short label from the User-Agent ("iPhone · Safari"), or "unknown device". */
  device: string
  firstSeen: number
  lastSeen: number
  /** Event streams and held polls open right now. */
  open: number
}

/** How long a client counts as connected after its last call when it holds nothing open. */
export const PHONE_CONNECTION_IDLE_MS = 60_000

/** "iPhone · Safari", "Android · Chrome", "Windows · Firefox", "curl"… — never the raw string. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  if (!ua.trim()) return 'unknown device'
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  const browser = /EdgA?\//.test(ua)
    ? 'Edge'
    : /FxiOS|Firefox\//.test(ua)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : ''
  if (os || browser) return [os, browser].filter(Boolean).join(' · ')
  // A tool (curl/8.4, okhttp/4.12): its name only, printable, short.
  const tool = /^([A-Za-z][\w.-]{0,23})/.exec(ua)?.[1]
  return tool ?? 'unknown device'
}

interface Client {
  address: string
  device: string
  firstSeen: number
  lastSeen: number
  open: number
}

interface Bucket {
  failures: number
  failureWindow: number
  writes: number
  writeWindow: number
}

interface Waiter {
  since: number
  res: ServerResponse
  timer: ReturnType<typeof setTimeout>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

/** A stable uuid-shaped id for a project path (phone clients expect uuids for workspaces). */
export function workspaceIdFor(path: string): string {
  const hex = createHash('sha256').update(path).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function summarize(agent: PhoneHostAgent): PhoneAgentSummary {
  const detail = clip(agent.detail, MAX_DETAIL_CHARS)
  return {
    id: agent.id,
    workspaceId: workspaceIdFor(agent.workspace),
    ...(agent.name ? { name: agent.name } : {}),
    harness: agent.harness,
    ...(agent.status ? { status: agent.status } : {}),
    running: agent.running,
    hasTerminal: true,
    ...(detail && agent.status === 'needs-input' ? { detail } : {})
  }
}

function workspacesOf(
  agents: PhoneHostAgent[],
  summaries: PhoneAgentSummary[]
): PhoneWorkspaceSummary[] {
  const byId = new Map<string, PhoneWorkspaceSummary>()
  agents.forEach((agent, index) => {
    const id = workspaceIdFor(agent.workspace)
    const workspace =
      byId.get(id) ??
      ({
        id,
        name: basename(agent.workspace) || agent.workspace,
        path: agent.workspace,
        cardCount: 0,
        workingCount: 0,
        needsInputCount: 0
      } satisfies PhoneWorkspaceSummary)
    workspace.cardCount += 1
    if (summaries[index].status === 'working') workspace.workingCount += 1
    if (summaries[index].status === 'needs-input') workspace.needsInputCount += 1
    byId.set(id, workspace)
  })
  return [...byId.values()]
}

/** What a phone would notice in the list: which agents exist, their names and projects. */
function stateSignature(state: PhoneState): string {
  return state.agents
    .map((agent) => `${agent.id}:${agent.workspaceId}:${agent.name ?? ''}:${agent.running}`)
    .join('|')
}

export class PhoneServer {
  private server: Server | null = null
  private token: string
  private readonly limits: PhoneServerLimits
  private readonly buckets = new Map<string, Bucket>()
  private lastSweep = 0
  private readonly streams = new Set<ServerResponse>()
  private readonly waiters = new Set<Waiter>()
  private readonly clients = new Map<string, Client>()
  private readonly eventLog: { seq: number; event: PhoneEvent }[] = []
  private lastSeq = 0
  private lastPollAt = 0
  private lastSignature = ''
  private stateTimer: ReturnType<typeof setInterval> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly now: () => number

  constructor(private readonly options: PhoneServerOptions) {
    if (!options.token) throw new Error('A pairing token is required')
    this.token = options.token
    this.now = options.now ?? Date.now
    this.limits = { failures: 20, writes: 40, windowMs: 60_000, ...options.limits }
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<{ address: string; port: number }> {
    if (this.server) return this.address()
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.options.log?.(
          `phone: request failed: ${error instanceof Error ? error.name : 'error'}`
        )
        try {
          if (!res.headersSent) this.json(res, 500, { error: 'Internal error' })
          else res.end()
        } catch {
          // The phone hung up.
        }
      })
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(
        this.options.port ?? DEFAULT_PHONE_PORT,
        this.options.bindAddress ?? '127.0.0.1',
        () => {
          server.off('error', reject)
          resolve()
        }
      )
    })
    this.server = server
    this.unsubscribe = this.options.host.subscribe((event) => this.onHostEvent(event))
    return this.address()
  }

  address(): { address: string; port: number } {
    const info = this.server?.address() as AddressInfo | null | undefined
    if (!info) throw new Error('The phone server is not running')
    return { address: info.address, port: info.port }
  }

  get running(): boolean {
    return this.server !== null
  }

  /** Open event streams plus long-pollers seen in the last minute. */
  connectionCount(): number {
    return this.streams.size + this.waiters.size
  }

  /**
   * Who is connected: every client that passed the token and holds a stream or poll open, or made
   * a call in the last minute. One entry per address and device, oldest first.
   */
  connections(): PhoneConnection[] {
    const now = this.now()
    const live: PhoneConnection[] = []
    for (const [key, client] of this.clients) {
      if (client.open > 0 || now - client.lastSeen < PHONE_CONNECTION_IDLE_MS) {
        live.push({ ...client })
      } else {
        this.clients.delete(key)
      }
    }
    return live.sort((a, b) => a.firstSeen - b.firstSeen)
  }

  private connectionsChanged(): void {
    try {
      this.options.onConnectionsChange?.()
    } catch {
      // The host's listener is its own business.
    }
  }

  /** Records an authorized request; returns the client so a stream or poll can hold it open. */
  private seen(req: IncomingMessage): Client {
    const address = req.socket.remoteAddress ?? 'unknown'
    const device = deviceLabel(req.headers['user-agent'])
    const key = `${address}|${device}`
    const now = this.now()
    let client = this.clients.get(key)
    const fresh =
      !client || (client.open === 0 && now - client.lastSeen >= PHONE_CONNECTION_IDLE_MS)
    if (!client) {
      client = { address, device, firstSeen: now, lastSeen: now, open: 0 }
      this.clients.set(key, client)
    }
    if (fresh) client.firstSeen = now
    client.lastSeen = now
    if (fresh) this.connectionsChanged()
    return client
  }

  private hold(client: Client, res: ServerResponse): void {
    client.open += 1
    if (client.open === 1) this.connectionsChanged()
    res.once('close', () => {
      client.open = Math.max(0, client.open - 1)
      client.lastSeen = this.now()
      if (client.open === 0) this.connectionsChanged()
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.closeClients()
    this.stopTimers()
    this.clients.clear()
    this.connectionsChanged()
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }

  /** The revoke button: the old token stops working and everyone connected is cut off. */
  rotateToken(token: string): void {
    if (!token) throw new Error('A pairing token is required')
    this.token = token
    this.buckets.clear()
    this.closeClients()
    this.clients.clear()
    this.connectionsChanged()
  }

  private closeClients(): void {
    for (const res of this.streams) {
      try {
        res.end()
      } catch {
        // Already gone.
      }
    }
    this.streams.clear()
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      try {
        waiter.res.destroy()
      } catch {
        // Already gone.
      }
    }
  }

  // -------------------------------------------------------------------- auth

  private bucketFor(req: IncomingMessage): Bucket {
    const now = this.now()
    if (now - this.lastSweep >= this.limits.windowMs) {
      this.lastSweep = now
      for (const [key, bucket] of this.buckets) {
        if (
          now - bucket.failureWindow > this.limits.windowMs &&
          now - bucket.writeWindow > this.limits.windowMs
        ) {
          this.buckets.delete(key)
        }
      }
    }
    const key = req.socket.remoteAddress ?? 'unknown'
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { failures: 0, failureWindow: now, writes: 0, writeWindow: now }
      this.buckets.set(key, bucket)
    }
    if (now - bucket.failureWindow > this.limits.windowMs) {
      bucket.failures = 0
      bucket.failureWindow = now
    }
    if (now - bucket.writeWindow > this.limits.windowMs) {
      bucket.writes = 0
      bucket.writeWindow = now
    }
    return bucket
  }

  /** `Authorization: Bearer`, or `?t=` (EventSource cannot set headers). */
  private presentedToken(req: IncomingMessage, query: URLSearchParams): string {
    const header = req.headers.authorization
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
    return query.get('t') ?? ''
  }

  // ----------------------------------------------------------------- routing

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    const url = new URL(req.url ?? '/', 'http://phone.invalid')
    const path = url.pathname
    const method = req.method ?? 'GET'
    if (!path.startsWith('/api/')) {
      // No UI is served here (docs/remote-proposal.md) and nothing outside /api exists.
      this.json(res, 404, { error: 'Not found' })
      return
    }
    const bucket = this.bucketFor(req)
    if (bucket.failures >= this.limits.failures) {
      this.json(res, 429, { error: 'Too many attempts' })
      return
    }
    if (!tokenMatches(this.presentedToken(req, url.searchParams), this.token)) {
      bucket.failures += 1
      this.json(res, 401, { error: 'Unauthorized' })
      return
    }
    const client = this.seen(req)
    if (path === '/api/events' || path === '/api/poll') this.hold(client, res)
    if (method !== 'GET') {
      bucket.writes += 1
      if (bucket.writes > this.limits.writes) {
        this.json(res, 429, { error: 'Slow down' })
        return
      }
    }
    try {
      await this.route(req, res, method, path, url.searchParams)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) {
        this.json(res, error.status, {
          error: error.message,
          ...(error.code ? { code: error.code } : {})
        })
      } else if (error instanceof PhoneHostError) {
        const status = error.code === 'not-found' ? 404 : error.code === 'refused' ? 403 : 409
        this.json(res, status, { error: error.message, code: error.code })
      } else {
        throw error
      }
    }
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: URLSearchParams
  ): Promise<void> {
    if (method === 'GET' && path === '/api/state') {
      this.json(res, 200, await this.currentState())
      return
    }
    if (method === 'GET' && path === '/api/events') {
      await this.openStream(req, res)
      return
    }
    if (method === 'GET' && path === '/api/poll') {
      await this.handlePoll(req, res, query)
      return
    }
    if (method === 'GET' && path === '/api/capabilities') {
      this.json(res, 200, { capabilities: PHONE_CAPABILITIES, blocked: PHONE_BLOCKED })
      return
    }
    // The desktop phone client asks which cards it may create; the answer here is "none".
    if (method === 'GET' && path === '/api/kinds') {
      this.json(res, 200, { kinds: [] })
      return
    }
    if (method === 'POST' && (path === '/api/agent' || path === '/api/workspace')) {
      throw new HttpError(403, 'Not available from the phone — do this on the machine.', 'blocked')
    }

    const workspace = /^\/api\/workspace\/([0-9a-f-]{36})$/i.exec(path)
    if (workspace && method === 'GET') {
      this.json(res, 200, await this.workspaceDetail(workspace[1].toLowerCase()))
      return
    }

    const agentRoute = /^\/api\/agent\/([^/]+)\/(screen|prompt|answer|interrupt)$/.exec(path)
    if (!agentRoute) throw new HttpError(404, 'Not found')
    const [, agentId, action] = agentRoute
    if (!AGENT_ID.test(agentId)) throw new HttpError(404, 'No such agent')
    if (action === 'screen') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed')
      const asked = Number.parseInt(query.get('lines') ?? '', 10)
      const lines =
        Number.isFinite(asked) && asked > 0
          ? Math.min(asked, MAX_SCREEN_LINES)
          : DEFAULT_SCREEN_LINES
      this.json(res, 200, await this.screen(agentId, lines))
      return
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed')
    const body = await this.readBody(req)
    const agent = await this.findAgent(agentId)
    if (action === 'prompt') {
      const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : ''
      if (!text) throw new HttpError(400, 'Empty prompt')
      // A prompt is text: no Escape sequences, Ctrl keys or a stray Enter that would act on the
      // terminal (the answer and interrupt routes are the only ways to send keys).
      if (CONTROL_CHARS.test(text)) {
        throw new HttpError(400, 'The prompt contains control characters')
      }
      if (text.length > MAX_PHONE_PROMPT_CHARS) throw new HttpError(413, 'Prompt too long')
      if (!agent.running) throw new HttpError(409, 'This agent is not running', 'not-running')
      await this.options.host.submit(agent.id, text)
    } else if (action === 'answer') {
      const answer = body.key
      if (typeof answer !== 'string' || !(ANSWERS as readonly string[]).includes(answer)) {
        throw new HttpError(400, 'The answer must be yes, always or no')
      }
      if (!agent.running) throw new HttpError(409, 'This agent is not running', 'not-running')
      await this.options.host.answer(agent.id, answer as PhoneAnswer)
    } else {
      if (!agent.running) throw new HttpError(409, 'This agent is not running', 'not-running')
      await this.options.host.interrupt(agent.id)
    }
    this.json(res, 202, { ok: true })
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_PHONE_BODY_BYTES) throw new HttpError(413, 'Body too large')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_PHONE_BODY_BYTES) throw new HttpError(413, 'Body too large')
      chunks.push(chunk as Buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new HttpError(400, 'The body must be JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'The body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }

  // -------------------------------------------------------------------- data

  private async agents(): Promise<PhoneHostAgent[]> {
    return [...(await this.options.host.listAgents())]
  }

  private async findAgent(agentId: string): Promise<PhoneHostAgent> {
    const agent = (await this.agents()).find((entry) => entry.id === agentId)
    if (!agent) throw new HttpError(404, 'No such agent')
    return agent
  }

  private async currentState(): Promise<PhoneState> {
    const agents = await this.agents()
    const summaries = agents.map(summarize)
    return { workspaces: workspacesOf(agents, summaries), agents: summaries, at: this.now() }
  }

  private async workspaceDetail(id: string): Promise<PhoneWorkspaceDetail> {
    const state = await this.currentState()
    const workspace = state.workspaces.find((entry) => entry.id === id)
    if (!workspace) throw new HttpError(404, 'No such workspace')
    return {
      workspace,
      groups: [],
      agents: state.agents.filter((agent) => agent.workspaceId === id),
      canvas: { nodes: [], edges: [] }
    }
  }

  private async screen(agentId: string, lines: number): Promise<PhoneScreen> {
    const agent = await this.findAgent(agentId)
    const screen = await this.options.host.screen(agentId, lines)
    return {
      agentId,
      screen: screen ?? '',
      running: agent.running,
      ...(agent.status ? { status: agent.status } : {}),
      queued: agent.queued ?? 0
    }
  }

  // ------------------------------------------------------------------ events

  private hasListeners(): boolean {
    return this.streams.size > 0 || this.waiters.size > 0 || this.now() - this.lastPollAt < 60_000
  }

  private onHostEvent(event: PhoneHostEvent): void {
    if (!this.hasListeners()) return
    try {
      if (event.type === 'status') {
        this.broadcast({
          type: 'status',
          agentId: event.agentId,
          status: event.status,
          at: event.at ?? this.now()
        })
      } else if (event.type === 'attention') {
        void this.attention(event).catch(() => undefined)
      } else {
        void this.pollState().catch(() => undefined)
      }
    } catch (error) {
      // A host event arrives on the host's own stack (a pty callback): never throw into it.
      this.options.log?.(`phone: event failed: ${error instanceof Error ? error.name : 'error'}`)
    }
  }

  private async attention(event: Extract<PhoneHostEvent, { type: 'attention' }>): Promise<void> {
    const agent = (await this.agents()).find((entry) => entry.id === event.agentId)
    if (!agent) return
    const detail = clip(event.detail, MAX_DETAIL_CHARS)
    this.broadcast({
      type: 'attention',
      agentId: agent.id,
      agentName: agent.name,
      workspaceId: workspaceIdFor(agent.workspace),
      workspaceName: basename(agent.workspace) || agent.workspace,
      kind: event.kind,
      ...(detail ? { detail } : {}),
      at: event.at ?? this.now()
    })
  }

  private broadcast(event: PhoneEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of [...this.streams]) {
      if (res.writableLength > MAX_STREAM_BACKLOG_BYTES) {
        // A phone that stopped reading: dropped, it reconnects and gets the whole state again.
        this.streams.delete(res)
        res.destroy()
        continue
      }
      try {
        res.write(frame)
      } catch {
        this.streams.delete(res)
      }
    }
    this.lastSeq += 1
    this.eventLog.push({ seq: this.lastSeq, event })
    if (this.eventLog.length > EVENT_LOG_MAX) {
      this.eventLog.splice(0, this.eventLog.length - EVENT_LOG_MAX)
    }
    for (const waiter of [...this.waiters]) this.answerWaiter(waiter)
  }

  private async pollState(): Promise<void> {
    if (!this.hasListeners()) {
      this.stopTimers()
      return
    }
    const state = await this.currentState()
    const signature = stateSignature(state)
    if (signature === this.lastSignature) return
    this.lastSignature = signature
    this.broadcast({ type: 'state', state })
  }

  private ensureTimers(): void {
    if (!this.stateTimer) {
      this.stateTimer = setInterval(() => {
        void this.pollState().catch(() => undefined)
      }, this.options.statePollMs ?? 2000)
      this.stateTimer.unref()
    }
    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => {
        for (const res of this.streams) {
          try {
            res.write(': keep-alive\n\n')
          } catch {
            this.streams.delete(res)
          }
        }
      }, this.options.keepAliveMs ?? 20_000)
      this.keepAliveTimer.unref()
    }
  }

  private stopTimers(): void {
    if (this.stateTimer) clearInterval(this.stateTimer)
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.stateTimer = null
    this.keepAliveTimer = null
  }

  private async openStream(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Anyone already listening hears about a pending change first: the new client's snapshot is
    // about to become the reference the state timer compares against.
    if (this.lastSignature) await this.pollState()
    const state = await this.currentState()
    // The phone may have hung up during the awaits; its `close` has fired already.
    if (res.destroyed || res.writableEnded) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write('retry: 3000\n\n')
    res.write(`data: ${JSON.stringify({ type: 'state', state } satisfies PhoneEvent)}\n\n`)
    this.lastSignature = stateSignature(state)
    this.streams.add(res)
    this.ensureTimers()
    res.on('close', () => {
      this.streams.delete(res)
    })
  }

  private answerWaiter(waiter: Waiter): void {
    this.waiters.delete(waiter)
    clearTimeout(waiter.timer)
    try {
      this.json(waiter.res, 200, {
        seq: this.lastSeq,
        events: this.eventLog
          .filter((entry) => entry.seq > waiter.since)
          .map((entry) => entry.event)
      })
    } catch {
      // The phone hung up while its request was held.
    }
  }

  /**
   * `GET /api/poll?since=<seq>`: anything newer than `since` at once, otherwise held until an event
   * arrives or the hold time passes. A `since` the log cannot honour (absent, negative, older than
   * the log, from the future after a restart) gets the whole current state. `0` is a valid
   * position — the answer while nothing has happened yet — so it waits rather than looping.
   */
  private async handlePoll(
    _req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams
  ): Promise<void> {
    this.lastPollAt = this.now()
    this.ensureTimers()
    const since = Number.parseInt(query.get('since') ?? '', 10)
    const oldestKept = this.eventLog[0]?.seq ?? this.lastSeq + 1
    if (!Number.isFinite(since) || since < 0 || since > this.lastSeq || since < oldestKept - 1) {
      if (this.lastSignature) await this.pollState()
      const state = await this.currentState()
      // The poller now has this list; the state timer must not send it again as a "change".
      this.lastSignature = stateSignature(state)
      this.json(res, 200, { seq: this.lastSeq, events: [{ type: 'state', state }] })
      return
    }
    if (this.lastSeq > since) {
      this.json(res, 200, {
        seq: this.lastSeq,
        events: this.eventLog.filter((entry) => entry.seq > since).map((entry) => entry.event)
      })
      return
    }
    const waiter: Waiter = {
      since,
      res,
      timer: setTimeout(() => this.answerWaiter(waiter), this.options.pollHoldMs ?? 25_000)
    }
    this.waiters.add(waiter)
    res.on('close', () => {
      if (!this.waiters.has(waiter)) return
      this.waiters.delete(waiter)
      clearTimeout(waiter.timer)
    })
  }
}
