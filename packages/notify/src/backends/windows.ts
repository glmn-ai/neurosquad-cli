// Windows: toasts through WinRT (Windows.UI.Notifications) and sounds through
// System.Media.SoundPlayer, both from one long-lived Windows PowerShell 5.1
// helper (assets/windows/toast-bridge.ps1) that ships with every Windows 10/11.
//
// Why a PowerShell bridge and not a native module: the maintained options are
// either a prebuilt binary we would have to ship and trust (SnoreToast via
// node-notifier, unmaintained since 2022) or a node-gyp/N-API addon (NodeRT,
// abandoned; @nodert-win10-*: need a compiler and a matching Windows SDK).
// PowerShell 5.1 is on every supported Windows, loads WinRT types directly,
// and starting it once keeps each toast to one line over a pipe.
//
// A toast's Tag (+ Group) is the notification id: showing again with the same
// tag replaces it in place, and ToastNotificationManager.History.Remove takes
// it down — exactly the "one toast per agent, withdrawn when it works again"
// rule of the desktop app.
import { win32 } from 'node:path'
import type { SpawnedProcess, System } from '../system.js'
import type { PreparedNotification, SoundBackend, ToastBackend } from './types.js'

export const TOAST_GROUP = 'nsq'

const READY_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_STARTS = 3
const PROBE_CACHE_MS = 15_000

/** Loads the script from the env var, so the execution policy and argv quoting never apply. */
const BOOTSTRAP =
  '& ([scriptblock]::Create([IO.File]::ReadAllText($env:NSQ_NOTIFY_BRIDGE, [Text.Encoding]::UTF8)))'

export interface BridgeReady {
  ok: boolean
  winrt?: boolean
  registered?: boolean
  setting?: string
  error?: string | null
}

export interface WindowsBridgeOptions {
  appId: string
  appName: string
  iconPath?: string
  register: boolean
  script: string
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Non-ASCII as \uXXXX: the pipe's code page can then never garble a title. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  )
}

export class WindowsBridge {
  private child: SpawnedProcess | undefined
  private ready: Promise<BridgeReady> | undefined
  private settleReady: ((value: BridgeReady) => void) | undefined
  private readonly pending = new Map<number, Pending>()
  private seq = 0
  private starts = 0
  private buffer = ''
  private disposed = false
  private lastError: string | undefined

  constructor(
    private readonly sys: System,
    private readonly options: WindowsBridgeOptions
  ) {}

  powershellPath(): string | undefined {
    const root = this.sys.env.SystemRoot ?? this.sys.env.SYSTEMROOT ?? this.sys.env.windir
    if (root) {
      const builtIn = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      if (this.sys.exists(builtIn)) return builtIn
    }
    return this.sys.which('powershell')
  }

