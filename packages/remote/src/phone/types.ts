// The phone API's wire shapes, and the port the host (the nsq daemon) implements.
//
// The read and prompt shapes (`state`, `workspace`, `screen`, `prompt`, the SSE / long-poll
// events) match the NeuroSquad desktop's lightweight phone API field for field, so one phone
// client can speak to either. The `answer` and `interrupt` routes and `capabilities` are nsq's
// additions. The page in web/ is a client for exactly these routes.

export type PhoneAgentStatus = 'working' | 'needs-input' | 'finished' | 'idle' | 'exited'

export interface PhoneAgentSummary {
  id: string
  workspaceId: string
  name?: string
  /** The harness id (`claude-code`, `codex-cli`, `opencode`, `command`…). */
  harness: string
  /** Absent until the agent has reported anything at all. */
  status?: PhoneAgentStatus
  /** A process is behind this agent right now. */
  running: boolean
  /** Always true for nsq agents (the desktop also has cards without a terminal). */
  hasTerminal: boolean
  /** The pending question while `needs-input` ("Allow Bash: npm test?"), when the harness gave one. */
  detail?: string
}

export interface PhoneWorkspaceSummary {
  id: string
  name: string
  path: string
  cardCount: number
  workingCount: number
  needsInputCount: number
}

export interface PhoneState {
  workspaces: PhoneWorkspaceSummary[]
  agents: PhoneAgentSummary[]
  at: number
}

export interface PhoneWorkspaceDetail {
  workspace: PhoneWorkspaceSummary
  groups: never[]
  agents: PhoneAgentSummary[]
  /** No canvas in nsq; kept empty for clients written against the desktop's shape. */
  canvas: { nodes: never[]; edges: never[] }
}

export interface PhoneScreen {
  agentId: string
  /** Plain text of the agent's screen, oldest line first ('' when `styled` carries it). */
  screen: string
  running: boolean
  status?: PhoneAgentStatus
  /** Prompts waiting to be sent when the agent finishes. */
  queued: number
  /**
   * With `?format=styled` (nsq's page): the screen as styled runs — colours, attributes, the
   * cursor, wide characters. Absent when the host has none, or with `unchanged`.
   */
  styled?: PhoneStyledScreen
  /** `?since=<version>` matched: the screen is as the client last got it. */
  unchanged?: true
  /** The screen's version, for the next `?since=`. */
  version?: number
}

/**
 * A colour: `p0`…`p15`, one of the 16 theme colours (the page maps them to its palette), or
 * `#rrggbb` (the 256-colour cube and grays, truecolor). Absent = the terminal's default.
 */
export type PhoneScreenColor = string

export interface PhoneScreenStyle {
  fg?: PhoneScreenColor
  bg?: PhoneScreenColor
  bold?: true
  dim?: true
  italic?: true
  underline?: true
  inverse?: true
  strike?: true
  invisible?: true
}

/** Run flags (third element of a run). */
export const RUN_WIDE = 1
export const RUN_CURSOR = 2

/**
 * One run of cells with the same style: its text, the index of its style in `styles`, and
 * flags — `RUN_WIDE`: one wide character (two cells); `RUN_CURSOR`: the cursor is on it (one
 * cell, or one wide character).
 */
export type PhoneScreenRun =
  [text: string, style: number] | [text: string, style: number, flags: number]

export interface PhoneStyledScreen {
  /** The terminal's width in cells (the page fits it to the phone's width). */
  cols: number
  /** Oldest line first: scrollback, then the live screen (trailing blank lines dropped). */
  lines: PhoneScreenRun[][]
  /** Style 0 is the default (no colours, no attributes). */
  styles: PhoneScreenStyle[]
  /** The program switched to the alternate screen (a full-screen TUI: no scrollback). */
  alternate?: true
}

export type PhoneEvent =
  | { type: 'state'; state: PhoneState }
  | { type: 'status'; agentId: string; status: PhoneAgentStatus; at: number }
  | {
      type: 'attention'
      agentId: string
      agentName: string
      workspaceId: string
      workspaceName: string
      kind: 'finished' | 'needs-input'
      /** The harness's own wording, when it gave one. */
      detail?: string
      at: number
    }

/**
 * Who sent a request that acts on an agent: where it came from and the device label — never the
 * token or the address. `local`: this machine (loopback); `lan`: another device on the local
 * network; `internet`: through the online tunnel.
 */
export interface PhoneCaller {
  origin: 'local' | 'lan' | 'internet'
  /** A short label from the User-Agent ("iPhone · Safari"), as in the connections list. */
  device: string
}

/** The three answers a permission prompt takes; the host maps them to the harness's keys. */
export type PhoneAnswer = 'yes' | 'always' | 'no'

// ---- the host port ------------------------------------------------------

export interface PhoneHostAgent {
  id: string
  name: string
  harness: string
  /** The project directory the agent belongs to; agents are grouped into workspaces by it. */
  workspace: string
  status?: PhoneAgentStatus
  running: boolean
  detail?: string
  queued?: number
}

/** Host events; the server turns them into `status` / `attention` phone events. */
export type PhoneHostEvent =
  | { type: 'status'; agentId: string; status: PhoneAgentStatus; at?: number }
  | {
      type: 'attention'
      agentId: string
      kind: 'finished' | 'needs-input'
      detail?: string
      at?: number
    }
  /** Something about the agent list changed (added, removed, renamed): re-read it now. */
  | { type: 'agents-changed' }

export type PhoneHostErrorCode = 'not-found' | 'not-running' | 'busy' | 'unsupported' | 'refused'

/** A refusal the phone may see verbatim (its message must not carry secrets). */
export class PhoneHostError extends Error {
  constructor(
    readonly code: PhoneHostErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PhoneHostError'
  }
}

/**
 * What the phone server needs from the host. Every method may throw `PhoneHostError` for an
 * expected refusal; anything else is answered as a generic 500 without its message.
 */
export interface PhoneHost {
  listAgents(): PhoneHostAgent[] | Promise<PhoneHostAgent[]>
  /** The last `lines` lines of the agent's screen as plain text; null when nothing runs. */
  screen(agentId: string, lines: number): string | null | Promise<string | null>
  /**
   * The last `lines` lines with their styles, and the screen's version (bumped whenever its
   * contents may have changed); null when nothing runs. Optional: without it the page shows text.
   * `since` equal to the current version: only `{ version }` (nothing changed).
   */
  styledScreen?(
    agentId: string,
    lines: number,
    since?: number
  ):
    | { version: number; screen?: PhoneStyledScreen }
    | null
    | Promise<{ version: number; screen?: PhoneStyledScreen } | null>
  /** Paste the text and press Enter — the same path a programmatic prompt takes in the daemon. */
  submit(agentId: string, text: string): void | Promise<void>
  /** Answer the agent's pending permission prompt. `caller`: who answered (the host may log it). */
  answer(agentId: string, answer: PhoneAnswer, caller?: PhoneCaller): void | Promise<void>
  /** The harness's own interrupt key(s) — Escape for most, never a Ctrl+C that quits the CLI. */
  interrupt(agentId: string, caller?: PhoneCaller): void | Promise<void>
  subscribe(listener: (event: PhoneHostEvent) => void): () => void
}
