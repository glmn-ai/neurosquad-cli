// Push to the phone through ntfy (https://ntfy.sh, or a self-hosted server): when an agent needs
// you, one notification with the agent's name and its question — nothing else from the terminal;
// when a working agent goes quiet (./quiet.ts), its name, how long, and the last line of its
// screen (secret-looking parts masked, 300 characters at most).
// Opt-in (`nsq phone push ntfy`). The topic URL works like a password (anyone who knows it can
// read the topic), so it is kept in the OS keyring with the optional access token, never in
// config.json or the log.
import { randomBytes } from 'node:crypto'
import { getSecret, setSecret } from './secrets.js'

export const NTFY_URL_SECRET = 'ntfy-topic-url'
export const NTFY_TOKEN_SECRET = 'ntfy-access-token'
const DEFAULT_SERVER = 'https://ntfy.sh'
/** Stored by `nsq phone push off`: off even when NSQ_NTFY_URL is set in the daemon's environment. */
export const NTFY_OFF = 'off'
const MAX_MESSAGE = 300
/** One push per agent at most this often (a flapping prompt must not spam the phone). */
const PER_AGENT_MS = 30_000

export interface NtfyTarget {
  /** The server root, e.g. `https://ntfy.sh`. */
  server: string
  topic: string
}

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i

/**
 * Parses and checks a topic URL (`https://ntfy.sh/<topic>`, `https://ntfy.example.com/sub/<topic>`).
 * https, or plain http only to this machine or the local network; no credentials in the URL.
 */
export function parseNtfyUrl(raw: string): NtfyTarget {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('not a URL (expected https://ntfy.sh/<topic>)')
  }
  if (url.username || url.password) {
    throw new Error('no user:password in the URL; give an access token with --token')
  }
  if (url.search || url.hash) throw new Error('the topic URL takes no ?query or #fragment')
  const local = PRIVATE_HOST.test(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(
      'the ntfy server must use https (http only on this machine or the local network)'
    )
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const topic = parts.pop()
  if (!topic || !/^[\w-]{1,64}$/.test(topic)) {
    throw new Error('the URL must end with a topic name (letters, digits, - and _)')
  }
  const prefix = parts.length ? `/${parts.join('/')}` : ''
  return { server: `${url.protocol}//${url.host}${prefix}`, topic }
}

/**
 * An access token only travels over https, or over plain http to this machine (nothing on the
 * network to read it). Plain http on the LAN is for a token-less server.
 */
export function checkTokenTransport(target: NtfyTarget, token: string | undefined): void {
  const loopback = /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i
  if (token && !target.server.startsWith('https:') && !loopback.test(target.server)) {
    throw new Error('an access token needs an https ntfy server (it would travel in clear text)')
  }
}

/**
 * The server new topics are made on: ntfy.sh, or NSQ_NTFY_SERVER (a self-hosted server — and the
 * tests' local stand-in, so no automated run creates topics on ntfy.sh).
 */
export function defaultNtfyServer(): string {
  const own = process.env['NSQ_NTFY_SERVER']?.trim()
  return own ? own.replace(/\/+$/, '') : DEFAULT_SERVER
}

/** A fresh, unguessable topic on ntfy.sh for `nsq phone push ntfy` without a URL. */
export function randomNtfyUrl(server: string = defaultNtfyServer()): string {
  return `${server}/nsq-${randomBytes(12).toString('hex')}`
}

/**
 * What a phone scans to subscribe. The ntfy Android app registers the `ntfy://` scheme (any host,
 * `?secure=false` for a plain-http server, `display=` names the subscription): the camera opens the
 * app on the topic, subscribed. The iOS app registers no URL scheme and no universal links, so
 * an iPhone gets the topic's https address — the ntfy web app, where it can subscribe — and the
 * topic name to add in the iOS app by hand (see docs/guide/notifications.md).
 */
export function ntfySubscribeLinks(target: NtfyTarget): { android: string; web: string } {
  const url = new URL(target.server)
  const query = new URLSearchParams({ display: 'nsq' })
  if (url.protocol === 'http:') query.set('secure', 'false')
  const path = url.pathname.replace(/\/+$/, '')
  return {
    android: `ntfy://${url.host}${path}/${target.topic}?${query.toString()}`,
    web: `${target.server}/${target.topic}`
  }
}

/** The outcome of the daemon's last push (shown in the phone panel; never the topic). */
export interface PushResult {
  at: number
  ok: boolean
  kind: 'test' | 'needs-you' | 'quiet'
  error?: string
}

export interface NeedsYou {
  agentId: string
  agentName: string
  question?: string
  /** Where the phone page is (without the token), when phone access is on the network. */
  click?: string
}

/** The JSON message ntfy publishes (https://docs.ntfy.sh/publish/#publish-as-json). */
export function ntfyMessage(target: NtfyTarget, event: NeedsYou): Record<string, unknown> {
  return {
    topic: target.topic,
    title: `${event.agentName} needs you`,
    message: pushText(event.question ?? 'is waiting for you'),
    priority: 4,
    tags: ['bell'],
    ...(event.click ? { click: event.click } : {})
  }
}

