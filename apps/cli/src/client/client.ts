// A connection to the daemon: requests with replies, and pushed events.
// Starts the daemon on demand (detached, no console window), so `nsq` with
// no daemon running just works.
import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { openSync, readFileSync, closeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensureDir, ipcPath, paths } from '../paths.js'
import {
  LineDecoder,
  PROTOCOL_VERSION,
  encode,
  type DaemonEvent,
  type Request
} from '../protocol.js'
import type { DaemonState } from '../daemon/daemon.js'

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void }

export class DaemonClient {
  private rid = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: DaemonEvent) => void>()
  private closed = false
  private readonly closeListeners = new Set<() => void>()
  /** The daemon's version and pid, from its hello. */
  daemonVersion = ''
  daemonPid = 0

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    const decoder = new LineDecoder<DaemonEvent>((event) => this.dispatch(event))
    socket.on('data', (chunk: string) => decoder.push(chunk))
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      for (const pending of this.pending.values())
        pending.reject(new Error('the daemon closed the connection'))
      this.pending.clear()
      for (const listener of this.closeListeners) listener()
    })
  }

  static async open(
    clientName: string,
    options: { autostart?: boolean } = {}
  ): Promise<DaemonClient> {
    let state = readState()
    let socket = state ? await tryConnect(state.ipc) : null
    if (!socket) {
      if (options.autostart === false)
        throw new Error('the nsq daemon is not running (start it with `nsq up`)')
      await startDaemon()
      state = readState()
      socket = state ? await tryConnect(state.ipc) : null
      if (!socket || !state)
        throw new Error(`could not start the nsq daemon (see ${paths.daemonLog()})`)
    }
    const client = new DaemonClient(socket)
    const hello = await client.request<{ version?: string; pid?: number } | undefined>({
      t: 'hello',
      token: state!.token,
      version: PROTOCOL_VERSION,
      client: clientName
    })
    client.daemonVersion = String(hello?.version ?? state!.version ?? '')
    client.daemonPid = Number(hello?.pid ?? state!.pid ?? 0)
    return client
  }

  private dispatch(event: DaemonEvent): void {
    if (event.t === 'reply') {
      const pending = this.pending.get(event.rid)
      if (!pending) return
      this.pending.delete(event.rid)
      if (event.ok) pending.resolve(event.data)
      else pending.reject(new Error(event.error))
      return
    }
    for (const listener of this.listeners) listener(event)
  }

  request<T = unknown>(request: Request): Promise<T> {
    if (this.closed) return Promise.reject(new Error('not connected to the daemon'))
    const rid = ++this.rid
    return new Promise<T>((resolve, reject) => {
      this.pending.set(rid, { resolve: resolve as (data: unknown) => void, reject })
      this.socket.write(encode({ ...request, rid }))
    })
  }

  /** Fire and forget (keystrokes): no reply is awaited. */
  post(request: Request): void {
    if (this.closed) return
    const rid = ++this.rid
    this.pending.set(rid, { resolve: () => {}, reject: () => {} })
    this.socket.write(encode({ ...request, rid }))
  }

  on(listener: (event: DaemonEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The connection is gone. */
  get isClosed(): boolean {
    return this.closed
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener)
  }

  close(): void {
    this.socket.end()
  }
}

export function readState(): DaemonState | null {
  try {
    const state = JSON.parse(readFileSync(paths.daemonState(), 'utf8')) as DaemonState
    return state && typeof state.ipc === 'string' && typeof state.token === 'string' ? state : null
  } catch {
    return null
  }
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path)
    const fail = (): void => {
      socket.destroy()
      resolve(null)
    }
    socket.once('connect', () => {
      socket.off('error', fail)
      resolve(socket)
    })
    socket.once('error', fail)
  })
}

/** The script that runs the CLI (dist/bin.js). */
export function binScript(): string {
  return fileURLToPath(new URL('../bin.js', import.meta.url))
}

/**
 * Starts a daemon of this copy, detached. `successorOf`: it waits for that daemon (pid) to exit
 * first — a hand-over, where the old one still holds the lock.
 */
export function spawnDaemon(successorOf?: number): void {
  ensureDir(paths.home())
  const log = openSync(paths.daemonLog(), 'a')
  try {
    const child = spawn(process.execPath, [binScript(), 'daemon', '--foreground'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      cwd: paths.home(),
      env: {
        ...process.env,
        NSQ_DAEMON: '1',
        NSQ_SUCCESSOR_OF: successorOf ? String(successorOf) : undefined
      }
    })
    child.unref()
  } finally {
    closeSync(log)
  }
}

export async function startDaemon(): Promise<void> {
  spawnDaemon()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const state = readState()
    if (state) {
      const socket = await tryConnect(state.ipc)
      if (socket) {
        socket.destroy()
        return
      }
    }
  }
  throw new Error(`the nsq daemon did not start (see ${paths.daemonLog()})`)
}

export function daemonRunning(): Promise<boolean> {
  const state = readState()
  if (!state) return Promise.resolve(false)
  return tryConnect(state.ipc).then((socket) => {
    socket?.destroy()
    return socket !== null
  })
}

export { ipcPath }
