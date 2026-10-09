// nsq's updater: asks the npm registry for the newest release (only the package's public
// metadata, with an ETag; nothing about the user is sent), installs it the way this copy was
// installed (npm, Homebrew, Scoop), and checks the result. Applying it — restarting the daemon on
// the new code — is the daemon's job (see daemon.ts): it never stops a busy agent for it.
import { spawn } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  fstatSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { stripAnsi, writeFileAtomic } from '@neurosquad/core'
import type { NsqConfig } from '../config.js'
import { ensureDir } from '../paths.js'
import {
  detectInstall,
  installCommand,
  manualCommand,
  type InstallInfo,
  type InstallMethod,
  type InstallProbe
} from './install.js'
import { isDevVersion, isNewer, isPrerelease, isValidVersion, nodeSatisfies } from './semver.js'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** How often the registry is asked (the daemon checks at start when the last check is older). */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const LOG_LIMIT = 1024 * 1024

export type AutoMode = 'on' | 'notify' | 'off'

export type UpdateState =
  | 'off' // automatic checks are off (and nothing was checked by hand)
  | 'idle' // not checked yet
  | 'checking'
  | 'current' // up to date
  | 'available' // a newer release exists (installing next, or to install by hand)
  | 'installing'
  | 'installed' // on disk, waiting for the daemon to restart on it
  | 'waiting' // Homebrew / Scoop do not have the release yet
  | 'failed'
  | 'restarting'

/** The update as clients see it. */
export interface UpdateView {
  state: UpdateState
  /** The version of the running code (the daemon's). */
  current: string
  /** The newest release on the registry. */
  latest?: string
  /** A newer version installed on disk, applied when the daemon restarts. */
  installed?: string
  auto: AutoMode
  /** Why automatic updates are off. */
  offReason?: string
  method: InstallMethod
  manager: string
  canInstall: boolean
  /** What to run by hand. */
  command?: string
  /** Why it failed, waits, or cannot install. */
  reason?: string
  checkedAt?: number
  /** This daemon came up on a new version: from which, and when. */
  updatedFrom?: string
  updatedAt?: number
  /** What keeps the daemon from restarting on the installed version by itself. */
  blockers?: string[]
  /** A restart was asked for (U in the dashboard): it happens once nothing is busy. */
  scheduled?: boolean
}

interface Cache {
  checkedAt?: number
  etag?: string
  /** The registry's dist-tags and the newest release's engines.node. */
  tags?: Record<string, string>
  engines?: Record<string, string>
  failed?: { version: string; reason: string; at: number }
  /** Installed by nsq, not applied yet (the daemon restarts on it). */
  installed?: { version: string; from: string; at: number }
  /** The last version the daemon came up on after an update. */
  applied?: { version: string; from: string; at: number }
}

export interface UpdaterOptions {
  version: string
  name: string
  packageDir: string
  home: string
  config: () => NsqConfig
  log?: (line: string) => void
  onChange?: (view: UpdateView) => void
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  execPath?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Probe overrides (tests). */
  probe?: Partial<InstallProbe>
}

const truthy = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && !/^(0|false|no|off)$/i.test(value.trim())

/** Whether nsq checks and installs by itself, and if not, why. */
export function autoUpdateMode(input: {
  config: NsqConfig
  env: NodeJS.ProcessEnv
  version: string
  method: InstallMethod
}): { mode: AutoMode; reason?: string } {
  if (truthy(input.env['NSQ_NO_UPDATE'])) return { mode: 'off', reason: 'NSQ_NO_UPDATE is set' }
  if (input.config.autoUpdate === false) {
    return { mode: 'off', reason: 'turned off (nsq config set autoUpdate true turns it on)' }
  }
  if (truthy(input.env['CI'])) return { mode: 'off', reason: 'running in CI' }
  if (input.method === 'linked' || isDevVersion(input.version)) {
    return { mode: 'off', reason: 'a development build' }
  }
  if (input.config.autoUpdate === 'notify') return { mode: 'notify' }
  return { mode: 'on' }
}

