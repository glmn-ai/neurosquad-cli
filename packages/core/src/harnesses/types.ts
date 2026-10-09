// The harnesses the core integrates, and the shape every harness launch takes.
//
// A launch is computed, not performed: `prepareLaunch` writes the agent's own
// config layer (a settings file, a plugin, a curl config) into a directory the
// host owns and returns the command line and environment. The host (the
// desktop app, the nsq daemon) spawns it. The user's own CLI configuration is
// never written: every harness gets its settings from a per-agent layer that
// the harness merges on top of the user's.

import type { CustomProvider } from '../providers/custom.js'

/** Harness ids, the same ones the desktop app stores. */
export type HarnessId = 'claude-code' | 'codex-cli' | 'opencode' | 'command'

export const AI_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex-cli', 'opencode']

export function isHarnessId(value: unknown): value is HarnessId {
  return value === 'command' || (AI_HARNESSES as readonly unknown[]).includes(value)
}

/** What a launch needs to know about the agent. */
export interface AgentLaunchSpec {
  /** A UUID. For Claude Code it is also the session id (`--session-id` / `--resume`). */
  id: string
  harness: HarnessId
  /** The harness's own session id when it picks its own (Codex, OpenCode). */
  harnessSessionId?: string
  /** Approve the harness's permission prompts (live for Claude Code, a launch flag elsewhere). */
  dangerousMode?: boolean
  /**
   * `openrouter` routes the harness through OpenRouter (needs a key);
   * `custom` through one of the user's own servers (`LaunchContext.customProvider`).
   */
  provider?: 'openrouter' | 'custom'
  /** `custom`: the id of the user's provider. */
  customProviderId?: string
  /**
   * Model id: an OpenRouter slug on the OpenRouter provider, an id from the
   * server's own list on a custom one, the harness's own id otherwise.
   */
  model?: string
  /** `command` harness: the argv to run. */
  command?: readonly string[]
}

export interface LaunchContext {
  agent: AgentLaunchSpec
  /** The resolved executable (absolute path) of the harness. */
  executable: string
  /** The working directory (the workspace folder or the agent's worktree). */
  cwd: string
  /** `http://127.0.0.1:<port>/hook/<token>/<agentId>` — the agent's hook endpoint. */
  hookBase: string
  /** A directory the host owns for this harness (per-agent files go inside). */
  layerDir: string
  /** Reopen the agent's previous session. */
  resumed: boolean
  /** The OpenRouter API key, when the agent is on OpenRouter and a key exists. Env only. */
  openRouterKey?: string
  /** Another OpenRouter-compatible API base (`…/api/v1`); the public API by default. */
  openRouterApiBase?: string
  /**
   * The agent's custom provider (`agent.provider === 'custom'`), its key (env
   * only) and, for Codex on a server without `/v1/responses`, the host's
   * Responses gateway for this agent.
   */
  customProvider?: {
    provider: CustomProvider
    key?: string
    codexGateway?: { baseUrl: string; key: string }
  }
  /** The environment the harness would inherit (for merging a user's own config variables). */
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  arch?: string
}

export interface LaunchPlan {
  command: string
  args: string[]
  /** Spread over the cleaned parent environment. Secrets live here only. */
  env: Record<string, string>
  /** Set when the launch chose the harness session id (OpenCode 2): the host records it. */
  sessionId?: string
  /** Printed by the harness when a resumed session does not exist: relaunch fresh. */
  sessionNotFound?: readonly string[]
  /** An interactive prompt shown on start that the host answers (folder trust). */
  trustPrompt?: { marker: string; keys: string }
  /** Spawn on the ConPTY dll node-pty ships (Windows). */
  useConptyDll: boolean
  /** OpenCode 2 launch path. */
  openCodeV2?: boolean
}

/**
 * Presses that interrupt a turn without closing the CLI, one write each (`sendPresses`):
 * OpenCode wants Escape twice, and both in one write read as a single key.
 */
export function interruptKeys(harness: HarnessId): readonly string[] {
  switch (harness) {
    case 'claude-code':
    case 'codex-cli':
      return ['\x1b']
    case 'opencode':
      return ['\x1b', '\x1b']
    default:
      return ['\x03']
  }
}