  /** Starts the helper once (restarts after a crash, at most MAX_STARTS times). Never rejects. */
  start(): Promise<BridgeReady> {
    if (this.ready) return this.ready
    if (this.disposed) return Promise.resolve({ ok: false, error: 'disposed' })
    if (this.starts >= MAX_STARTS) {
      return Promise.resolve({
        ok: false,
        error: `helper stopped ${this.starts} times (${this.lastError ?? 'unknown'})`
      })
    }
    this.starts++
    this.buffer = ''
    const ready = new Promise<BridgeReady>((resolve) => {
      let settled = false
      const timer = setTimeout(
        () => finish({ ok: false, error: 'helper did not start in time' }),
        READY_TIMEOUT_MS
      )
      const finish = (value: BridgeReady) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.settleReady = undefined
        if (!value.ok) {
          this.lastError = value.error ?? undefined
          this.stopChild()
        }
        this.updateRef()
        resolve(value)
      }
      this.settleReady = finish
      const exe = this.powershellPath()
      if (!exe) return finish({ ok: false, error: 'powershell.exe not found' })
      let child: SpawnedProcess
      try {
        child = this.sys.spawn(
          exe,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', BOOTSTRAP],
          {
            env: {
              NSQ_NOTIFY_BRIDGE: this.options.script,
              NSQ_NOTIFY_APP_ID: this.options.appId,
              NSQ_NOTIFY_APP_NAME: this.options.appName,
              NSQ_NOTIFY_ICON: this.options.iconPath ?? '',
              NSQ_NOTIFY_REGISTER: this.options.register ? '1' : '0'
            }
          }
        )
      } catch (error) {
        return finish({ ok: false, error: `cannot start powershell.exe: ${String(error)}` })
      }
      this.child = child
      const stdout = child.stdout as
        (NodeJS.ReadableStream & { setEncoding?(e: string): void }) | null
      stdout?.setEncoding?.('utf8')
      stdout?.on('data', (chunk: string | Buffer) => this.onData(String(chunk)))
      // A pipe error (EPIPE after the helper died) must not become an
      // unhandled 'error' event in the caller's process; 'exit' follows.
      child.stdin?.on('error', () => {})
      stdout?.on('error', () => {})
      child.on('error', (error) => this.onExit(child, `helper error: ${error.message}`))
      child.on('exit', (code) => this.onExit(child, `helper exited (code ${code})`))
    })
    this.ready = ready
    this.updateRef()
    return ready
  }

  /** One request/answer over the pipe. Rejects on failure. */
  async request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ready = await this.start()
    if (!ready.ok) throw new Error(ready.error ?? 'helper unavailable')
    const child = this.child
    if (!child?.stdin) throw new Error('helper not running')
    const seq = ++this.seq
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        this.updateRef()
        reject(new Error(`helper did not answer "${String(message.op)}" in time`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(seq, { resolve, reject, timer })
    })
    this.updateRef()
    try {
      child.stdin.write(asciiJson({ ...message, seq }) + '\n')
    } catch (error) {
      this.failPending(seq, new Error(`cannot write to helper: ${String(error)}`))
    }
    const reply = await answer
    if (reply.ok !== true) throw new Error(String(reply.error ?? 'helper failed'))
    return reply
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const seq of [...this.pending.keys()]) this.failPending(seq, new Error('disposed'))
    this.settleReady?.({ ok: false, error: 'disposed' })
    this.stopChild()
    this.ready = undefined
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // PowerShell noise (a profile banner, a warning): not ours.
      }
      if (message.ready === true) {
        this.settleReady?.({
          ok: true,
          winrt: message.winrt === true,
          registered: message.registered === true,
          setting: typeof message.setting === 'string' ? message.setting : 'Unknown',
          error: typeof message.error === 'string' ? message.error : null
        })
        continue
      }
      const seq = typeof message.seq === 'number' ? message.seq : NaN
      const waiting = this.pending.get(seq)
      if (!waiting) continue
      clearTimeout(waiting.timer)
      this.pending.delete(seq)
      waiting.resolve(message)
      this.updateRef()
    }
  }

  private onExit(child: SpawnedProcess, reason: string): void {
    if (this.child !== child) return
    this.child = undefined
    this.ready = undefined
    this.lastError = reason
    this.settleReady?.({ ok: false, error: reason })
    for (const seq of [...this.pending.keys()]) this.failPending(seq, new Error(reason))
  }

  private failPending(seq: number, error: Error): void {
    const waiting = this.pending.get(seq)
    if (!waiting) return
    clearTimeout(waiting.timer)
    this.pending.delete(seq)
    waiting.reject(error)
    this.updateRef()
  }

  private stopChild(): void {
    const child = this.child
    this.child = undefined
    if (!child) return
    try {
      child.stdin?.end()
    } catch {}
    try {
      child.kill()
    } catch {}
  }

  /**
   * The helper must not keep the caller's process alive when idle (a CLI that
   * is done should exit), but must while a request is in flight.
   */
  private updateRef(): void {
    const child = this.child
    if (!child) return
    const busy = this.pending.size > 0 || this.settleReady !== undefined
    for (const handle of [child, child.stdin, child.stdout] as unknown[]) {
      const h = handle as { ref?: () => void; unref?: () => void } | null
      try {
        if (busy) h?.ref?.()
        else h?.unref?.()
      } catch {}
    }
  }
}

export class WindowsToastBackend implements ToastBackend {
  readonly name = 'windows-toast' as const
  readonly replaceable = true
  private probed: { at: number; value: string | null } | undefined

  constructor(
    private readonly bridge: WindowsBridge,
    private readonly iconUri?: string
  ) {}

  async probe(): Promise<string | null> {
    const now = Date.now()
    if (this.probed && now - this.probed.at < PROBE_CACHE_MS) return this.probed.value
    let value: string | null
    const ready = await this.bridge.start()
    if (!ready.ok) value = ready.error ?? 'helper unavailable'
    else if (!ready.winrt) value = ready.error ?? 'winrt-unavailable'
    else {
      // Re-read: the person may have switched notifications on or off since.
      let setting = ready.setting
      try {
        const reply = await this.bridge.request({ op: 'ping' })
        if (typeof reply.setting === 'string') setting = reply.setting
      } catch {}
      value = setting === 'Enabled' ? null : `toasts-disabled:${setting}`
    }
    this.probed = { at: now, value }
    return value
  }

  async show(n: PreparedNotification): Promise<void> {
    await this.bridge.request({
      op: 'show',
      tag: n.key,
      group: TOAST_GROUP,
      title: n.title,
      body: n.body,
      kind: n.kind,
      ...(this.iconUri ? { icon: this.iconUri } : {})
    })
  }

  async withdraw(key: string): Promise<void> {
    await this.bridge.request({ op: 'withdraw', tag: key, group: TOAST_GROUP })
  }

  async dispose(): Promise<void> {
    await this.bridge.dispose()
  }
}

export class WindowsSoundBackend implements SoundBackend {
  readonly name = 'SoundPlayer'

  constructor(private readonly bridge: WindowsBridge) {}

  async play(file: string): Promise<void> {
    await this.bridge.request({ op: 'sound', path: file })
  }

  async dispose(): Promise<void> {
    await this.bridge.dispose()
  }
}
