// The daemon ⇄ client protocol: one JSON object per line over the daemon's
// local socket. Requests carry an `rid` and get exactly one `reply`; events
// are pushed to clients that subscribed.
import type { AgentStatusKind, HarnessId, SubagentInfo } from '@neurosquad/core'
import type { UpdateView } from './update/updater.js'
import type { QuietView } from './daemon/quiet.js'

export type { UpdateView, QuietView }

export const PROTOCOL_VERSION = 1

/**
 * What a daemon can do, by name, and the first nsq release that could. A daemon lists the names it
 * knows in its hello (`capabilities`, since 0.4.1); for older daemons, which list none, a client
 * goes by their version. A client checks before it asks, so a feature newer than the running
 * daemon says why it is missing instead of failing with "unknown request". A new request type (or
 * a new form of one an older daemon would misread) gets a name here, with the release it ships in.
 */
export const CAPABILITY_SINCE = {
  phone: '0.1.0',
  /** `phone on` through a Cloudflare tunnel (`online` / `named`). */
  'phone.online': '0.2.0',
  update: '0.2.0',
  handover: '0.2.1',
  /** ntfy push from the dashboard's phone panel (`push`). */
  push: '0.4.0',
  /** Quiet-while-working: `set` with `quietAfter` (per agent). */
  quiet: '0.5.0'
} as const

export type Capability = keyof typeof CAPABILITY_SINCE

/** Everything this copy's daemon knows (sent in its hello). */
export const CAPABILITIES = Object.keys(CAPABILITY_SINCE) as Capability[]

/** The capability a request needs, when it is one that not every daemon knows. */
export function requestCapability(request: Request): Capability | undefined {
  switch (request.t) {
    case 'phone':
      return request.action === 'on' && (request.online === true || request.named === true)
        ? 'phone.online'
        : 'phone'
    case 'update':
    case 'handover':
    case 'push':
      return request.t
    case 'set':
      return request.quietAfter !== undefined ? 'quiet' : undefined
    default:
      return undefined
  }
}

/** The error text a daemon answers a request type it does not know with (every release). */
export const UNKNOWN_REQUEST = 'unknown request'

/** What clients see of an agent (never a secret). */
export interface AgentView {
  id: string
  name: string
  harness: HarnessId
  /** The folder the agent was started in (its workspace). */
  workspace: string
  /** Where it runs: the workspace or its worktree. */
  cwd: string
  worktree?: { path: string; branch: string }
  command?: string[]
  provider?: 'openrouter' | 'custom'
  /** `custom`: the user's provider (`nsq provider list`). */
  customProviderId?: string
  model?: string
  dangerousMode?: boolean
  createdAt: number
  /** The process is running. */
  running: boolean
  /** `exited` when the process is gone, else the status machine's state (undefined: nothing yet). */
  status?: AgentStatusKind | 'exited'
  statusAt?: number
  /** The harness's own wording for what it waits on / how the turn ended. */
  detail?: string
  subagents?: SubagentInfo[]
  /** Exact cost so far, in picodollars (decimal string); absent when unknown. */
  costPico?: string
  /** Requests without a known price (shown as "no price", never $0). */
  unpricedRequests?: number
  tokens?: number
  /** pty size. */
  cols?: number
  rows?: number
  /** Prompts waiting to be sent when the current turn finishes. */
  queued?: number
  /**
   * Working, but the screen has not changed for the quiet threshold (`quietAfter`): a tool may
   * be waiting for something no hook reports (a password, `[y/N]`), or it hangs. Absent otherwise.
   */
  quiet?: QuietView
  /** This agent's own quiet threshold in minutes (`nsq set --quiet-after`; 0 = off). */
  quietAfter?: number
}

export interface RunSpec {
  harness: HarnessId
  name?: string
  /** Absolute folder; the client's cwd by default. */
  cwd: string
  prompt?: string
  worktree?: boolean
  provider?: 'openrouter' | 'custom'
  /** `custom`: the user's provider (`nsq provider list`). */
  customProviderId?: string
  model?: string
  dangerousMode?: boolean
  /** `command` harness: argv. */
  command?: string[]
  /** A harness: extra arguments for its CLI, passed on every start (`nsq run -- claude --effort high`). */
  args?: string[]
  /** A harness: the CLI's executable when the person named a path (`nsq run -- ./bin/codex`). */
  binary?: string
  cols?: number
  rows?: number
}

