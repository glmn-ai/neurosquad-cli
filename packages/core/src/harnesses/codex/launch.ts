// Everything a Codex CLI agent needs at launch (docs/harnesses.md, "Codex").
//
// Codex has no per-invocation settings file, but every config key can be set
// for one run with `-c key=value` — the "session flags" layer, merged over the
// user's ~/.codex/config.toml and never written to it. So an agent's setup is
// a list of `-c` flags plus a few env vars:
//
// - `hooks` — the lifecycle hooks with their trust records (./hooks.ts).
// - `projects.<cwd>.trust_level = "trusted"` — the folder-trust screen; the
//   user chose the folder when they started the agent there.
// - `tui.terminal_title = ["app-name", "thread-title"]`.
// - `tui.resume_cwd = "current"` — a resumed session stays in the agent's
//   folder or worktree.
// - OpenRouter attribution headers on each of the user's own model providers
//   whose base URL is OpenRouter's, and the `openrouter` provider defined
//   (not selected) on every launch so a session that ran on OpenRouter stays
//   resumable.
//
// On Windows the npm install's `codex.cmd` only runs a node script that spawns
// the real `codex.exe` — that exe is spawned directly (stopping the agent
// stops Codex, and the `-c` values need no cmd-safe spelling).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { gitEnv } from '../../git/worktree.js'
import { basename, join, resolve } from 'node:path'
import { shimModuleDirs } from '../../pty/npmShim.js'
import { codexOpenRouterProviderArgs, OPENROUTER_ATTRIBUTION } from '../../providers/openrouter.js'
import { codexHome, readCodexUserConfig } from './config.js'
import {
  CODEX_HOOK_EVENT,
  CODEX_SESSION_NOT_FOUND,
  codexCurlConfig,
  codexHookCommand,
  codexHooksTable,
  isCodexSessionId,
  toToml
} from './hooks.js'
import type { LaunchContext, LaunchPlan } from '../types.js'

export interface CodexConfigOptions {
  /** The hook command (codexHookCommand); none = no hooks (the cmd-shim fallback). */
  hookCommand?: string
  /**
   * Codex's keys for the agent's folder in `projects` (see `codexProjectKey`):
   * the folder and, inside a git repository, the repository root — Codex
   * applies trust at the repository root.
   */
  projectKeys?: readonly string[]
  /** Values with quotes, brackets and spaces can be passed (Codex spawned directly, or not Windows). */
  richArgs: boolean
  /** The user's own model providers that point at OpenRouter. */
  openRouterProviderIds: readonly string[]
  /** Define the `openrouter` provider (the user has none of that id). */
  defineOpenRouter?: boolean
  platform?: NodeJS.Platform
}

const flag = (setting: string): string[] => ['-c', setting]

/** Pure: the `-c` flags of one launch (see the header comment for each). */
export function buildCodexConfigArgs(options: CodexConfigOptions): string[] {
  const args = [...flag('tui.resume_cwd=current')]
  for (const id of options.openRouterProviderIds) {
    for (const [name, value] of Object.entries(OPENROUTER_ATTRIBUTION)) {
      args.push(...flag(`model_providers.${id}.http_headers.${name}=${value}`))
    }
  }
  if (options.defineOpenRouter) args.push(...codexOpenRouterProviderArgs())
  if (!options.richArgs) return args
  if (options.hookCommand) {
    args.push(...flag(`hooks=${toToml(codexHooksTable(options.hookCommand, options.platform))}`))
  }
  if (options.projectKeys?.length) {
    const projects = Object.fromEntries(
      options.projectKeys.map((key) => [key, { trust_level: 'trusted' }])
    )
    args.push(...flag(`projects=${toToml(projects)}`))
  }
  args.push(...flag('tui.terminal_title=["app-name","thread-title"]'))
  return args
}

/**
 * Pure: arguments before the `-c` flags. `resume <id>` of the session the
 * hooks last reported (an agent that never ran a turn has none and starts
 * fresh); dangerous mode is `--dangerously-bypass-approvals-and-sandbox`.
 */
export function codexLaunchArgs(
  agent: { harnessSessionId?: string; dangerousMode?: boolean },
  resumed: boolean
): string[] {
  return [
    ...(resumed && isCodexSessionId(agent.harnessSessionId)
      ? ['resume', agent.harnessSessionId]
      : []),
    ...(agent.dangerousMode === true ? ['--dangerously-bypass-approvals-and-sandbox'] : [])
  ]
}

