// Env vars that mark *this very process* as itself running inside a Claude
// Code session — set by the parent Claude Code (or its IDE extension), never
// by the user. Confirmed with a real node-pty spawn: a spawned `claude` child
// that inherits these decides it's a *nested* child session and silently
// disables its own transcript persistence — which then makes `--resume` fail
// ("No conversation found with session ID: ..."). Stripped so every spawned
// agent gets a real, resumable session regardless of the shell NeuroSquad
// itself happened to be launched from (`npm run dev` during development, or a
// user who launches NeuroSquad from inside their own Claude Code terminal).
//
// An explicit list, NOT the whole `CLAUDE_CODE_*` namespace: that namespace is
// also Claude Code's *user configuration* — CLAUDE_CODE_GIT_BASH_PATH (without
// it Claude Code does not start on a Windows machine whose Git Bash is not on
// the default path), CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX, _MAX_OUTPUT_TOKENS,
// _DISABLE_* … — which every agent must keep. The names below are the ones a
// real `env | grep -i claude` inside a Claude Code session shows (plus the IDE
// extension's SSE port, which points a child at the parent's IDE connection).

const INHERITED_SESSION_ENV_KEYS: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN'
])

/** True for an env var the parent Claude Code session set (case-insensitive: Windows env). */
export function isInheritedSessionEnvKey(key: string): boolean {
  return INHERITED_SESSION_ENV_KEYS.has(key.toUpperCase())
}

/**
 * `env` (strings only) without the parent session's markers — for every
 * process we start besides the agents' own (which go through ptyManager's
 * cleanEnv): `rtk rewrite`, the user's status line command…
 */
export function withoutInheritedSession(
  env: Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isInheritedSessionEnvKey(key)) continue
    out[key] = value
  }
  return out
}
