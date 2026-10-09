// Claude Code's lifecycle hooks: which events an agent installs, what each
// payload means for the agent's status, and the per-agent `--settings` file
// that carries them. Pure except `writeClaudeSettings` (one file write).
//
// Each hook is a `curl` one-liner (or an `http` hook) that POSTs the hook's own
// stdin JSON to the agent's loopback endpoint (`/hook/<token>/<agentId>/<event>`).
// The file is merged by Claude Code over the user's own settings — their
// hooks keep working, and `~/.claude` is never written.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileIfChanged } from '../../util/writeIfChanged.js'
import type { AgentHookKind } from '../../status/types.js'

/** curl's `-m` on hook command lines, in seconds. */
export const HOOK_CURL_TIMEOUT_S = 2

/**
 * The command hooks worth a round trip. Not PreToolUse/PostToolUse as command
 * hooks: they fire on every tool call and would start a process each time.
 */
export const CLAUDE_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop'] as const

/** Claude Code's subagent lifecycle (SubagentStart since 2.0.43, SubagentStop since 1.0.41). */
export const CLAUDE_SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'] as const

/** PostToolUse, as an `http` hook: resumes an agent that was waiting on a permission prompt. */
export const CLAUDE_POST_TOOL_EVENT = 'PostToolUse'

/** The hook-endpoint event of Claude Code's PermissionRequest `http` hook. */
export const CLAUDE_PERMISSION_HOOK_EVENT = 'ClaudePermission'

/** Claude Code hook events whose payload names the session's transcript. */
export const CLAUDE_TRANSCRIPT_EVENTS: ReadonlySet<string> = new Set<string>([
  ...CLAUDE_EVENTS,
  ...CLAUDE_SUBAGENT_EVENTS,
  CLAUDE_POST_TOOL_EVENT,
  CLAUDE_PERMISSION_HOOK_EVENT
])

/** All events the hook route accepts for a Claude Code agent. */
export const CLAUDE_HOOK_EVENTS: ReadonlySet<string> = CLAUDE_TRANSCRIPT_EVENTS

/**
 * The `notification_type`s of the Notification hook that mean "blocked on the
 * user": a permission dialog (also plan approval and AskUserQuestion), an MCP
 * elicitation, a swarm worker's permission request. A whitelist: the same hook
 * also carries an idle nudge, login messages and other notices.
 */
export const BLOCKING_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'worker_permission_prompt'
])

/** Older builds send no notification type: their idle nudge is known by its wording. */
const IDLE_NOTIFICATION = /waiting for your input/i

/** Statuses of a Stop payload's `background_tasks` entry that mean it is over (2.1.145+). */
export const BACKGROUND_TASK_DONE: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
  'cancelled'
])

export function clip(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** "Subagent <type>: " before a question a subagent put (payload `agent_id`, 2.1.69+). */
export function claudeSubagentPrefix(payload: Record<string, unknown>): string {
  if (typeof payload.agent_id !== 'string' || !payload.agent_id) return ''
  const type = typeof payload.agent_type === 'string' ? clip(payload.agent_type, 40) : ''
  return type ? `Subagent ${type}: ` : 'Subagent: '
}

/** What a PermissionRequest payload asks for, in English like the harness's own wording. */
export function describeClaudePermission(payload: Record<string, unknown>): string {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  const input =
    payload.tool_input && typeof payload.tool_input === 'object'
      ? (payload.tool_input as Record<string, unknown>)
      : {}
  if (tool === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const first = input.questions[0] as { question?: unknown } | undefined
    if (typeof first?.question === 'string') return `Claude is asking: ${clip(first.question)}`
  }
  if (tool === 'ExitPlanMode') return 'Claude wants you to approve its plan'
  if (tool === 'Bash' && typeof input.command === 'string') {
    return `Claude wants to run: ${clip(input.command)}`
  }
  if (typeof input.file_path === 'string' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    return `Claude wants to edit ${clip(input.file_path)}`
  }
  return tool ? `Claude needs your permission to use ${tool}` : 'Claude needs your permission'
}

/** What one hook event means, or null when it means nothing for the status. */
export function classifyClaudeHook(
  event: string,
  payload: Record<string, unknown>
): { kind: AgentHookKind; detail?: string; resumeOnly?: boolean } | null {
  switch (event) {
    case 'UserPromptSubmit':
      return { kind: 'working' }
    case CLAUDE_POST_TOOL_EVENT:
      return { kind: 'working', resumeOnly: true }
    case 'Stop':
      return { kind: 'finished' }
    case 'Notification': {
      const type = typeof payload.notification_type === 'string' ? payload.notification_type : ''
      const message = typeof payload.message === 'string' ? payload.message : ''
      if (type && !BLOCKING_NOTIFICATIONS.has(type)) return null
      if (!type && IDLE_NOTIFICATION.test(message)) return null
      return { kind: 'needs-input', ...(message ? { detail: message } : {}) }
    }
    default:
      return null
  }
}

/** The answer to a PermissionRequest that approves it (dangerous mode). */
export const DANGEROUS_ALLOW_REPLY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' }
  }
})

