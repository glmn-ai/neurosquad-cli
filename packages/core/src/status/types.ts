// What a harness lifecycle hook told the host about an agent, and the status
// the state machine (./machine.ts) publishes from it.
export type AgentHookKind = 'working' | 'needs-input' | 'finished'

/**
 * What the state machine publishes (./machine.ts): a hook's kind, or `idle`
 * — the agent is at its prompt with nothing new to say (the person dismissed
 * its question, interrupted it, or its process was restarted).
 */
export type AgentStatusKind = AgentHookKind | 'idle'

export interface AgentHookEvent {
  agentId: string
  kind: AgentStatusKind
  /**
   * Where the fact came from: the harness (`hook`, the default), the person's
   * own keystrokes in the agent (`user` — an answer or Escape typed into the
   * terminal, or the quiet after it), a fresh process clearing what its
   * predecessor last said (`reset`), or the harness's own transcript showing
   * what no hook said — an interrupt, an API error, a lost Stop, a dequeued
   * prompt (`transcript`, Claude Code — ./claudeReconciler.ts).
   */
  origin?: 'hook' | 'user' | 'reset' | 'transcript'
  /** A repeat with new wording: update what is shown, but no sound, toast or flag. */
  quiet?: boolean
  /**
   * A `finished` that an error ended (Claude Code: an API error — rate limit,
   * overloaded…). Rings like any turn end, but the host's prompt queue is not
   * drained into it.
   */
  error?: boolean
  /** Epoch ms, stamped in main so two windows agree on the order. */
  at: number
  /** The harness's own wording, when it gave one — e.g. which permission it wants. */
  detail?: string
}

/** A agent's current status as main's status machine has it (`window.api.agentHooks.snapshot`). */
export interface AgentStatusSnapshot {
  kind: AgentStatusKind
  /** When the status was established (epoch ms). */
  at: number
  detail?: string
  /** Subagents running inside the agent now (absent: none). */
  subagents?: SubagentInfo[]
}

/** One subagent running inside an agent (./subagents.ts). */
export interface SubagentInfo {
  /** The harness's own id for it (Claude's agent_id, OpenCode's child session…). */
  id: string
  /** Its type or name (`general-purpose`, `explore`…), when the harness says. */
  name?: string
  /** When it started (epoch ms). */
  since: number
}

/** `agent-subagents:event`: a agent's running subagents changed (the whole set). */
export interface AgentSubagentsEvent {
  agentId: string
  running: SubagentInfo[]
}