/**
 * Codex's own key for a folder in `projects`: the canonical path, lower-cased
 * on Windows, with its native separators.
 */
export function codexProjectKey(cwd: string, platform = process.platform): string {
  let path = resolve(cwd)
  try {
    path = realpathSync.native(path)
  } catch {
    // Not there (yet) — the resolved path is Codex's own fallback too.
  }
  return platform === 'win32' ? path.replaceAll('/', '\\').toLowerCase() : path
}

/** The git repository root of `cwd`, or undefined outside a repository. */
function gitRootOf(cwd: string): string | undefined {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv()
    }).trim()
    return root || undefined
  } catch {
    return undefined
  }
}

const WINDOWS_TARGETS: Record<string, string> = {
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc'
}

export interface CodexExecutable {
  command: string
  /** The npm package root, when the exe came from behind npm's shim. */
  packageRoot?: string
  /** Spawned without cmd.exe in between. */
  direct: boolean
}

/**
 * The npm shim `codex.cmd` → `node_modules/@openai/codex/bin/codex.js` →
 * `@openai/codex-win32-<arch>/vendor/<target>/bin/codex.exe`. Anything else —
 * a standalone `codex.exe`, macOS/Linux — is used as it is.
 */
export function codexExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CodexExecutable {
  if (platform !== 'win32') return { command, direct: true }
  if (basename(command).toLowerCase() !== 'codex.cmd') {
    return { command, direct: !/\.(cmd|bat)$/i.test(command) }
  }
  const target = WINDOWS_TARGETS[arch]
  if (target) {
    const vendor = ['vendor', target, 'bin', 'codex.exe']
    const candidates = shimModuleDirs(command).flatMap((modules) => {
      const packageRoot = join(modules, '@openai', 'codex')
      return [
        {
          packageRoot,
          exe: join(packageRoot, 'node_modules', '@openai', `codex-win32-${arch}`, ...vendor)
        },
        { packageRoot, exe: join(modules, '@openai', `codex-win32-${arch}`, ...vendor) },
        { packageRoot, exe: join(packageRoot, ...vendor) }
      ]
    })
    const hit = candidates.find((candidate) => existsSync(candidate.exe))
    if (hit) {
      const found = hit.exe
      const packageRoot = hit.packageRoot
      let root = packageRoot
      try {
        root = realpathSync.native(packageRoot)
      } catch {
        // keep the lexical path
      }
      return { command: found.replaceAll('\\', '/'), packageRoot: root, direct: true }
    }
  }
  return { command, direct: false }
}

/**
 * Writes the agent's hook target (a curl config holding the per-agent hook
 * URL — no token in any argv) and returns the launch.
 */
export function prepareCodexLaunch(ctx: LaunchContext): LaunchPlan {
  const platform = ctx.platform ?? process.platform
  const executable = codexExecutable(ctx.executable, platform, ctx.arch)
  let hookCommand: string | undefined
  if (executable.direct) {
    mkdirSync(ctx.layerDir, { recursive: true })
    const curlConfig = join(ctx.layerDir, `${ctx.agent.id}.curlrc`)
    writeFileSync(curlConfig, codexCurlConfig(`${ctx.hookBase}/${CODEX_HOOK_EVENT}`), {
      mode: 0o600
    })
    hookCommand = codexHookCommand(curlConfig, platform)
  }
  const home = ctx.env?.['CODEX_HOME'] || codexHome()
  const userConfig = readCodexUserConfig(home)
  const args = [
    ...codexLaunchArgs(ctx.agent, ctx.resumed),
    ...buildCodexConfigArgs({
      hookCommand,
      projectKeys: [
        ...new Set(
          [ctx.cwd, gitRootOf(ctx.cwd)]
            .filter((path): path is string => Boolean(path))
            .map((path) => codexProjectKey(path, platform))
        )
      ],
      richArgs: executable.direct,
      openRouterProviderIds: userConfig.openRouterProviderIds,
      defineOpenRouter: !userConfig.providerIds.includes('openrouter'),
      platform
    })
  ]
  return {
    command: executable.command,
    args,
    env: {
      // What the npm launcher tells the exe, so its update notice still
      // offers the npm update.
      ...(executable.packageRoot
        ? { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: executable.packageRoot }
        : {})
    },
    sessionNotFound: CODEX_SESSION_NOT_FOUND,
    useConptyDll: true
  }
}
