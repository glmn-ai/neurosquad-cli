// One entry point for every harness launch: the harness's own layer, then the
// model provider (OpenRouter or a native model id) on top.
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { shimModuleDirs } from '../pty/npmShim.js'
import { CLAUDE_TOKEN_ENV, writeClaudeSettings } from './claude/hooks.js'
import { prepareCodexLaunch } from './codex/launch.js'
import {
  moveOpenCodeModelToConfig,
  pinnedModelEnv,
  prepareOpenCodeLaunch
} from './opencode/launch.js'
import { nativeModelLaunch, openRouterLaunch } from '../providers/openrouter.js'
import { customProviderLaunch } from '../providers/custom.js'
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

/**
 * A provider recipe's variables that Claude Code's settings layer must also carry: the user's
 * own settings.json `env` overrides the process environment, so a recipe left only in the
 * environment loses to an `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` or
 * `ANTHROPIC_AUTH_TOKEN` there. The token is blanked in the file and reaches Claude Code through
 * `apiKeyHelper` from the environment (`CLAUDE_TOKEN_ENV`) — never written to a file.
 */
export function claudeSettingsEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  if (env['ANTHROPIC_BASE_URL'] === undefined) return {}
  return { ...env, ANTHROPIC_AUTH_TOKEN: '' }
}

/** The recipe's environment for Claude Code: the token also where the helper reads it. */
function claudeRecipeEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const token = env['ANTHROPIC_AUTH_TOKEN']
  return env['ANTHROPIC_BASE_URL'] !== undefined && token
    ? { ...env, [CLAUDE_TOKEN_ENV]: token }
    : { ...env }
}

export function prepareClaudeLaunch(
  ctx: LaunchContext,
  settingsEnv?: Readonly<Record<string, string>>
): LaunchPlan {
  const settings = writeClaudeSettings(
    join(ctx.layerDir, `${ctx.agent.id}.json`),
    ctx.hookBase,
    settingsEnv
  )
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
 * with the agent's native model if it has one. A custom provider's recipe
 * applies with `ctx.customProvider` (its key is optional: local servers).
 */
export function prepareLaunch(ctx: LaunchContext, options: PrepareOptions = {}): LaunchPlan {
  const { agent } = ctx
  const custom = ctx.customProvider
  const provider =
    agent.provider === 'custom'
      ? // Without the provider (removed, or Codex without its gateway) nothing is applied: the
        // host refuses such a start before it gets here (customProviderLaunchProblem).
        custom && custom.provider.id === agent.customProviderId
        ? customProviderLaunch(agent.harness, custom.provider, custom.key, agent.model, {
            openCodeConfigContent: ctx.env?.['OPENCODE_CONFIG_CONTENT'],
            ...(custom.codexGateway ? { codexGateway: custom.codexGateway } : {})
          })
        : { args: [], env: {} }
      : agent.provider === 'openrouter' && ctx.openRouterKey
        ? openRouterLaunch(agent.harness, ctx.openRouterKey, agent.model, {
            openCodeConfigContent: ctx.env?.['OPENCODE_CONFIG_CONTENT'],
            ...(ctx.openRouterApiBase ? { apiBase: ctx.openRouterApiBase } : {})
          })
        : agent.provider === 'openrouter'
          ? { args: [], env: {} }
          : nativeModelLaunch(agent.harness, agent.model)
  let plan: LaunchPlan
  switch (agent.harness) {
    case 'claude-code':
      plan = prepareClaudeLaunch(ctx, claudeSettingsEnv(provider.env))
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
  let args = [...plan.args, ...provider.args]
  let env = {
    ...plan.env,
    ...(agent.harness === 'claude-code' ? claudeRecipeEnv(provider.env) : provider.env)
  }
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
