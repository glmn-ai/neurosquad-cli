// The daemon ⇄ client protocol: one JSON object per line over the daemon's
// local socket. Requests carry an `rid` and get exactly one `reply`; events
// are pushed to clients that subscribed.
import type { AgentStatusKind, HarnessId, SubagentInfo } from '@neurosquad/core'
import type { UpdateView } from './update/updater.js'

export type { UpdateView }

export const PROTOCOL_VERSION = 1

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
  | { t: 'shutdown'; stopAgents?: boolean }
  /** Updates: the state, a check now, install now, or restart onto an installed one (when idle). */
  | { t: 'update'; action: 'status' | 'check' | 'install' | 'apply' }

export type RequestWithId = Request & { rid: number }

export type DaemonEvent =
  | { t: 'reply'; rid: number; ok: true; data?: unknown }
  | { t: 'reply'; rid: number; ok: false; error: string }
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
      kind: 'needs-input' | 'finished'
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