export interface QuietPush {
  agentId: string
  agentName: string
  /** How long the screen has been still ("7 min"). */
  duration: string
  /** The last non-empty screen line (secrets already masked by the caller). */
  line?: string
  /** The line looks like a tool asking something: that line. */
  asking?: string
  click?: string
}

/** The message for a quiet agent: no answer keys (nsq does not know what it waits for). */
export function ntfyQuietMessage(target: NtfyTarget, event: QuietPush): Record<string, unknown> {
  const context = event.asking
    ? `Looks like it's asking: ${event.asking}`
    : event.line
      ? `Last line: ${event.line}`
      : 'No new output. Check it.'
  return {
    topic: target.topic,
    title: pushText(`${event.agentName} has been quiet for ${event.duration}`),
    message: pushText(context),
    priority: 4,
    tags: ['hourglass'],
    ...(event.click ? { click: event.click } : {})
  }
}

/** Plain words only, cut to the message limit. */
function pushText(text: string): string {
  const plain = text
    // Plain words only: escape sequences out, other control characters to spaces.
    // eslint-disable-next-line no-control-regex -- terminal escape sequences
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, '')
    // eslint-disable-next-line no-control-regex -- control characters
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > MAX_MESSAGE ? `${plain.slice(0, MAX_MESSAGE - 1)}…` : plain
}

export class NtfyPush {
  private readonly last = new Map<string, { at: number; question?: string }>()
  private readonly inFlight = new Set<string>()
  /** Bumped when an agent is answered: a delivery that was in flight then no longer counts. */
  private readonly generation = new Map<string, number>()
  /** The last push this sender made, for the phone panel. */
  lastResult: PushResult | undefined

  constructor(
    private readonly log: (line: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** The configured target and token, or null when push is off. */
  async target(): Promise<{ target: NtfyTarget; token?: string } | null> {
    const stored = await getSecret(NTFY_URL_SECRET)
    if (stored === NTFY_OFF) return null
    const raw = stored ?? process.env['NSQ_NTFY_URL']
    if (!raw) return null
    try {
      // A token belongs to its URL: the keyring's with the keyring's, the environment's with the
      // environment's - never an environment token sent to a server stored in the keyring.
      const token = stored
        ? await getSecret(NTFY_TOKEN_SECRET)
        : process.env['NSQ_NTFY_TOKEN'] || undefined
      const target = parseNtfyUrl(raw)
      checkTokenTransport(target, token)
      return { target, ...(token ? { token } : {}) }
    } catch (error) {
      this.log(`ntfy push is off: ${error instanceof Error ? error.message : 'bad settings'}`)
      return null
    }
  }

  /** Sends one needs-you notification (deduplicated and rate-limited per agent). */
  async needsYou(event: NeedsYou): Promise<boolean> {
    const configured = await this.target()
    if (!configured) return false
    const previous = this.last.get(event.agentId)
    const now = this.now()
    if (previous && now - previous.at < PER_AGENT_MS && previous.question === event.question) {
      return false
    }
    // One send at a time per agent, question and answer generation; the 30 s memory only after
    // a delivery that was not overtaken by an answer.
    const gen = this.generation.get(event.agentId) ?? 0
    const key = `${event.agentId}\u0000${gen}\u0000${event.question ?? ''}`
    if (this.inFlight.has(key)) return false
    this.inFlight.add(key)
    try {
      const ok = await this.send(
        configured.target,
        configured.token,
        ntfyMessage(configured.target, event)
      )
      if (ok && (this.generation.get(event.agentId) ?? 0) === gen) {
        this.last.set(event.agentId, { at: now, question: event.question })
      }
      return ok
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** Sends a quiet notification (the daemon sends one per quiet episode). */
  async quiet(event: QuietPush): Promise<boolean> {
    const configured = await this.target()
    if (!configured) return false
    return this.send(
      configured.target,
      configured.token,
      ntfyQuietMessage(configured.target, event),
      'quiet'
    )
  }

  /** Clears the per-agent memory (the agent was answered: the next question pushes again). */
  answered(agentId: string): void {
    this.last.delete(agentId)
    this.generation.set(agentId, (this.generation.get(agentId) ?? 0) + 1)
  }

  async send(
    target: NtfyTarget,
    token: string | undefined,
    message: Record<string, unknown>,
    kind: PushResult['kind'] = 'needs-you'
  ): Promise<boolean> {
    const at = this.now()
    try {
      const response = await this.fetchImpl(target.server, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(message),
        // A redirect would carry the token and the question somewhere else: never followed.
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        // The topic is a secret: the log names the status only.
        this.log(`ntfy push failed: HTTP ${response.status}`)
        this.lastResult = { at, ok: false, kind, error: `HTTP ${response.status}` }
        return false
      }
      this.lastResult = { at, ok: true, kind }
      return true
    } catch (error) {
      const name = error instanceof Error ? error.name : 'error'
      this.log(`ntfy push failed: ${name}`)
      this.lastResult = {
        at,
        ok: false,
        kind,
        error: name === 'TimeoutError' ? 'no answer in 10 s' : 'could not reach the server'
      }
      return false
    }
  }
}

/** Stores (or clears) the push settings. */
export async function saveNtfy(url: string | undefined, token: string | undefined): Promise<void> {
  await setSecret(NTFY_URL_SECRET, url)
  await setSecret(NTFY_TOKEN_SECRET, token)
}
