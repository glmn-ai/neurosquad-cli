// Push to the phone through ntfy (https://ntfy.sh, or a self-hosted server): when an agent needs
// you, one notification with the agent's name and its question — nothing else from the terminal.
// Opt-in (`nsq phone push ntfy`). The topic URL works like a password (anyone who knows it can
// read the topic), so it is kept in the OS keyring with the optional access token, never in
// config.json or the log.
import { randomBytes } from 'node:crypto'
import { getSecret, setSecret } from './secrets.js'

export const NTFY_URL_SECRET = 'ntfy-topic-url'
export const NTFY_TOKEN_SECRET = 'ntfy-access-token'
const DEFAULT_SERVER = 'https://ntfy.sh'
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

/** A fresh, unguessable topic on ntfy.sh for `nsq phone push ntfy` without a URL. */
export function randomNtfyUrl(): string {
  return `${DEFAULT_SERVER}/nsq-${randomBytes(12).toString('hex')}`
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
  const question = (event.question ?? 'is waiting for you')
    // Plain words only: escape sequences out, other control characters to spaces.
    // eslint-disable-next-line no-control-regex -- terminal escape sequences
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, '')
    // eslint-disable-next-line no-control-regex -- control characters
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    topic: target.topic,
    title: `${event.agentName} needs you`,
    message: question.length > MAX_MESSAGE ? `${question.slice(0, MAX_MESSAGE - 1)}…` : question,
    priority: 4,
    tags: ['bell'],
    ...(event.click ? { click: event.click } : {})
  }
}

export class NtfyPush {
  private readonly last = new Map<string, { at: number; question?: string }>()

  constructor(
    private readonly log: (line: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** The configured target and token, or null when push is off. */
  async target(): Promise<{ target: NtfyTarget; token?: string } | null> {
    const raw = (await getSecret(NTFY_URL_SECRET)) ?? process.env['NSQ_NTFY_URL']
    if (!raw) return null
    try {
      const token = (await getSecret(NTFY_TOKEN_SECRET)) ?? process.env['NSQ_NTFY_TOKEN']
      return { target: parseNtfyUrl(raw), ...(token ? { token } : {}) }
    } catch {
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
    this.last.set(event.agentId, { at: now, question: event.question })
    return this.send(configured.target, configured.token, ntfyMessage(configured.target, event))
  }

  /** Clears the per-agent memory (the agent was answered: the next question pushes again). */
  answered(agentId: string): void {
    this.last.delete(agentId)
  }

  async send(
    target: NtfyTarget,
    token: string | undefined,
    message: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const response = await this.fetchImpl(target.server, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        // The topic is a secret: the log names the status only.
        this.log(`ntfy push failed: HTTP ${response.status}`)
        return false
      }
      return true
    } catch (error) {
      this.log(`ntfy push failed: ${error instanceof Error ? error.name : 'error'}`)
      return false
    }
  }
}

/** Stores (or clears) the push settings. */
export async function saveNtfy(url: string | undefined, token: string | undefined): Promise<void> {
  await setSecret(NTFY_URL_SECRET, url)
  await setSecret(NTFY_TOKEN_SECRET, token)
}
