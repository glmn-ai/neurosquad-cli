// Where nsq keeps its state. One folder per user (`~/.neurosquad-cli`, or
// `NSQ_HOME`), separate from the desktop app's data. Every daemon is bound to
// its home: the IPC endpoint name is derived from it, so an isolated home
// (tests, a second profile) gets its own daemon.
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, posix, resolve, win32 } from 'node:path'

export function nsqHome(): string {
  const override = process.env['NSQ_HOME']
  return resolve(override && override.trim() ? override : join(homedir(), '.neurosquad-cli'))
}

/**
 * A path as shown to the person: the home folder as `~` (`~/project`, `~\project` on Windows),
 * like shells and the agents' own TUIs show it. Anything outside the home is left alone.
 */
export function tildePath(
  path: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  const windows = platform === 'win32'
  const isSeparator = (char: string): boolean => char === '/' || (windows && char === '\\')
  let base = home
  while (base.length > 1 && isSeparator(base.charAt(base.length - 1))) base = base.slice(0, -1)
  // A home of "/" (some service accounts) would turn every path into "~…": leave paths alone.
  if (base.length <= 1 || (windows && /^[a-z]:$/i.test(base))) return path
  const fold = (value: string): string =>
    windows ? value.toLowerCase().replaceAll('/', '\\') : value
  if (fold(path) === fold(base)) return '~'
  if (!fold(path).startsWith(fold(base)) || !isSeparator(path.charAt(base.length))) return path
  return `~${path.slice(base.length)}`
}

/** The reverse of `tildePath` for a folder the person typed: `~`, `~/x` (and `~\x`) → absolute. */
export function expandTilde(
  path: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  if (path === '~') return home
  const windows = platform === 'win32'
  if (path.startsWith('~/') || (windows && path.startsWith('~\\'))) {
    return (windows ? win32 : posix).join(home, path.slice(2))
  }
  return path
}

export function ensureDir(dir: string, mode = 0o700): string {
  mkdirSync(dir, { recursive: true, mode })
  return dir
}

export const paths = {
  home: (): string => nsqHome(),
  agents: (): string => join(nsqHome(), 'agents.json'),
  config: (): string => join(nsqHome(), 'config.json'),
  daemonState: (): string => join(nsqHome(), 'daemon.json'),
  daemonLog: (): string => join(nsqHome(), 'daemon.log'),
  layers: (harness: string): string => join(nsqHome(), 'layers', harness),
  worktrees: (): string => join(nsqHome(), 'worktrees'),
  models: (): string => join(nsqHome(), 'models'),
  secretsFile: (): string => join(nsqHome(), 'secrets.json'),
  cloud: (): string => join(nsqHome(), 'cloud.json'),
  /** The update check's cache and the last install's outcome. */
  update: (): string => join(nsqHome(), 'update.json'),
  updateLock: (): string => join(nsqHome(), 'update.lock'),
  logs: (): string => join(nsqHome(), 'logs'),
  updateLog: (): string => join(nsqHome(), 'logs', 'update.log')
}

/** The daemon's IPC endpoint: a named pipe on Windows, a Unix socket elsewhere. */
export function ipcPath(home = nsqHome()): string {
  const tag = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 12)
  if (process.platform === 'win32') {
    let user = 'user'
    try {
      user = userInfo().username.replace(/[^\w.-]/g, '_')
    } catch {
      // no user info: the hash keeps it unique enough
    }
    return `\\\\.\\pipe\\neurosquad-cli-${user}-${tag}`
  }
  // Unix socket paths are limited to ~104 bytes: keep it short.
  const runtime = process.env['XDG_RUNTIME_DIR']
  return runtime ? join(runtime, `nsq-${tag}.sock`) : join(home, 'nsq.sock')
}