/** The registry base: npm's, or NSQ_UPDATE_REGISTRY (http/https only). */
export function registryBase(env: NodeJS.ProcessEnv): string {
  const custom = env['NSQ_UPDATE_REGISTRY']?.trim()
  if (custom && /^https?:\/\/[^\s]+$/i.test(custom)) return custom.replace(/\/+$/, '')
  return DEFAULT_REGISTRY
}

export interface RegistryAnswer {
  notModified: boolean
  etag?: string
  tags?: Record<string, string>
  engines?: Record<string, string>
}

/**
 * The package's dist-tags (and each tagged release's engines.node) from the registry's abbreviated
 * metadata. Only standard headers go out: no cookies, tokens, ids or anything about this machine.
 */
export async function fetchRegistry(
  name: string,
  options: { registry: string; etag?: string; fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<RegistryAnswer> {
  const url = `${options.registry}/${name.replace('/', '%2f')}`
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: {
      accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
      ...(options.etag ? { 'if-none-match': options.etag } : {})
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS)
  })
  if (response.status === 304) return { notModified: true }
  if (!response.ok) throw new Error(`the registry answered ${response.status}`)
  const body = (await response.json()) as {
    'dist-tags'?: Record<string, unknown>
    versions?: Record<string, { engines?: { node?: unknown } }>
  }
  const tags: Record<string, string> = {}
  const engines: Record<string, string> = {}
  for (const [tag, version] of Object.entries(body['dist-tags'] ?? {})) {
    if (typeof version !== 'string' || !isValidVersion(version)) continue
    tags[tag] = version
    const node = body.versions?.[version]?.engines?.node
    if (typeof node === 'string') engines[version] = node
  }
  if (!tags['latest']) throw new Error('the registry sent no latest version')
  const etag = response.headers.get('etag') ?? undefined
  return { notModified: false, tags, engines, ...(etag ? { etag } : {}) }
}