/** The answer to a PermissionRequest that denies it. */
export function claudeDenyReply(message = 'Denied by the user'): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message }
    }
  })
}

/**
 * The PermissionRequest answer from the agent's current dangerous mode: allow
 * while it is on, "no opinion" (`{}` — Claude shows its own dialog) while off.
 * Deny rules and disabled tools never reach this hook, so they keep winning.
 */
export function claudePermissionReply(dangerousMode: boolean | undefined): string {
  return dangerousMode === true ? DANGEROUS_ALLOW_REPLY : '{}'
}

/**
 * The hook command line: `curl` posting its stdin to the URL in a per-agent,
 * per-event curl config file — the token never appears in any process's
 * argv. `curl.exe` on Windows (PowerShell aliases `curl` to
 * Invoke-WebRequest). Double quotes read the same in sh, PowerShell and cmd;
 * `-m` keeps a busy endpoint from ever holding the agent up.
 */
export function claudeHookCommand(
  curlConfigPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const curl = platform === 'win32' ? 'curl.exe' : 'curl'
  return `${curl} -s -m ${HOOK_CURL_TIMEOUT_S} -X POST --data-binary "@-" -K "${curlConfigPath.replaceAll('\\', '/')}"`
}

/** What goes in a hook's curl config file. */
export function claudeCurlConfig(url: string): string {
  return `url = "${url.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`
}

/**
 * Pure: the `--settings` document for one agent. `curlConfigs` names each
 * command hook's curl config file (see `writeClaudeSettings`).
 */
export function buildClaudeSettings(
  hookBase: string,
  curlConfigs: Readonly<Record<string, string>>,
  options: { platform?: NodeJS.Platform; statusLine?: Record<string, unknown> } = {}
): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {}
  for (const event of [...CLAUDE_EVENTS, ...CLAUDE_SUBAGENT_EVENTS]) {
    const config = curlConfigs[event]
    if (!config) continue
    hooks[event] = [
      { hooks: [{ type: 'command', command: claudeHookCommand(config, options.platform) }] }
    ]
  }
  // `http` hooks: the URL is read from this file by Claude Code itself, not
  // passed on any command line.
  hooks[CLAUDE_POST_TOOL_EVENT] = [
    {
      matcher: '*',
      hooks: [{ type: 'http', url: `${hookBase}/${CLAUDE_POST_TOOL_EVENT}`, timeout: 5 }]
    }
  ]
  hooks.PermissionRequest = [
    {
      matcher: '*',
      hooks: [{ type: 'http', url: `${hookBase}/${CLAUDE_PERMISSION_HOOK_EVENT}`, timeout: 10 }]
    }
  ]
  return { hooks, ...(options.statusLine ? { statusLine: options.statusLine } : {}) }
}

/**
 * Writes the agent's `--settings` file and its hooks' curl config files
 * (owner-only; rewritten on every launch — the port and token change with
 * every host run) and returns the settings path with forward slashes
 * (node-pty on Windows mangles backslashes in arguments).
 */
/**
 * Writes the agent's settings file. `env`: non-secret variables Claude Code must use whatever
 * the user's own settings.json `env` says (a provider recipe's routing — the settings layers'
 * `env` would otherwise override the process environment). Never a key.
 */
/** The variable a provider recipe's token reaches Claude Code's `apiKeyHelper` through. */
export const CLAUDE_TOKEN_ENV = 'NEUROSQUAD_CLAUDE_TOKEN'

/** The helper's script: prints the token from the environment (the file holds no secret). */
const TOKEN_HELPER = `process.stdout.write(process.env.${CLAUDE_TOKEN_ENV} || '')\n`

export function writeClaudeSettings(
  file: string,
  hookBase: string,
  env?: Readonly<Record<string, string>>
): string {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const stem = file.replace(/\.json$/i, '')
  const curlConfigs: Record<string, string> = {}
  for (const event of [...CLAUDE_EVENTS, ...CLAUDE_SUBAGENT_EVENTS]) {
    const config = `${stem}.${event}.curlrc`
    writeFileSync(config, claudeCurlConfig(`${hookBase}/${event}`), { mode: 0o600 })
    curlConfigs[event] = config
  }
  const settings = buildClaudeSettings(hookBase, curlConfigs)
  if (env && Object.keys(env).length > 0) {
    settings.env = { ...env }
    if (env['ANTHROPIC_AUTH_TOKEN'] === '') {
      // The recipe's token comes from `apiKeyHelper`, which reads it from the environment: an
      // ANTHROPIC_AUTH_TOKEN in the user's own settings `env` is blanked above and can never be
      // the credential sent to the provider. Double quotes read the same in sh, PowerShell, cmd.
      const helper = `${stem}.token.cjs`
      writeFileIfChanged(helper, TOKEN_HELPER)
      settings.apiKeyHelper = `node "${helper.replaceAll('\\', '/')}"`
    }
  }
  writeFileIfChanged(file, JSON.stringify(settings, null, 2))
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows: per-user profile ACLs apply
  }
  return file.replaceAll('\\', '/')
}
