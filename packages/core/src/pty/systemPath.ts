// The PATH the machine has *now*, not the one this process was born with.
//
// A process inherits its environment once, at start, and never sees it
// change. Installers change it all the time: Claude Code's own
// `claude install` puts `%USERPROFILE%\.local\bin` on the user PATH in the
// registry and removes the old npm shim. The host — and the terminal a
// `npm run dev` was started from — keep the PATH from before, so `where
// claude` found nothing, the bare name went to node-pty, and every Claude
// agent failed with node-pty's "File not found:" (reported by the user right
// after updating; `claude` worked fine in a fresh terminal).
//
// So lookups and spawns use the inherited PATH *plus* whatever the registry
// (Windows) or the usual per-user install directories (macOS/Linux, where a
// GUI app's PATH is famously minimal) add on top. The inherited entries stay
// first: they are the session the user actually launched us from.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Registry reads are process spawns; a burst of lookups (ten harness probes at once) shares one. */
const CACHE_MS = 5000

let cached: { at: number; value: Promise<string> } | null = null

function inheritedPath(): string {
  // Windows keeps it as `Path`; `process.env` is case-insensitive there, but
  // be explicit rather than lean on that.
  return process.env['PATH'] ?? process.env['Path'] ?? ''
}

function expandWindowsVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const hit = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase())
    return hit ? (process.env[hit] ?? whole) : whole
  })
}

function readRegistryPath(key: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', key, '/v', 'Path'],
      { windowsHide: true, timeout: 4000 },
      (error, stdout) => {
        if (error) return resolve('')
        const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(stdout)
        resolve(match ? expandWindowsVars(match[1].trim()) : '')
      }
    )
  })
}

function merge(...lists: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const raw of list.split(delimiter)) {
      const entry = raw.trim()
      if (!entry) continue
      const key = process.platform === 'win32' ? entry.toLowerCase().replace(/[\\/]+$/, '') : entry
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }
  return out.join(delimiter)
}

const LOGIN_MARK = '__NEUROSQUAD_PATH__'

let loginShell: Promise<string> | null = null

/**
 * macOS/Linux: the PATH the user's own login shell builds. An app started
 * from Finder/Dock inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin` and
 * nothing else, so a CLI installed through nvm, volta, asdf, fnm, pnpm, a
 * custom npm prefix or `brew shellenv` in ~/.zprofile is invisible to it —
 * the fixed list below only covers the usual directories. Asked once per
 * app run (a login shell with a heavy rc can take a second), with a timeout;
 * a shell that fails or hangs just contributes nothing. The markers keep
 * whatever the rc files print out of the answer.
 */
function loginShellPath(): Promise<string> {
  if (loginShell) return loginShell
  const shell = process.env['SHELL'] || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  loginShell = new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${LOGIN_MARK}' "$PATH" '${LOGIN_MARK}'`],
      {
        timeout: 5000,
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' }
      },
      (_error, stdout) => {
        const parts = String(stdout ?? '').split(LOGIN_MARK)
        resolve(parts.length >= 3 ? parts[1].trim() : '')
      }
    )
  })
  return loginShell
}

async function compute(): Promise<string> {
  if (process.platform === 'win32') {
    const [machine, user] = await Promise.all([
      readRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
      readRegistryPath('HKCU\\Environment')
    ])
    return merge(inheritedPath(), machine, user)
  }
  const home = homedir()
  return merge(
    inheritedPath(),
    await loginShellPath(),
    [
      join(home, '.local', 'bin'),
      join(home, '.claude', 'local'),
      join(home, '.npm-global', 'bin'),
      join(home, '.bun', 'bin'),
      // Typical per-user installers whose PATH line lives in an rc file a
      // login shell may not read (e.g. only in ~/.zshrc): cargo, volta,
      // deno, pnpm, opencode's own install script, Python user scripts.
      join(home, '.cargo', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.deno', 'bin'),
      ...(process.platform === 'darwin'
        ? [join(home, 'Library', 'pnpm'), '/opt/homebrew/sbin']
        : [join(home, '.local', 'share', 'pnpm')]),
      join(home, '.opencode', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin'
    ].join(delimiter)
  )
}

/**
 * The inherited PATH plus everything installed since. Never rejects.
 * `fresh` skips the few-second cache — for the one retry a failed harness
 * lookup gets before a agent is told its CLI is not installed.
 */
export function currentPath(fresh = false): Promise<string> {
  const now = Date.now()
  if (fresh || !cached || now - cached.at > CACHE_MS) {
    cached = { at: now, value: compute().catch(() => inheritedPath()) }
  }
  return cached.value
}

/**
 * `env` with its PATH replaced by `path`. Every existing spelling of the key
 * is dropped first: on Windows a copied environment can carry `Path`, and a
 * second `PATH` next to it would leave which one the child sees to chance.
 */
export function withPath(env: Record<string, string>, path: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== 'path') next[key] = value
  }
  next[process.platform === 'win32' ? 'Path' : 'PATH'] = path
  return next
}

/** `process.env` (strings only) with the current PATH. */
export async function envWithCurrentPath(fresh = false): Promise<Record<string, string>> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value
  return withPath(base, await currentPath(fresh))
}