/** The version in `<dir>/package.json`, or undefined. */
export function readPackageVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** The line of installer output that says what went wrong. */
export function failureReason(output: string, exitCode: number | null): string {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.some((line) => /EACCES|EPERM|permission denied/i.test(line))) {
    return 'permission denied'
  }
  const error =
    lines.find((line) => /npm (ERR!|error) (code|404|notarget)/i.test(line)) ??
    [...lines].reverse().find((line) => /error|failed|not found/i.test(line)) ??
    lines.at(-1)
  const text = (error ?? `the installer exited with code ${exitCode ?? '?'}`)
    .replace(/^npm (ERR!|error)\s*/i, '')
    .replace(/^Error:\s*/i, '')
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Reads the last `bytes` of a file (the installer's output for the failure reason). */
function tail(file: string, from: number, bytes = 16 * 1024): string {
  try {
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(from, size - bytes)
      const buffer = Buffer.alloc(Math.max(0, size - start))
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

export class Updater {
  readonly info: InstallInfo
  private readonly env: NodeJS.ProcessEnv
  private readonly probe: InstallProbe
  private readonly now: () => number
  private cache: Cache
  private state: UpdateState = 'idle'
  private reason: string | undefined
  private blockers: string[] = []
  private scheduled = false
  private updatedFrom: { version: string; at: number } | undefined
  private timer: ReturnType<typeof setInterval> | null = null
  private first: ReturnType<typeof setTimeout> | null = null
  private busy: Promise<UpdateView> | null = null
  /** The detached installer's pid, written into the lock: it may outlive this process. */
  private installerPid: number | undefined

  constructor(private readonly options: UpdaterOptions) {
    this.env = options.env ?? process.env
    this.now = options.now ?? Date.now
    this.probe = {
      platform: options.platform ?? process.platform,
      env: this.env,
      execPath: options.execPath ?? process.execPath,
      exists: (path) => existsSync(path),
      writable: (path) => {
        try {
          accessSync(path, constants.W_OK)
          return true
        } catch {
          return false
        }
      },
      realpath: (path) => realpathSync(path),
      ...options.probe
    }
    this.info = detectInstall(options.packageDir, options.name, this.probe)
    this.cache = this.readCache()
    if (this.mode().mode === 'off') this.state = 'off'
  }

  get version(): string {
    return this.options.version
  }

  private get cacheFile(): string {
    return join(this.options.home, 'update.json')
  }

  private get logFile(): string {
    return join(this.options.home, 'logs', 'update.log')
  }

  private get lockFile(): string {
    return join(this.options.home, 'update.lock')
  }

  private readCache(): Cache {
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Cache) : {}
    } catch {
      return {}
    }
  }

  private saveCache(): void {
    try {
      ensureDir(this.options.home)
      writeFileAtomic(this.cacheFile, `${JSON.stringify(this.cache, null, 2)}\n`)
    } catch (error) {
      this.log(`could not save ${this.cacheFile}: ${String(error)}`)
    }
  }

  private log(line: string): void {
    this.options.log?.(`update: ${line}`)
    try {
      ensureDir(dirname(this.logFile))
      try {
        if (statSync(this.logFile).size > LOG_LIMIT) rmSync(this.logFile, { force: true })
      } catch {
        // no log yet
      }
      writeFileSync(this.logFile, `${new Date(this.now()).toISOString()} ${line}\n`, { flag: 'a' })
    } catch {
      // logging never breaks the updater
    }
  }

  mode(): { mode: AutoMode; reason?: string } {
    return autoUpdateMode({
      config: this.options.config(),
      env: this.env,
      version: this.options.version,
      method: this.info.method
    })
  }

  /** The dist-tag this copy follows: `next` for a prerelease (when there is one), else `latest`. */
  latest(): string | undefined {
    const tags = this.cache.tags ?? {}
    const tagged =
      isPrerelease(this.options.version) &&
      tags['next'] &&
      isNewer(tags['next'], tags['latest'] ?? '0.0.0')
        ? tags['next']
        : tags['latest']
    return tagged && isValidVersion(tagged) ? tagged : undefined
  }

  private disk: { at: number; version: string | undefined } | null = null

  /** A newer version installed on disk (by nsq, or by hand) than the code that runs. */
  installedOnDisk(): string | undefined {
    // Asked on every status change: read package.json at most every two seconds.
    if (!this.disk || this.now() - this.disk.at > 2000 || this.state === 'installing') {
      this.disk = { at: this.now(), version: readPackageVersion(this.info.stableDir) }
    }
    const onDisk = this.disk.version
    return onDisk && isNewer(onDisk, this.options.version) ? onDisk : undefined
  }

  /** The node binary and script that start a daemon on the installed version. */
  successor(): { node: string; script: string } | null {
    const script = join(this.info.stableDir, 'dist', 'bin.js')
    if (!existsSync(script)) return null
    let node = this.probe.execPath
    // `brew upgrade` may upgrade node too: its opt/ link always points at the current one.
    if (this.info.method === 'homebrew' && this.info.root) {
      const brewNode = join(this.info.root, 'opt', 'node', 'bin', 'node')
      if (existsSync(brewNode)) node = brewNode
    }
    return existsSync(node) ? { node, script } : null
  }

  private set(state: UpdateState, reason?: string): void {
    this.state = state
    this.reason = reason
    this.options.onChange?.(this.view())
  }

  setBlockers(blockers: string[], scheduled = false): void {
    if (blockers.join('\n') === this.blockers.join('\n') && scheduled === this.scheduled) return
    this.blockers = blockers
    this.scheduled = scheduled
    this.options.onChange?.(this.view())
  }

  markRestarting(): void {
    this.set('restarting')
  }

  /**
   * Called once by a daemon at start: when it runs a version nsq installed, that is remembered
   * (the dashboard says "updated"), and npm's leftovers of the old version are cleaned up.
   */
  noteStarted(): void {
    const installed = this.cache.installed
    if (installed && installed.version === this.options.version) {
      this.cache.applied = { version: installed.version, from: installed.from, at: this.now() }
      delete this.cache.installed
      this.saveCache()
      this.log(`now running ${installed.version} (was ${installed.from})`)
    }
    const applied = this.cache.applied
    if (applied && applied.version === this.options.version) {
      this.updatedFrom = { version: applied.from, at: applied.at }
    }
    this.cleanupNpmLeftovers()
  }

  /**
   * npm moves the old package aside (`.neurosquad-XXXXXXXX`) and deletes it; on Windows the
   * delete fails while the old daemon still has its native addons loaded. Removed here, later.
   */
  cleanupNpmLeftovers(): void {
    if (this.info.method !== 'npm') return
    const parent = dirname(this.info.packageDir)
    const pattern = new RegExp(
      `^\\.${basename(this.info.packageDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[A-Za-z0-9]{8}$`
    )
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !pattern.test(entry.name)) continue
        try {
          rmSync(join(parent, entry.name), { recursive: true, force: true })
        } catch {
          // still in use: next time
        }
      }
    } catch {
      // not readable
    }
  }

  view(): UpdateView {
    const { mode, reason: offReason } = this.mode()
    const latest = this.latest()
    const installed = this.installedOnDisk()
    let state = this.state
    if (state === 'off' && mode !== 'off') state = 'idle'
    if (installed && !['installing', 'restarting', 'checking'].includes(state)) state = 'installed'
    const target = latest ?? installed
    return {
      state,
      current: this.options.version,
      ...(latest ? { latest } : {}),
      ...(installed ? { installed } : {}),
      auto: mode,
      ...(offReason ? { offReason } : {}),
      method: this.info.method,
      manager: this.info.manager,
      canInstall: this.info.canInstall,
      ...(target &&
      (state === 'available' || state === 'failed' || state === 'waiting' || !this.info.canInstall)
        ? { command: manualCommand(this.info, this.options.name, target) }
        : {}),
      ...((this.reason ?? (!this.info.canInstall ? this.info.reason : undefined))
        ? { reason: this.reason ?? this.info.reason }
        : {}),
      ...(this.cache.checkedAt ? { checkedAt: this.cache.checkedAt } : {}),
      ...(this.updatedFrom
        ? { updatedFrom: this.updatedFrom.version, updatedAt: this.updatedFrom.at }
        : {}),
      ...(state === 'installed' && this.blockers.length ? { blockers: this.blockers } : {}),
      ...(state === 'installed' && this.scheduled ? { scheduled: true } : {})
    }
  }

  /** The state from the cache alone, without asking the registry (for `nsq --version`). */
  cachedView(): UpdateView {
    const latest = this.latest()
    if ((this.state === 'idle' || this.state === 'off') && latest) {
      this.state = isNewer(latest, this.options.version) ? 'available' : 'current'
    }
    return this.view()
  }

  /** Asks the registry (unless the last answer is younger than the interval and not `force`). */
  check(force = false): Promise<UpdateView> {
    if (this.busy) return this.busy
    const run = this.checkNow(force).finally(() => {
      this.busy = null
    })
    this.busy = run
    return run
  }

  private async checkNow(force: boolean): Promise<UpdateView> {
    const fresh =
      this.cache.checkedAt !== undefined && this.now() - this.cache.checkedAt < CHECK_INTERVAL_MS
    if (!fresh || force) {
      this.set('checking')
      try {
        const answer = await fetchRegistry(this.options.name, {
          registry: registryBase(this.env),
          ...(this.cache.etag && this.cache.tags ? { etag: this.cache.etag } : {}),
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
        })
        if (!answer.notModified) {
          this.cache.tags = answer.tags
          this.cache.engines = answer.engines
          if (answer.etag) this.cache.etag = answer.etag
          else delete this.cache.etag
        }
        this.cache.checkedAt = this.now()
        this.saveCache()
      } catch (error) {
        // Offline, a proxy, the registry down: say nothing loud, try again next time.
        const message = error instanceof Error ? error.message : String(error)
        this.log(`check failed: ${message}`)
        if (!this.cache.tags || force) {
          this.set('failed', `could not reach the registry (${message})`)
          return this.view()
        }
      }
    }
    const latest = this.latest()
    if (latest && isNewer(latest, this.options.version) && !this.installedOnDisk()) {
      const engines = this.cache.engines?.[latest]
      if (!nodeSatisfies(engines, process.versions.node)) {
        this.set('available', `${latest} needs Node.js ${engines} (this is ${process.version})`)
      } else {
        this.set('available')
      }
    } else {
      this.set('current')
    }
    return this.view()
  }

  /** The automatic step after a check: install when on, possible, and not failed lately. */
  shouldAutoInstall(): boolean {
    const view = this.view()
    if (view.auto !== 'on' || view.state !== 'available' || !this.info.canInstall) return false
    if (this.reason) return false // e.g. needs a newer Node.js
    const failed = this.cache.failed
    return !(failed && failed.version === view.latest && this.now() - failed.at < CHECK_INTERVAL_MS)
  }

  /**
   * Installs the newest release the way nsq was installed. `foreground`: the installer's output
   * goes to `onOutput` too (`nsq update` in a terminal); otherwise it runs detached from the
   * daemon, into the update log, and survives the daemon stopping.
   */
  async install(
    options: { foreground?: boolean; onOutput?: (text: string) => void } = {}
  ): Promise<UpdateView> {
    if (this.busy) await this.busy.catch(() => undefined)
    const run = this.installNow(options).finally(() => {
      this.busy = null
    })
    this.busy = run
    return run
  }

  private async installNow(options: {
    foreground?: boolean
    onOutput?: (text: string) => void
  }): Promise<UpdateView> {
    const target = this.latest()
    if (!target || !isNewer(target, this.options.version)) return this.view()
    const onDisk = readPackageVersion(this.info.stableDir)
    if (onDisk && !isNewer(target, onDisk)) return this.view() // already installed
    const engines = this.cache.engines?.[target]
    if (!nodeSatisfies(engines, process.versions.node)) {
      this.set('available', `${target} needs Node.js ${engines} (this is ${process.version})`)
      return this.view()
    }
    const command = installCommand(this.info, this.options.name, target, this.probe)
    if (!command) {
      this.set(
        'available',
        this.info.reason ?? (this.info.method === 'npm' ? 'npm was not found' : undefined)
      )
      return this.view()
    }
    if (!this.takeLock()) {
      this.set('available', 'another nsq is installing it')
      return this.view()
    }
    this.set('installing')
    this.log(`installing ${target} (running ${this.options.version}): ${command.display}`)
    let exitCode: number | null = null
    let output = ''
    try {
      const result = await this.runInstaller(command, options)
      exitCode = result.code
      output = result.output
    } catch (error) {
      output = error instanceof Error ? error.message : String(error)
    } finally {
      this.releaseLock()
    }
    const after = readPackageVersion(this.info.stableDir)
    this.disk = { at: this.now(), version: after }
    if (after === target || (after && !isNewer(target, after))) {
      this.cache.installed = { version: after, from: this.options.version, at: this.now() }
      delete this.cache.failed
      this.saveCache()
      this.log(`installed ${after}`)
      this.set('installed')
      return this.view()
    }
    if (exitCode === 0 && (this.info.method === 'homebrew' || this.info.method === 'scoop')) {
      // The tap and the bucket follow npm with a delay (Homebrew: a day): try again later.
      const reason = `${target} is not in ${this.info.manager} yet`
      this.log(reason)
      this.set('waiting', reason)
      return this.view()
    }
    const reason =
      exitCode === 0
        ? `the installer finished but ${after ?? 'no version'} is installed, not ${target}`
        : failureReason(output, exitCode)
    this.cache.failed = { version: target, reason, at: this.now() }
    this.saveCache()
    this.log(`failed: ${reason}`)
    this.set('failed', reason)
    return this.view()
  }

  private takeLock(): boolean {
    ensureDir(this.options.home)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 })
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const pid = Number.parseInt(readFileSync(this.lockFile, 'utf8'), 10)
        let age = 0
        try {
          age = Date.now() - statSync(this.lockFile).mtimeMs
        } catch {
          age = 0
        }
        // A live pid holds it — unless the lock is older than any install may take (the pid
        // was reused by an unrelated process after a daemon was killed mid-install).
        if (Number.isFinite(pid) && pid > 0 && pidAlive(pid) && age < INSTALL_TIMEOUT_MS + 60_000) {
          return false
        }
        rmSync(this.lockFile, { force: true })
      }
    }
    return false
  }

  private releaseLock(): void {
    try {
      const holder = readFileSync(this.lockFile, 'utf8').trim()
      if (holder === String(process.pid) || holder === String(this.installerPid)) {
        rmSync(this.lockFile, { force: true })
      }
    } catch {
      // gone
    } finally {
      this.installerPid = undefined
    }
  }

  private installerEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env, ...extra }
    // Our own markers stay ours.
    for (const key of Object.keys(env)) {
      if (/^NSQ_(DAEMON|SUCCESSOR_OF)$/.test(key)) delete env[key]
    }
    return env
  }

  private runInstaller(
    command: { file: string; args: string[]; env?: Record<string, string> },
    options: { foreground?: boolean; onOutput?: (text: string) => void }
  ): Promise<{ code: number | null; output: string }> {
    ensureDir(dirname(this.logFile))
    const env = this.installerEnv(command.env)
    if (options.foreground) {
      return new Promise((resolve, reject) => {
        const child = spawn(command.file, command.args, {
          cwd: this.options.home,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let output = ''
        const take = (chunk: Buffer): void => {
          const text = chunk.toString('utf8')
          output = (output + text).slice(-64 * 1024)
          options.onOutput?.(text)
          try {
            writeFileSync(this.logFile, text, { flag: 'a' })
          } catch {
            // the log is best effort
          }
        }
        child.stdout.on('data', take)
        child.stderr.on('data', take)
        child.once('error', reject)
        child.once('close', (code) => resolve({ code, output }))
      })
    }
    // Detached, output straight into the log file: it runs on if the daemon stops meanwhile, and
    // is not part of any agent's terminal or process group.
    return new Promise((resolve, reject) => {
      let start = 0
      try {
        start = statSync(this.logFile).size
      } catch {
        start = 0
      }
      const fd = openSync(this.logFile, 'a')
      let child
      try {
        child = spawn(command.file, command.args, {
          cwd: this.options.home,
          env,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', fd, fd]
        })
      } catch (error) {
        closeSync(fd)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      closeSync(fd)
      // The installer outlives a daemon that stops meanwhile: the lock names it, so the next
      // daemon does not start a second install into the same folder while it runs.
      if (child.pid) {
        this.installerPid = child.pid
        try {
          writeFileSync(this.lockFile, String(child.pid), { mode: 0o600 })
        } catch {
          // best effort
        }
      }
      const timer = setTimeout(() => {
        this.log(`the installer took over ${INSTALL_TIMEOUT_MS / 60_000} minutes; stopping it`)
        try {
          child.kill()
        } catch {
          // gone
        }
      }, INSTALL_TIMEOUT_MS)
      timer.unref()
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve({ code, output: tail(this.logFile, start) })
      })
    })
  }

  /**
   * The daemon's schedule: a check shortly after start when the last one is older than the
   * interval, then every interval; a release found is installed when automatic updates are on.
   */
  start(afterCheck: (view: UpdateView) => void, startDelayMs = 10_000): void {
    this.stop()
    const tick = (): void => {
      if (this.mode().mode === 'off') {
        this.set('off')
        return
      }
      void this.check()
        .then(async (view) => {
          if (this.shouldAutoInstall()) view = await this.install()
          afterCheck(view)
        })
        .catch((error: unknown) => this.log(`automatic update failed: ${String(error)}`))
    }
    this.first = setTimeout(tick, startDelayMs)
    this.first.unref()
    this.timer = setInterval(tick, CHECK_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = null
    this.timer = null
  }
}
