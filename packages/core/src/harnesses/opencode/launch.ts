// Everything an OpenCode agent needs at launch (docs/harnesses.md, "OpenCode").
//
// OpenCode merges extra config from the environment over the user's own:
// global config → `OPENCODE_CONFIG` (a file) → project config → `.opencode`
// dirs → `OPENCODE_CONFIG_CONTENT`. So a per-agent file named by
// `OPENCODE_CONFIG` is the agent's layer: merged on top, rewritten on every
// launch, `~/.config/opencode` untouched. `OPENCODE_CONFIG_CONTENT` carries
// the OpenRouter attribution of the OpenRouter recipe (../../providers).
//
// OpenCode 1.x (npm `opencode-ai`) and OpenCode 2 (npm `@opencode/cli`) take
// different launches: another plugin API, a background service the full-screen
// UI attaches to unless `--standalone`, no `--model` on the full-screen UI,
// session ids chosen by the caller. The version is asked from the binary
// (./version.ts).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { OPENROUTER_ATTRIBUTION } from '../../providers/openrouter.js'
import { isOpenCodeSessionId } from './hooks.js'
import {
  buildOpenCodePluginSource,
  OPENCODE_ATTRIBUTION_ENV,
  OPENCODE_HOOK_ENV,
  OPENCODE_LIVE_DANGER_ENV,
  OPENCODE_MODEL_ENV,
  OPENCODE_PLUGIN_FILE
} from './plugin.js'
import {
  buildOpenCodeV2PluginSource,
  OPENCODE_SESSION_ENV,
  OPENCODE_V2_PLUGIN_DIR,
  OPENCODE_V2_PLUGIN_PACKAGE
} from './pluginV2.js'
import { OPENCODE_FLAVOR } from './flavor.js'
import type { LaunchContext, LaunchPlan } from '../types.js'

/** The printed error of `--session <id>` for a session OpenCode no longer has. */
export const OPENCODE_SESSION_NOT_FOUND = 'Session not found:'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Deep merge, `top` wins on leaves; arrays of `plugin`/`instructions` are concatenated, as OpenCode does. */
export function mergeOpenCodeConfig(base: Json, top: Json): Json {
  const out: Json = { ...base }
  for (const [key, value] of Object.entries(top)) {
    const current = out[key]
    if ((key === 'plugin' || key === 'instructions') && Array.isArray(value)) {
      out[key] = [...new Set([...(Array.isArray(current) ? current : []), ...value])]
    } else {
      out[key] = isObject(value) && isObject(current) ? mergeOpenCodeConfig(current, value) : value
    }
  }
  return out
}

/** Minimal JSONC → JSON (comments and trailing commas), for a user's own OPENCODE_CONFIG file. */
export function parseJsonc(text: string): Json | null {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += char
  }
  try {
    const parsed: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Pure: the per-agent 1.x config document — the plugin, by file URL. */
export function buildOpenCodeConfig(pluginUrl: string): Json {
  return { $schema: OPENCODE_FLAVOR.schema, plugin: [pluginUrl] }
}

/** Pure: the per-agent 2.x config document — plugins are directories there. */
export function buildOpenCodeV2Config(pluginDir: string): Json {
  return { $schema: OPENCODE_FLAVOR.schema, plugins: [pluginDir] }
}

/**
 * Pure: 1.x launch arguments. `--session <id>` resumes the session the plugin
 * last reported; `--auto` is dangerous mode.
 */
export function openCodeLaunchArgs(
  agent: { harnessSessionId?: string; dangerousMode?: boolean },
  resumed: boolean
): string[] {
  return [
    ...(resumed && isOpenCodeSessionId(agent.harnessSessionId)
      ? ['--session', agent.harnessSessionId]
      : []),
    ...(agent.dangerousMode === true ? ['--auto'] : [])
  ]
}

/** A new session id for a 2.x agent (2.x takes the caller's; ids start with `ses`). */
export function newOpenCodeV2SessionId(): string {
  return `ses_ns${randomUUID().replaceAll('-', '')}`
}

/**
 * Pure: 2.x launch arguments. `--standalone`: the full-screen UI otherwise
 * attaches to a shared background service started with another environment —
 * this agent's config and plugin would not reach it.
 */
export function openCodeV2LaunchArgs(sessionId: string): string[] {
  return ['--standalone', '--session', sessionId]
}

/**
 * Pure, 2.x: `--model` is not an option of the full-screen UI, so the model
 * moves into the highest config layer, `OPENCODE_CONFIG_CONTENT`.
 */
export function moveOpenCodeModelToConfig(
  args: readonly string[],
  env: Record<string, string>,
  userContent: string | undefined
): { args: string[]; env: Record<string, string> } {
  const out: string[] = []
  let model: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '-m') {
      model = args[i + 1] ?? model
      i++
    } else out.push(args[i])
  }
  if (!model) return { args: out, env }
  const current = env['OPENCODE_CONFIG_CONTENT'] ?? userContent
  const base = (current && parseJsonc(current)) || {}
  return {
    args: out,
    env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(mergeOpenCodeConfig(base, { model })) }
  }
}

/** The value of the last `--model` among `args`, for the plugin's model pin. */
export function pinnedModelEnv(args: readonly string[]): Record<string, string> {
  const at = args.lastIndexOf('--model')
  const model = at >= 0 ? args[at + 1] : undefined
  return model && model.includes('/') ? { [OPENCODE_MODEL_ENV]: model } : {}
}

