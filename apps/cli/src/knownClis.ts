// `nsq run -- claude|codex|opencode …`: a known agent CLI named as a plain
// command runs as that harness — its hooks or plugin, its session tracked and
// resumed — with the extra arguments passed through. `nsq run --raw -- …`
// keeps it a plain command.
//
// The arguments are read the way each CLI's own parser reads them, so nsq
// finds what it manages itself: the first prompt (sent once, never again on a
// resume), the model and dangerous mode (nsq's own settings, so `m` and `d`
// keep working), and the session flags it cannot share (refused: nsq resumes
// the agent's session itself). A subcommand or flag that does not start an
// interactive session (`codex exec`, `claude --print`, `opencode run`,
// `--version`) runs as a plain command.
import { basename, resolve } from 'node:path'
import type { HarnessId } from '@neurosquad/core'
import type { RunSpec } from './protocol.js'

export interface KnownCliLaunch {
  harness: Exclude<HarnessId, 'command'>
  /** The arguments passed through on every start (resumes included). */
  args: string[]
  /** The first prompt (sent once). */
  prompt?: string
  model?: string
  dangerousMode?: boolean
  /** OpenCode's `[project]`: the folder to start in. */
  project?: string
}

export type Recognized =
  | { launch: KnownCliLaunch }
  /** A known CLI, but not an interactive session: run it as a plain command. */
  | { plain: string }
  /** A known CLI with arguments nsq cannot honour; the message says what to do. */
  | { refused: string }
  /** Not a known CLI. */
  | null

/** How each option reads its value: one token, one or more (until the next option), or optional. */
type Arity = 'one' | 'many' | 'optional'

interface CliRules {
  harness: KnownCliLaunch['harness']
  /** Options that take a value (every alias). Anything else starting with `-` is a switch. */
  values: Record<string, Arity>
  /** Subcommands (anything that is not the interactive session). */
  subcommands: ReadonlySet<string>
  /** Switches / options that make it a one-shot run (print, version, help). */
  oneShot: ReadonlySet<string>
  /** Session options nsq cannot share. */
  session: ReadonlySet<string>
  /** Options that would switch off what nsq's status comes from: why. */
  breaks: Record<string, string>
  model: ReadonlySet<string>
  dangerous: ReadonlySet<string>
  /** Where the first prompt is: the positional, or an option (OpenCode's `--prompt`). */
  prompt: { positional: true } | { option: ReadonlySet<string> }
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items)

// Claude Code 2.1 (`claude --help`; commander: a variadic option takes every value up to the
// next option, an optional one takes the next token unless it starts with `-`).
const CLAUDE: CliRules = {
  harness: 'claude-code',
  values: {
    '--add-dir': 'many',
    '--agent': 'one',
    '--agents': 'one',
    '--allowedTools': 'many',
    '--allowed-tools': 'many',
    '--append-system-prompt': 'one',
    '--append-system-prompt-file': 'one',
    '--autocompact': 'one',
    '--betas': 'many',
    '--cloud': 'optional',
    '-d': 'optional',
    '--debug': 'optional',
    '--debug-file': 'one',
    '--disallowedTools': 'many',
    '--disallowed-tools': 'many',
    '--effort': 'one',
    '--environment': 'one',
    '--fallback-model': 'one',
    '--file': 'many',
    '--from-pr': 'optional',
    '--input-format': 'one',
    '--json-schema': 'one',
    '--max-budget-usd': 'one',
    '--max-turns': 'one',
    '--mcp-config': 'many',
    '--model': 'one',
    '-n': 'one',
    '--name': 'one',
    '--output-format': 'one',
    '--permission-mode': 'one',
    '--permission-prompts': 'one',
    '--permission-prompt-tool': 'one',
    '--plugin-dir': 'one',
    '--plugin-url': 'one',
    '--prompt-suggestions': 'optional',
    '-r': 'optional',
    '--resume': 'optional',
    '--remote-control': 'optional',
    '--remote-control-session-name-prefix': 'one',
    '--session-id': 'one',
    '--setting-sources': 'one',
    '--settings': 'one',
    '--system-prompt': 'one',
    '--system-prompt-file': 'one',
    '--system-prompt-snapshot': 'one',
    '--teleport': 'optional',
    '--tools': 'many',
    '-w': 'optional',
    '--worktree': 'optional'
  },
  subcommands: set(
    'agents',
    'auth',
    'auto-mode',
    'config',
    'doctor',
    'install',
    'mcp',
    'migrate-installer',
    'plugin',
    'plugins',
    'setup-token',
    'update',
    'upgrade'
  ),
  oneShot: set(
    '-p',
    '--print',
    '-v',
    '--version',
    '-h',
    '--help',
    '--desktop',
    '--bg',
    '--background'
  ),
  session: set(
    '-c',
    '--continue',
    '-r',
    '--resume',
    '--session-id',
    '--fork-session',
    '--from-pr',
    '--teleport',
    '--cloud',
    '--no-session-persistence'
  ),
  breaks: {
    '--settings': "nsq passes Claude Code its own --settings (its hooks, nsq's status)",
    '--bare': "--bare turns off the hooks nsq's status comes from"
  },
  model: set('--model'),
  dangerous: set('--dangerously-skip-permissions'),
  prompt: { positional: true }
}

