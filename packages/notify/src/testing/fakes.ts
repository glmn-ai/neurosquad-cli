// Test doubles: an operating system whose commands are scripted, and a child
// process whose pipes the test drives.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { RunResult, SpawnedProcess, System } from '../system.js'

export interface RunCall {
  command: string
  args: string[]
}

export interface FakeSystemOptions {
  platform: NodeJS.Platform
  env?: Record<string, string | undefined>
  /** Executable name -> absolute path. */
  binaries?: Record<string, string>
  /** Absolute paths that exist. */
  files?: string[]
  /** Answers `run`; default: exit 0, no output. */
  respond?: (call: RunCall) => Partial<RunResult> | Promise<Partial<RunResult>>
  spawn?: (
    command: string,
    args: string[],
    env?: Record<string, string | undefined>
  ) => SpawnedProcess
}

export interface FakeSystem extends System {
  calls: RunCall[]
  spawns: { command: string; args: string[]; env?: Record<string, string | undefined> }[]
}

export function fakeSystem(options: FakeSystemOptions): FakeSystem {
  const calls: RunCall[] = []
  const spawns: FakeSystem['spawns'] = []
  return {
    platform: options.platform,
    env: options.env ?? {},
    calls,
    spawns,
    exists: (path) => (options.files ?? []).includes(path),
    which: (name) => options.binaries?.[name],
    async run(command, args) {
      const call = { command, args }
      calls.push(call)
      const answer = (await options.respond?.(call)) ?? {}
      return { code: 0, stdout: '', stderr: '', ...answer }
    },
    spawn(command, args, spawnOptions) {
      spawns.push({ command, args, ...(spawnOptions?.env ? { env: spawnOptions.env } : {}) })
      if (!options.spawn) throw new Error('spawn not scripted')
      return options.spawn(command, args, spawnOptions?.env)
    }
  }
}

/** A child process: read what was written to `stdin` (`lines`), answer with `reply`. */
export class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly lines: Record<string, unknown>[] = []
  killed = false
  private onLine: ((message: Record<string, unknown>) => void) | undefined
  private pendingText = ''

  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.pendingText += chunk
      let index: number
      while ((index = this.pendingText.indexOf('\n')) >= 0) {
        const raw = this.pendingText.slice(0, index)
        this.pendingText = this.pendingText.slice(index + 1)
        const message = JSON.parse(raw) as Record<string, unknown>
        this.lines.push(message)
        this.onLine?.(message)
      }
    })
  }

  /** Every request gets this answer (by default `{ ok: true }`). */
  autoReply(answer: (message: Record<string, unknown>) => Record<string, unknown> | null) {
    this.onLine = (message) => {
      const reply = answer(message)
      if (reply) this.reply({ seq: message.seq, ...reply })
    }
  }

  reply(message: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(message) + '\n')
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  exit(code: number | null): void {
    this.emit('exit', code)
  }
}
