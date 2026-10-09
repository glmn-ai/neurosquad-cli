// How this copy of nsq was installed, and how to update it the same way. Decided from where the
// package runs (its real path: Node resolves symlinks, so a Homebrew or Scoop install shows its
// versioned folder) plus a few file checks — no package manager is run to find out.
import { posix, win32 } from 'node:path'

export type InstallMethod =
  | 'npm' // npm install -g (or the install scripts, which use it)
  | 'homebrew'
  | 'scoop'
  | 'npx'
  | 'other' // another package manager (pnpm, yarn, bun, Volta): it updates nsq, not nsq itself
  | 'linked' // a development checkout or `npm link`
  | 'unknown'

export interface InstallInfo {
  method: InstallMethod
  /** Who manages the install, for messages ("npm", "Homebrew", "pnpm"…). */
  manager: string
  /** The package folder as it runs now. */
  packageDir: string
  /** Where the package is after an update (a stable path: Homebrew's opt/, Scoop's current/). */
  stableDir: string
  /** npm: the global prefix the package lives under. */
  prefix?: string
  /** Homebrew: its prefix; Scoop: its root. */
  root?: string
  /** nsq can run the update itself. */
  canInstall: boolean
  /** Why it cannot (shown with the command to run by hand). */
  reason?: string
}

export interface InstallProbe {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
  writable(path: string): boolean
  /** The node binary running nsq. */
  execPath: string
  realpath?(path: string): string
}

