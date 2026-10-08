// Codex CLI's lifecycle hooks, the way a Codex agent uses them
// (docs/harnesses.md). Pure — no stores, no I/O — so the mapping
// and the trust hashes are tested directly (codex.test.ts).
//
// Codex (0.153) runs Claude-style command hooks (codex-rs/hooks): each gets the
// event as JSON on stdin, in the shell of the session (PowerShell on Windows by
// default, cmd or bash if the user picked one). The host hands its hooks in as
// `-c hooks={…}` — the "session flags" config layer, so nothing is written to
// the user's ~/.codex — and they post their stdin to the same loopback hook
// endpoint Claude Code's hooks use (`/hook/<token>/<agentId>/Codex`).
//
// Hook trust. Codex only runs a non-managed hook whose trusted hash is on
// record (hooks/src/engine/discovery.rs), otherwise it opens a "review hooks"
// screen at startup that would block every agent. The record is read from the
// same session-flags layer (`hooks.state.<key>.trusted_hash`,
// hooks/src/config_rules.rs), so each launch vouches for exactly its own
// hooks: the hash is Codex's own `version_for_toml` of the normalized hook
// (config/src/fingerprint.rs — SHA-256 of the canonical, key-sorted JSON),
// reproduced below and checked against `codex app-server`'s `hooks/list`.
// `--dangerously-bypass-hook-trust` is deliberately NOT used: it would also run
// a repository's own untrusted `.codex/hooks.json`.
import { createHash } from 'node:crypto'
import type { AgentHookKind } from '../../status/types.js'

/** The hook endpoint's event segment for every Codex report (agentHooks.ts). */
export const CODEX_HOOK_EVENT = 'Codex'

interface CodexHookSpec {
  /** Event name as Codex's hooks config spells it. */
  event: string
  /** The same event in Codex's persisted hook-state keys (`hook_event_key_label`). */
  label: string
  /** Tool-name matcher, for the tool events. */
  matcher?: string
  /** Seconds. Interrupt hooks are capped at 3 s by Codex. */
  timeout: number
}

/**
 * The events a agent listens to. Not every tool call: `PreToolUse`/`PostToolUse`
 * without a matcher would start a shell for each command the agent runs — the
 * same trade-off Claude Code's hooks make (agentHooks.ts). They are used only
 * for `request_user_input`, Codex's "ask the user a question" tool.
 */
export const CODEX_HOOKS: readonly CodexHookSpec[] = [
  { event: 'UserPromptSubmit', label: 'user_prompt_submit', timeout: 10 },
  { event: 'Stop', label: 'stop', timeout: 10 },
  { event: 'PermissionRequest', label: 'permission_request', timeout: 10 },
  { event: 'Interrupt', label: 'interrupt', timeout: 3 },
  { event: 'PreToolUse', label: 'pre_tool_use', matcher: 'request_user_input', timeout: 10 },
  { event: 'PostToolUse', label: 'post_tool_use', matcher: 'request_user_input', timeout: 10 }
]

/**
 * The hook command: `curl` posting its stdin to the URL in a per-agent curl
 * config file. The file (not the command line) carries the port and the
 * per-agent token, so the command — and with it the trust hash — is stable
 * for a agent, and no token is visible in any process's argv. Double quotes are
 * the one quoting PowerShell, cmd and sh all read the same way (`@-` bare
 * would be PowerShell's splatting operator); verified in all three.
 */
export function codexHookCommand(curlConfigPath: string, platform = process.platform): string {
  const curl = platform === 'win32' ? 'curl.exe' : 'curl'
  return `${curl} -s -m 2 -X POST --data-binary "@-" -K "${curlConfigPath.replaceAll('\\', '/')}"`
}

/** What goes in the curl config file named by `codexHookCommand`. */
export function codexCurlConfig(url: string): string {
  return `url = "${url.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`
}

/**
 * Codex's key for a hook of the session-flags layer: `<source path>:<event>:0:0`,
 * the source path being a synthetic `<session-flags>/config.toml` resolved
 * against the filesystem root (discovery.rs `synthetic_layer_path`). Read back
 * from `hooks/list` on Windows: `C:\<session-flags>\config.toml:stop:0:0`.
 */
export function codexHookTrustKey(label: string, platform = process.platform): string {
  const source =
    platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml'
  return `${source}:${label}:0:0`
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: { [key: string]: Json } = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

function handlerOf(spec: CodexHookSpec, command: string): { [key: string]: Json } {
  return { type: 'command', command, timeout: spec.timeout, async: false }
}

/** Codex's trust hash for one of our hooks (fingerprint.rs `version_for_toml`). */
export function codexHookTrustHash(spec: CodexHookSpec, command: string): string {
  const identity: { [key: string]: Json } = {
    event_name: spec.label,
    ...(spec.matcher ? { matcher: spec.matcher } : {}),
    hooks: [handlerOf(spec, command)]
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(identity)))
    .digest('hex')}`
}

/** The whole `hooks` table for `-c hooks=…`: every event plus the trust record for each. */
export function codexHooksTable(command: string, platform = process.platform): Json {
  const table: { [key: string]: Json } = {}
  const state: { [key: string]: Json } = {}
  for (const spec of CODEX_HOOKS) {
    table[spec.event] = [
      { ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [handlerOf(spec, command)] }
    ]
    state[codexHookTrustKey(spec.label, platform)] = {
      trusted_hash: codexHookTrustHash(spec, command)
    }
  }
  table.state = state
  return table
}

/**
 * A TOML inline value. Strings and keys as TOML basic strings — JSON's string
 * syntax is a subset of them — so a Windows path or a quote in a command needs
 * no special casing.
 */
export function toToml(value: Json): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return '""'
  if (Array.isArray(value)) return `[${value.map(toToml).join(',')}]`
  return `{${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)}=${toToml(entry)}`)
    .join(',')}}`
}