export type Request =
  | { t: 'hello'; token: string; version: number; client: string }
  | { t: 'list' }
  | { t: 'subscribe'; agents: string[] | '*'; output?: string[] | '*' }
  | { t: 'run'; spec: RunSpec }
  | { t: 'input'; id: string; data: string }
  | { t: 'paste'; id: string; text: string }
  | { t: 'send'; id: string; text: string; whenDone?: boolean }
  | { t: 'answer'; id: string; key: 'yes' | 'always' | 'no' }
  | { t: 'interrupt'; id: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'stop'; id: string }
  | { t: 'start'; id: string }
  | { t: 'restart'; id: string }
  | { t: 'remove'; id: string; removeWorktree?: boolean }
  | { t: 'rename'; id: string; name: string }
  | {
      t: 'set'
      id: string
      dangerousMode?: boolean
      model?: string | null
      provider?: 'openrouter' | 'custom' | null
      /** With `provider: 'custom'`. */
      customProviderId?: string
      /** The agent's quiet threshold in minutes (0 = off); null = back to the config's. */
      quietAfter?: number | null
    }
  | { t: 'snapshot'; id: string }
  | { t: 'cost'; since?: number }
  | { t: 'models'; query?: string }
  | { t: 'openrouter-key'; key: string | null }
  | { t: 'status' }
  /** Phone access: `on` starts it (and remembers), `pair` returns the links (they carry the token). */
  | {
      t: 'phone'
      action: 'status' | 'on' | 'off' | 'pair' | 'rotate'
      lan?: boolean
      port?: number
      /** `on`: through a Cloudflare tunnel too (false: back to local only). */
      online?: boolean
      /** `on --online`: the person's named tunnel instead of a quick one. */
      named?: boolean
      hostname?: string
      tunnelPort?: number
      /** Phones pair again after this many hours; null = never. */
      expireHours?: number | null
      /** `on --online`: re-check cloudflared against the latest release now. */
      refresh?: boolean
    }
  /**
   * Push to the phone through ntfy, from the dashboard's phone panel: `status` (with `reveal`, the
   * topic URL and the subscribe links too — only for that panel), `setup` (a new random topic, as
   * `nsq phone push ntfy` makes one), `test`, `off`.
   */
  | { t: 'push'; action: 'status' | 'setup' | 'test' | 'off'; reveal?: boolean }
  | { t: 'shutdown'; stopAgents?: boolean }
  /** Updates: the state, a check now, install now, or restart onto an installed one (when idle). */
  | { t: 'update'; action: 'status' | 'check' | 'install' | 'apply' }
  /**
   * A newer nsq connected (npx, a manual upgrade the updater does not know about): restart the
   * daemon on that copy once no agent is busy — `now` (U in the dashboard): at once.
   */
  | { t: 'handover'; node: string; script: string; version: string; now?: boolean }

export type RequestWithId = Request & { rid: number }

export type DaemonEvent =
  | { t: 'reply'; rid: number; ok: true; data?: unknown }
  | {
      t: 'reply'
      rid: number
      ok: false
      error: string
      /**
       * `unknown-request` (0.4.1+; the `error` stays "unknown request" for older clients): the
       * daemon does not know the request — it is older than the client. `daemonVersion` says which.
       */
      code?: 'unknown-request'
      daemonVersion?: string
    }
  | { t: 'agents'; agents: AgentView[] }
  | { t: 'agent'; agent: AgentView }
  | { t: 'removed'; id: string }
  /** Screen state to start from (serialized), then live `data`. */
  | { t: 'screen'; id: string; generation: number; cols: number; rows: number; data: string }
  | { t: 'data'; id: string; generation: number; data: string }
  | { t: 'resized'; id: string; cols: number; rows: number }
  | { t: 'exit'; id: string; generation: number }
  /** Phone access changed (turned on/off, a phone connected or left). Sent on subscribe too. */
  | { t: 'phones'; phone: PhoneView }
  /** The update state changed (sent on subscribe too). */
  | { t: 'update'; update: UpdateView }
  /** A status change that should notify (the TUI rings the terminal bell / OSC 9). */
  | {
      t: 'notify'
      id: string
      kind: 'needs-input' | 'finished' | 'quiet'
      title: string
      body: string
      /** No desktop notification could be shown: the client signals in its terminal. */
      ring: boolean
    }

/** Phone access as the dashboard shows it: on/off and who is connected. */
export interface PhoneView {
  running: boolean
  lan: boolean
  port?: number
  phones: {
    address: string
    device: string
    firstSeen: number
    lastSeen: number
    open: number
    /** Came in through the tunnel. */
    via?: 'internet'
  }[]
  /** The tunnel while online: state, the public https address (no token), an error. */
  online?: {
    state: 'off' | 'installing' | 'starting' | 'running' | 'error'
    mode?: 'quick' | 'named'
    url?: string
    error?: string
    progress?: number
  }
  /** Phones pair again after this many hours (the token is replaced). */
  expireHours?: number
  /** When the current pairing token was made. */
  tokenIssuedAt?: number
}

/** The ntfy push state, as the phone panel shows it. */
export interface PushView {
  on: boolean
  /** Where the settings come from: the keyring (`nsq phone push ntfy`, the panel) or NSQ_NTFY_URL. */
  source?: 'keyring' | 'env'
  /** The server's host (not secret). */
  host?: string
  hasToken?: boolean
  /** Only when asked with `reveal` (or right after `setup`): the topic and how to subscribe. */
  topic?: string
  topicUrl?: string
  /** What the ntfy Android app opens: `ntfy://<host>/<topic>`. */
  androidLink?: string
  /** The keyring could not be used (`setup` / `off` need it). */
  keyringMissing?: boolean
  /** The last push the daemon sent (a test or a needs-you). */
  last?: { at: number; ok: boolean; kind: 'test' | 'needs-you' | 'quiet'; error?: string }
}

/** Splits a stream into lines and parses each as JSON; a bad line is skipped. */
export class LineDecoder<T> {
  private buffer = ''
  constructor(private readonly onMessage: (message: T) => void) {}
  push(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim()) {
        try {
          this.onMessage(JSON.parse(line) as T)
        } catch {
          // a malformed line is dropped
        }
      }
      newline = this.buffer.indexOf('\n')
    }
    // Guard against a peer that never sends a newline.
    if (this.buffer.length > 64 * 1024 * 1024) this.buffer = ''
  }
}

export const encode = (message: unknown): string => `${JSON.stringify(message)}\n`