/**
 * The npm shim `opencode.cmd` only runs `node_modules/opencode-ai/bin/opencode.exe`
 * (1.x) or `node_modules/@opencode/cli/bin/opencode.exe` (2.x, a placeholder
 * when installed without scripts — the platform package's binary then).
 * Spawning the exe directly spares a `cmd.exe` in between.
 */
export function openCodeExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  if (platform !== 'win32' || basename(command).toLowerCase() !== 'opencode.cmd') {
    return command
  }
  const modules = join(dirname(command), 'node_modules')
  const direct = join(modules, 'opencode-ai', 'bin', 'opencode.exe')
  if (existsSync(direct)) return direct.replaceAll('\\', '/')
  const v2 = join(modules, '@opencode', 'cli')
  const platforms = [`cli-windows-${arch}`, `cli-windows-${arch}-baseline`]
  const real = [
    join(v2, 'bin', 'opencode.exe'),
    ...platforms.flatMap((name) => [
      join(v2, 'node_modules', '@opencode', name, 'bin', 'opencode.exe'),
      join(modules, '@opencode', name, 'bin', 'opencode.exe')
    ])
  ].find((path) => {
    try {
      return statSync(path).size > 1_000_000
    } catch {
      return false
    }
  })
  return real ? real.replaceAll('\\', '/') : command
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (readFileSync(file, 'utf-8') === content) return
  } catch {
    // Not there yet.
  }
  writeFileSync(file, content)
}

/** The user's own OPENCODE_CONFIG file merged underneath ours. */
function withUserConfig(config: Json, env: LaunchContext['env']): Json {
  const own = env?.['OPENCODE_CONFIG']
  if (own && existsSync(own)) {
    const parsed = parseJsonc(readFileSync(own, 'utf-8'))
    if (parsed) return mergeOpenCodeConfig(parsed, config)
  }
  return config
}

/**
 * Writes the plugin and this agent's config file and returns the launch.
 * `v2` picks the OpenCode 2 path. The provider recipe (OpenRouter or a native
 * model) is applied by the caller over `args`/`env`; on 2.x the caller runs
 * `moveOpenCodeModelToConfig` afterwards.
 */
export function prepareOpenCodeLaunch(ctx: LaunchContext, v2: boolean): LaunchPlan {
  mkdirSync(ctx.layerDir, { recursive: true })
  const command = openCodeExecutable(ctx.executable, ctx.platform, ctx.arch)
  const attribution = { [OPENCODE_ATTRIBUTION_ENV]: JSON.stringify(OPENROUTER_ATTRIBUTION) }
  const file = join(ctx.layerDir, `${ctx.agent.id}.json`)
  if (v2) {
    // Rewritten only when its content changed: 2.x reloads a plugin in every
    // running agent when its files are written.
    const pluginDir = join(ctx.layerDir, OPENCODE_V2_PLUGIN_DIR)
    mkdirSync(pluginDir, { recursive: true })
    writeIfChanged(join(pluginDir, 'package.json'), OPENCODE_V2_PLUGIN_PACKAGE)
    writeIfChanged(join(pluginDir, 'server.js'), buildOpenCodeV2PluginSource())
    writeFileSync(
      file,
      JSON.stringify(withUserConfig(buildOpenCodeV2Config(pluginDir), ctx.env), null, 2)
    )
    const sessionId =
      ctx.resumed && isOpenCodeSessionId(ctx.agent.harnessSessionId)
        ? ctx.agent.harnessSessionId
        : newOpenCodeV2SessionId()
    return {
      command,
      args: openCodeV2LaunchArgs(sessionId),
      env: {
        OPENCODE_CONFIG: file,
        [OPENCODE_HOOK_ENV]: ctx.hookBase,
        [OPENCODE_SESSION_ENV]: sessionId,
        // Dangerous mode answered live by the host per permission.
        [OPENCODE_LIVE_DANGER_ENV]: '1',
        ...attribution
      },
      sessionId,
      useConptyDll: true,
      openCodeV2: true
    }
  }
  const pluginPath = join(ctx.layerDir, OPENCODE_PLUGIN_FILE)
  writeIfChanged(pluginPath, buildOpenCodePluginSource())
  writeFileSync(
    file,
    JSON.stringify(
      withUserConfig(buildOpenCodeConfig(pathToFileURL(pluginPath).href), ctx.env),
      null,
      2
    )
  )
  return {
    command,
    args: openCodeLaunchArgs(ctx.agent, ctx.resumed),
    env: {
      // OpenCode exports OPENCODE_PURE to its children when started with
      // `--pure`; inherited, it would run the agent without the plugin.
      OPENCODE_PURE: 'false',
      OPENCODE_CONFIG: file,
      [OPENCODE_HOOK_ENV]: ctx.hookBase,
      ...attribution
    },
    sessionNotFound: [OPENCODE_SESSION_NOT_FOUND],
    useConptyDll: true
  }
}

/** The OpenCode 2 permission evaluation answer: allow while dangerous mode is on. */
export function openCodePermissionReply(dangerousMode: boolean | undefined): string {
  return dangerousMode === true ? JSON.stringify({ allow: true }) : '{}'
}