/** Codex session (thread) ids are UUIDs (v7 in practice). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isCodexSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

export interface CodexHookFact {
  kind: AgentHookKind
  detail?: string
}

export interface CodexHookEffects {
  /** The root session the agent works in — becomes `Agent.harnessSessionId`. */
  sessionId?: string
  /** Its rollout file, as Codex named it. */
  transcriptPath?: string
  /** A turn opened (true) or closed (false). */
  turnOpen?: boolean
}

const MAX_DETAIL = 300

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** "Bash — rm -rf dist", "apply_patch — src/a.ts", "mcp__ns-connected__context7__query-docs". */
function permissionDetail(payload: Record<string, unknown>): string {
  const tool = str(payload.tool_name) ?? 'a tool'
  const input =
    payload.tool_input && typeof payload.tool_input === 'object'
      ? (payload.tool_input as Record<string, unknown>)
      : {}
  let what = str(input.command) ?? str(input.description)
  if (what && tool === 'apply_patch') {
    // A patch: the files it touches, not the whole diff.
    const files = [...what.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) =>
      match[1].trim()
    )
    what = files.length > 0 ? files.join(', ') : undefined
  }
  const agent = str(payload.agent_type)
  const text = `${tool}${what ? ` — ${what.replace(/\s+/g, ' ')}` : ''}${
    agent && str(payload.agent_id) ? ` (subagent ${agent})` : ''
  }`
  return text.slice(0, MAX_DETAIL)
}

/** The question `request_user_input` puts to the user. */
function questionDetail(payload: Record<string, unknown>): string | undefined {
  const input =
    payload.tool_input && typeof payload.tool_input === 'object'
      ? (payload.tool_input as Record<string, unknown>)
      : {}
  const questions = Array.isArray(input.questions) ? input.questions : []
  const first = questions[0] as Record<string, unknown> | undefined
  return (str(first?.question) ?? str(first?.header))?.slice(0, MAX_DETAIL)
}

/**
 * What one hook payload means for the agent. `autoReview`: the user routes
 * approvals to Codex's automatic reviewer (`approvals_reviewer = "auto_review"`),
 * whose decision Codex asks for right after the `PermissionRequest` hook —
 * nobody is asked, so it is not "waiting for you" (core/src/tools/approvals.rs).
 */
export function classifyCodexHook(
  payload: Record<string, unknown>,
  options: { autoReview?: boolean } = {}
): { fact: CodexHookFact | null; effects: CodexHookEffects } {
  const event = str(payload.hook_event_name) ?? ''
  const sessionId = isCodexSessionId(payload.session_id) ? payload.session_id : undefined
  const transcriptPath = str(payload.transcript_path)
  // A thread-spawned subagent reports with its own `agent_id`; the session id
  // is still the root's (hook_runtime.rs), but its turns are not the agent's.
  const subagent = str(payload.agent_id) !== undefined
  const where: CodexHookEffects = {
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {})
  }
  switch (event) {
    case 'UserPromptSubmit':
      if (subagent) return { fact: null, effects: {} }
      return { fact: { kind: 'working' }, effects: { ...where, turnOpen: true } }
    case 'Stop':
      // Root turns only — a subagent's end is `SubagentStop`, not subscribed.
      return { fact: { kind: 'finished' }, effects: { ...where, turnOpen: false } }
    case 'Interrupt':
      // Escape (or the budget brake) ended the turn; Codex runs no Stop then.
      return { fact: { kind: 'finished' }, effects: { ...where, turnOpen: false } }
    case 'PermissionRequest':
      // A subagent's approval is answered in the same agent, so it counts.
      if (options.autoReview) return { fact: null, effects: {} }
      return { fact: { kind: 'needs-input', detail: permissionDetail(payload) }, effects: {} }
    case 'PreToolUse': {
      if (str(payload.tool_name) !== 'request_user_input') return { fact: null, effects: {} }
      const detail = questionDetail(payload)
      return { fact: { kind: 'needs-input', ...(detail ? { detail } : {}) }, effects: {} }
    }
    case 'PostToolUse':
      // The question was answered: the turn goes on.
      return str(payload.tool_name) === 'request_user_input'
        ? { fact: { kind: 'working' }, effects: {} }
        : { fact: null, effects: {} }
    default:
      return { fact: null, effects: {} }
  }
}

/**
 * The line the TUI prints when a turn ends in an error (history_cell/notices.rs
 * `new_error_event`: "■ <message>"). Codex runs no Stop hook for a failed turn
 * (core/src/session/turn.rs returns before it), so while a turn is open this
 * is how the agent learns it is over. Also printed for "■ Conversation
 * interrupted", which the Interrupt hook already reports — harmless.
 */
export const CODEX_TURN_FAILED = /■ \S/

/**
 * What `codex resume <id>` prints before exiting 1 when it cannot reopen the
 * session: an id Codex does not know (tui/src/lib.rs `missing_session_exit`),
 * or one its state database still lists whose rollout file is gone ("Failed
 * to resume session from …: thread/resume failed during TUI bootstrap: …
 * no rollout found for thread id …" — seen live after deleting the file).
 */
export const CODEX_SESSION_NOT_FOUND = [
  'No saved session found',
  'no rollout found for thread'
] as const

/** The exit summary's resume line (tui/src/app/exit_summary.rs): "codex resume <thread id>". */
export const CODEX_EXIT_HINT =
  /codex resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