export const HOMEBREW_FORMULA = 'glmn-ai/neurosquad/neurosquad-cli'
export const SCOOP_APP = 'neurosquad-cli'

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** How `name`, running from `packageDir` (the folder of its package.json), was installed. */
export function detectInstall(packageDir: string, name: string, probe: InstallProbe): InstallInfo {
  const p = pathApi(probe.platform)
  const win = probe.platform === 'win32'
  const dir = p.resolve(packageDir)
  const slashed = dir.replaceAll('\\', '/')
  const test = win ? slashed.toLowerCase() : slashed
  const base = { packageDir: dir, stableDir: dir }
  const toNative = (path: string): string => (win ? path.replaceAll('/', '\\') : path)
  // Package folders below node_modules: `neurosquad`, or `@scope/name`.
  const depth = name.startsWith('@') ? 2 : 1

  // Scoop: <root>\apps\neurosquad-cli\<version> holds the package itself.
  const scoop = win ? /^(.*)\/apps\/neurosquad-cli\/[^/]+$/.exec(test) : null
  if (scoop) {
    const root = toNative(slashed.slice(0, scoop[1]!.length))
    const stableDir = p.join(root, 'apps', SCOOP_APP, 'current')
    const globalRoot = probe.env['SCOOP_GLOBAL']
    const isGlobal =
      (globalRoot !== undefined && p.resolve(globalRoot).toLowerCase() === root.toLowerCase()) ||
      /[\\/]programdata[\\/]scoop$/i.test(root)
    const script = p.join(root, 'apps', 'scoop', 'current', 'bin', 'scoop.ps1')
    const info = { ...base, method: 'scoop' as const, manager: 'Scoop', root, stableDir }
    if (isGlobal) {
      return { ...info, canInstall: false, reason: 'a global Scoop install needs an administrator' }
    }
    if (!probe.exists(script)) return { ...info, canInstall: false, reason: 'Scoop was not found' }
    return { ...info, canInstall: true }
  }

  // Homebrew: <prefix>/Cellar/neurosquad-cli/<version>/libexec/lib/node_modules/<name>
  // (or the same through opt/neurosquad-cli when the path was not resolved).
  const brew =
    /^(.*)\/(?:Cellar\/neurosquad-cli\/[^/]+|opt\/neurosquad-cli)\/libexec\/lib\/node_modules\//.exec(
      slashed
    )
  if (brew && !win) {
    const prefix = brew[1]!
    const stableDir = p.join(
      prefix,
      'opt',
      'neurosquad-cli',
      'libexec',
      'lib',
      'node_modules',
      ...name.split('/')
    )
    const info = {
      ...base,
      method: 'homebrew' as const,
      manager: 'Homebrew',
      root: prefix,
      stableDir
    }
    if (!probe.exists(p.join(prefix, 'bin', 'brew'))) {
      return { ...info, canInstall: false, reason: 'brew was not found' }
    }
    return { ...info, canInstall: true }
  }

  if (/\/_npx\//.test(test)) return { ...base, method: 'npx', manager: 'npx', canInstall: false }

  const others: [RegExp, string][] = [
    [/\/\.volta\//, 'Volta'],
    [/\/\.?pnpm\//, 'pnpm'],
    [/\/\.bun\//, 'bun'],
    [/\/yarn\/global\//, 'yarn']
  ]
  for (const [pattern, manager] of others) {
    if (pattern.test(test)) return { ...base, method: 'other', manager, canInstall: false }
  }

  if (!/\/node_modules\//.test(`${test}/`)) {
    return { ...base, method: 'linked', manager: 'a development checkout', canInstall: false }
  }

  // npm global: <prefix>/lib/node_modules/<name> with <prefix>/bin/nsq (macOS, Linux), or
  // <prefix>\node_modules\<name> with <prefix>\nsq.cmd (Windows). A project's own node_modules
  // keeps its commands in node_modules/.bin instead.
  let nodeModules = dir
  for (let i = 0; i < depth; i++) nodeModules = p.dirname(nodeModules)
  if (p.basename(nodeModules) === 'node_modules') {
    const parent = p.dirname(nodeModules)
    const prefix = win ? parent : p.basename(parent) === 'lib' ? p.dirname(parent) : undefined
    const bins = prefix
      ? win
        ? [p.join(prefix, 'nsq.cmd'), p.join(prefix, 'nsq')]
        : [p.join(prefix, 'bin', 'nsq')]
      : []
    if (prefix && bins.some((bin) => probe.exists(bin))) {
      const info = { ...base, method: 'npm' as const, manager: 'npm', prefix }
      const folders = win ? [nodeModules] : [nodeModules, p.join(prefix, 'bin')]
      const locked = folders.find((folder) => !probe.writable(folder))
      if (locked) return { ...info, canInstall: false, reason: `${locked} is not writable` }
      return { ...info, canInstall: true }
    }
  }
  return { ...base, method: 'unknown', manager: 'an unknown installer', canInstall: false }
}

/** What to run by hand to get `version` (also shown when nsq cannot install it itself). */
export function manualCommand(info: InstallInfo, name: string, version: string): string {
  const spec = `${name}@${version}`
  switch (info.method) {
    case 'npm':
      return info.reason
        ? `npm install -g ${spec}  (needs write access to ${info.prefix ?? 'the npm folder'})`
        : `npm install -g ${spec}`
    case 'homebrew':
      return `brew upgrade ${HOMEBREW_FORMULA}`
    case 'scoop':
      return info.reason?.includes('administrator')
        ? `scoop update ${SCOOP_APP} --global  (as administrator)`
        : `scoop update ${SCOOP_APP}`
    case 'npx':
      return `npx ${name}@latest`
    case 'other': {
      const commands: Record<string, string> = {
        Volta: `volta install ${spec}`,
        pnpm: `pnpm add -g ${spec}`,
        bun: `bun add -g ${spec}`,
        yarn: `yarn global add ${spec}`
      }
      return commands[info.manager] ?? `npm install -g ${spec}`
    }
    case 'linked':
      return 'git pull && npm run build  (a development checkout)'
    default:
      return `npm install -g ${spec}  (or the way you installed nsq)`
  }
}

/** npm's own CLI script, run with the node that runs nsq (no shell, no .cmd shim). */
export function findNpmCli(probe: InstallProbe): string | null {
  const p = pathApi(probe.platform)
  const override = probe.env['NSQ_UPDATE_NPM']
  if (override) return override
  const nodeDir = p.dirname(probe.execPath)
  const candidates =
    probe.platform === 'win32'
      ? [p.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [
          p.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          p.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        ]
  // npm on PATH: Windows' npm.cmd sits next to node_modules\npm; elsewhere `npm` links to the script.
  const pathValue = probe.env['PATH'] ?? probe.env['Path'] ?? ''
  for (const entry of pathValue.split(probe.platform === 'win32' ? ';' : ':')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    if (probe.platform === 'win32') {
      if (probe.exists(p.join(dir, 'npm.cmd'))) {
        candidates.push(p.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
      }
    } else if (probe.exists(p.join(dir, 'npm')) && probe.realpath) {
      try {
        candidates.push(probe.realpath(p.join(dir, 'npm')))
      } catch {
        // a dangling link
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate.endsWith('npm-cli.js') && probe.exists(candidate)) return p.normalize(candidate)
  }
  return null
}

export interface InstallCommand {
  file: string
  args: string[]
  env?: Record<string, string>
  /** For the log and `nsq update`: the command as a person would type it. */
  display: string
}

/** The command that installs `version` the way this copy was installed; null when nsq cannot. */
export function installCommand(
  info: InstallInfo,
  name: string,
  version: string,
  probe: InstallProbe
): InstallCommand | null {
  if (!info.canInstall) return null
  const p = pathApi(probe.platform)
  switch (info.method) {
    case 'npm': {
      const npmCli = findNpmCli(probe)
      if (!npmCli || !info.prefix) return null
      const spec = `${name}@${version}`
      return {
        file: probe.execPath,
        args: [
          npmCli,
          'install',
          '--global',
          '--prefix',
          info.prefix,
          '--no-audit',
          '--no-fund',
          '--no-update-notifier',
          spec
        ],
        display: `npm install -g --prefix ${info.prefix} ${spec}`
      }
    }
    case 'homebrew':
      return {
        file: p.join(info.root!, 'bin', 'brew'),
        args: ['upgrade', HOMEBREW_FORMULA],
        // Keep the old version's files until the next cleanup: the running daemon still uses them.
        env: {
          HOMEBREW_NO_INSTALL_CLEANUP: '1',
          HOMEBREW_NO_ENV_HINTS: '1',
          HOMEBREW_NO_EMOJI: '1'
        },
        display: `brew upgrade ${HOMEBREW_FORMULA}`
      }
    case 'scoop':
      return {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          p.join(info.root!, 'apps', 'scoop', 'current', 'bin', 'scoop.ps1'),
          'update',
          SCOOP_APP
        ],
        display: `scoop update ${SCOOP_APP}`
      }
    default:
      return null
  }
}