// Codex 0.16x (`codex --help`; clap: `-i/--image <FILE>...` takes values up to the next option).
const CODEX: CliRules = {
  harness: 'codex-cli',
  values: {
    '-c': 'one',
    '--config': 'one',
    '--enable': 'one',
    '--disable': 'one',
    '--remote': 'one',
    '--remote-auth-token-env': 'one',
    '-i': 'many',
    '--image': 'many',
    '-m': 'one',
    '--model': 'one',
    '--local-provider': 'one',
    '-p': 'one',
    '--profile': 'one',
    '-s': 'one',
    '--sandbox': 'one',
    '-C': 'one',
    '--cd': 'one',
    '--add-dir': 'one',
    '-a': 'one',
    '--ask-for-approval': 'one'
  },
  subcommands: set(
    'agents',
    'app',
    'app-server',
    'apply',
    'a',
    'archive',
    'cloud',
    'completion',
    'debug',
    'delete',
    'doctor',
    'e',
    'exec',
    'exec-server',
    'features',
    'help',
    'login',
    'logout',
    'mcp',
    'mcp-server',
    'migrate-rollouts',
    'plugin',
    'queue',
    'remote-control',
    'review',
    'sandbox',
    'unarchive',
    'update'
  ),
  oneShot: set('-h', '--help', '-V', '--version'),
  // Its sessions are subcommands; `--remote` talks to another app server's sessions.
  session: set('resume', 'fork', '--remote'),
  breaks: {},
  model: set('-m', '--model'),
  dangerous: set('--dangerously-bypass-approvals-and-sandbox', '--yolo'),
  prompt: { positional: true }
}

// OpenCode 1.x / 2.x (`opencode --help`; yargs: `[project]` is the folder to start in).
const OPENCODE: CliRules = {
  harness: 'opencode',
  values: {
    '--log-level': 'one',
    '--port': 'one',
    '--hostname': 'one',
    '--mdns-domain': 'one',
    '--cors': 'many',
    '-m': 'one',
    '--model': 'one',
    '-s': 'one',
    '--session': 'one',
    '--prompt': 'one',
    '--agent': 'one',
    '--replay-limit': 'one'
  },
  subcommands: set(
    'acp',
    'agent',
    'attach',
    'auth',
    'completion',
    'db',
    'debug',
    'export',
    'generate',
    'github',
    'import',
    'mcp',
    'models',
    'plug',
    'plugin',
    'pr',
    'providers',
    'run',
    'serve',
    'session',
    'stats',
    'uninstall',
    'upgrade',
    'web'
  ),
  oneShot: set('-h', '--help', '-v', '--version'),
  session: set('-c', '--continue', '-s', '--session', '--fork'),
  breaks: { '--pure': "--pure leaves out the plugin nsq's status comes from" },
  model: set('-m', '--model'),
  dangerous: set('--auto'),
  prompt: { option: set('--prompt') }
}

const BY_NAME: Record<string, CliRules> = { claude: CLAUDE, codex: CODEX, opencode: OPENCODE }

/** `claude`, `/usr/local/bin/codex`, `C:\…\opencode.cmd` → the CLI's rules. */
function rulesFor(argv0: string): CliRules | undefined {
  const name = basename(argv0.replaceAll('\\', '/'))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1|js|mjs)$/, '')
  return BY_NAME[name]
}

/** Whether `argv0` names a known agent CLI. */
export function isKnownCli(argv0: string): boolean {
  return rulesFor(argv0) !== undefined
}

const RAW_HINT = 'add --raw to run it as a plain command'

