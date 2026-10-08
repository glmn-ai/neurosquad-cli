// One entry point for every harness launch: the harness's own layer, then the
// model provider (OpenRouter or a native model id) on top.
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { shimModuleDirs } from '../pty/npmShim.js'
import { writeClaudeSettings } from './claude/hooks.js'
import { prepareCodexLaunch } from './codex/launch.js'
import {
  moveOpenCodeModelToConfig,
  pinnedModelEnv,
  prepareOpenCodeLaunch
} from './opencode/launch.js'
import { nativeModelLaunch, openRouterLaunch } from '../providers/openrouter.js'
import type { LaunchContext, LaunchPlan } from './types.js'

/** Claude Code's folder-trust prompt, answered: Down (off "No, exit") then Enter. */
export const CLAUDE_TRUST_PROMPT = { marker: 'Quick safety check', keys: '\x1b[B\r' }

/** What `claude --resume <id>` prints for a session it never saved. */
export const CLAUDE_SESSION_NOT_FOUND = 'No conversation found with session ID'

/**
 * npm's `claude.cmd` shim only starts the native `claude.exe` the package
 * ships; that exe is spawned directly (no cmd.exe in between).
 */
export function claudeExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32' || basename(command).toLowerCase() !== 'claude.cmd') return command
  const found = shimModuleDirs(command)
    .map((modules) => join(modules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
    .find((path) => existsSync(path))
  return found ? found.replaceAll('\\', '/') : command
}

export function prepareClaudeLaunch(ctx: LaunchContext): LaunchPlan {
  const settings = writeClaudeSettings(join(ctx.layerDir, `${ctx.agent.id}.json`), ctx.hookBase)
  return {
    command: claudeExecutable(ctx.executable, ctx.platform),
    args: [
      ...(ctx.resumed ? ['--resume', ctx.agent.id] : ['--session-id', ctx.agent.id]),
      '--settings',
      settings
    ],
    env: {},
    sessionNotFound: [CLAUDE_SESSION_NOT_FOUND],
    trustPrompt: CLAUDE_TRUST_PROMPT,
    useConptyDll: true
  }
}

/** A plain command: no hooks, the status comes from the terminal's output alone. */
export function prepareCommandLaunch(ctx: LaunchContext): LaunchPlan {
  const argv = ctx.agent.command ?? []
  return {
    command: ctx.executable,
    args: argv.slice(1),
    env: {},
    useConptyDll: false
  }
}

export interface PrepareOptions {
  /** OpenCode 2 or later (ask `openCodeVersionOf`). */
  openCodeV2?: boolean
}

/**
 * The whole launch of one agent. The OpenRouter recipe applies only with a
 * key (`ctx.openRouterKey`); without one the harness runs on its own login,
 * with the agent's native model if it has one.
 */
export function prepareLaunch(ctx: LaunchContext, options: PrepareOptions = {}): LaunchPlan {
  const { agent } = ctx
  let plan: LaunchPlan
  switch (agent.harness) {
    case 'claude-code':
      plan = prepareClaudeLaunch(ctx)
      break
    case 'codex-cli':
      plan = prepareCodexLaunch(ctx)
      break
    case 'opencode':
      plan = prepareOpenCodeLaunch(ctx, options.openCodeV2 === true)
      break
    default:
      return prepareCommandLaunch(ctx)
  }
  const provider =
    agent.provider === 'openrouter' && ctx.openRouterKey
      ? openRouterLaunch(agent.harness, ctx.openRouterKey, agent.model, {
          openCodeConfigContent: ctx.env?.['OPENCODE_CONFIG_CONTENT'],
          ...(ctx.openRouterApiBase ? { apiBase: ctx.openRouterApiBase } : {})
        })
      : agent.provider === 'openrouter'
        ? { args: [], env: {} }
        : nativeModelLaunch(agent.harness, agent.model)
  let args = [...plan.args, ...provider.args]
  let env = { ...plan.env, ...provider.env }
  if (agent.harness === 'opencode') {
    env = { ...env, ...pinnedModelEnv(args) }
    if (plan.openCodeV2) {
      const moved = moveOpenCodeModelToConfig(args, env, ctx.env?.['OPENCODE_CONFIG_CONTENT'])
      args = moved.args
      env = moved.env
    }
  }
  return { ...plan, args, env }
}
