// Where nsq keeps its state. One folder per user (`~/.neurosquad-cli`, or
// `NSQ_HOME`), separate from the desktop app's data. Every daemon is bound to
// its home: the IPC endpoint name is derived from it, so an isolated home
// (tests, a second profile) gets its own daemon.
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

export function nsqHome(): string {
  const override = process.env['NSQ_HOME']
  return resolve(override && override.trim() ? override : join(homedir(), '.neurosquad-cli'))
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