export function recognizeCli(argv: readonly string[]): Recognized {
  const [argv0, ...rest] = argv
  if (argv0 === undefined) return null
  const rules = rulesFor(argv0)
  if (!rules) return null
  const name = basename(argv0.replaceAll('\\', '/'))
  const args: string[] = []
  const positionals: string[] = []
  const found = (option: string): string =>
    `nsq keeps the agent's session itself (nsq restart resumes it): ${name} ${option} is not needed — or ${RAW_HINT}`
  let model: string | undefined
  let prompt: string | undefined
  let dangerousMode = false
  let afterDashes = false
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === '--' && !afterDashes) {
      afterDashes = true
      continue
    }
    if (afterDashes || token === '-' || !token.startsWith('-')) {
      // The first positional may be a subcommand (Codex: `resume`, `exec`; OpenCode: `run`…).
      if (positionals.length === 0 && !afterDashes) {
        if (rules.session.has(token)) return { refused: found(token) }
        if (rules.subcommands.has(token)) return { plain: `${name} ${token}` }
      }
      positionals.push(token)
      continue
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const option = eq >= 0 ? token.slice(0, eq) : token
    const arity = rules.values[option]
    // The option's value(s): `--opt=value`, the next token, or (many) every token up to the next option.
    const values: string[] = []
    if (eq >= 0) values.push(token.slice(eq + 1))
    else if (arity === 'one' && i + 1 < rest.length) values.push(rest[++i])
    else if (arity === 'optional' && i + 1 < rest.length && !rest[i + 1].startsWith('-'))
      values.push(rest[++i])
    else if (arity === 'many')
      while (i + 1 < rest.length && !rest[i + 1].startsWith('-')) values.push(rest[++i])
    if (rules.oneShot.has(option)) return { plain: `${name} ${option}` }
    if (rules.session.has(option)) return { refused: found(option) }
    const breaks = rules.breaks[option]
    if (breaks) return { refused: `${breaks}: drop ${option} — or ${RAW_HINT}` }
    if (rules.model.has(option)) {
      model = values[0]
      continue
    }
    if (rules.dangerous.has(option)) {
      dangerousMode = true
      continue
    }
    if ('option' in rules.prompt && rules.prompt.option.has(option)) {
      prompt = values[0]
      continue
    }
    args.push(eq >= 0 ? token : option, ...(eq >= 0 ? [] : values))
  }
  let project: string | undefined
  if ('positional' in rules.prompt) {
    if (positionals.length > 1) {
      return {
        refused: `${name} takes one prompt: quote it ("${positionals.join(' ')}") — or ${RAW_HINT}`
      }
    }
    prompt = positionals[0]
  } else if (positionals.length > 0) {
    if (positionals.length > 1)
      return { refused: `${name} takes one folder (${positionals.join(' ')}) — or ${RAW_HINT}` }
    project = positionals[0]
  }
  return {
    launch: {
      harness: rules.harness,
      args,
      ...(prompt?.trim() ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(dangerousMode ? { dangerousMode: true } : {}),
      ...(project ? { project } : {})
    }
  }
}

/** What `nsq run [flags] -- <command…>` runs. */
export type CommandRun =
  | { spec: RunSpec; note?: string }
  /** A usage error: the message. */
  | { error: string }

/**
 * `nsq run [--raw] [flags] -- <command…>`: a known agent CLI as its harness (unless `raw`),
 * anything else as a plain command. `base` carries nsq's own flags (`--model`, `--dangerous`,
 * `--provider`…); the CLI's own model flag must not contradict nsq's.
 */
export function commandRun(
  argv: readonly string[],
  base: Omit<RunSpec, 'harness' | 'command'>,
  raw: boolean
): CommandRun {
  const plain = (note?: string): CommandRun => ({
    spec: { ...withoutHarnessOnly(base), harness: 'command', command: [...argv] },
    ...(note ? { note } : {})
  })
  if (raw) return plain()
  const recognized = recognizeCli(argv)
  if (!recognized) return plain()
  if ('refused' in recognized) return { error: recognized.refused }
  if ('plain' in recognized)
    return plain(`${recognized.plain} is not an interactive session: running it as a plain command`)
  const { launch } = recognized
  if (launch.model && base.model && launch.model !== base.model)
    return { error: `two models: --model ${base.model} and ${launch.model} — give one` }
  const argv0 = argv[0]!
  const binary = /[\\/]/.test(argv0) ? resolve(base.cwd, argv0) : undefined
  return {
    spec: {
      ...base,
      harness: launch.harness,
      ...(launch.project ? { cwd: resolve(base.cwd, launch.project) } : {}),
      ...(launch.prompt ? { prompt: launch.prompt } : {}),
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.dangerousMode ? { dangerousMode: true } : {}),
      ...(launch.args.length ? { args: launch.args } : {}),
      ...(binary ? { binary } : {})
    }
  }
}

/** A plain command runs as before: nsq's provider flag is for harnesses only. */
function withoutHarnessOnly(
  base: Omit<RunSpec, 'harness' | 'command'>
): Omit<RunSpec, 'harness' | 'command'> {
  const rest = { ...base }
  delete rest.provider
  delete rest.customProviderId
  return rest
}
