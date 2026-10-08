// The operating system as the notifier sees it: environment, PATH lookup,
// running a short command, spawning a long-lived helper. One seam, so every
// backend is tested with the OS mocked out.
import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export interface RunResult {
  /** Exit code, or `null` when it could not start or was killed. */
  code: number | null
  stdout: string
  stderr: string
  /** Why it did not run to a clean exit (spawn error, timeout, non-zero exit). */
  error?: string
}

export interface RunOptions {
  timeoutMs?: number
  env?: Record<string, string | undefined>
}

/** The parts of a ChildProcess the backends use (a fake in tests). */
export interface SpawnedProcess {
  stdin: NodeJS.WritableStream | null
  stdout: NodeJS.ReadableStream | null
  pid?: number
  kill(signal?: NodeJS.Signals): boolean
  unref?(): void
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface System {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** Absolute path of an executable on PATH (plus `extraDirs`), or `undefined`. */
  which(name: string, extraDirs?: string[]): string | undefined
  /** Runs to completion. Never rejects. */
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>
  /** Starts a long-lived helper with piped stdio. May throw synchronously. */
  spawn(command: string, args: string[], options?: RunOptions): SpawnedProcess
  /** Whether a file exists (bundled assets, system binaries). */
  exists(path: string): boolean
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function createSystem(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): System {
  const cache = new Map<string, string | undefined>()
  const childEnv = (extra?: Record<string, string | undefined>) =>
    (extra ? { ...env, ...extra } : env) as NodeJS.ProcessEnv
  return {
    platform,
    env,
    exists: isFile,
    which(name, extraDirs = []) {
      const key = `${name}\0${extraDirs.join(delimiter)}`
      if (cache.has(key)) return cache.get(key)
      let found: string | undefined
      if (isAbsolute(name)) {
        found = isFile(name) ? name : undefined
      } else {
        const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter), ...extraDirs].filter(
          Boolean
        )
        const exts =
          platform === 'win32'
            ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
            : ['']
        outer: for (const dir of dirs) {
          for (const ext of exts) {
            const candidate = join(dir, name + ext)
            if (isFile(candidate)) {
              found = candidate
              break outer
            }
          }
        }
      }
      cache.set(key, found)
      return found
    },
    run(command, args, options = {}) {
      return new Promise((resolve) => {
        try {
          execFile(
            command,
            args,
            {
              windowsHide: true,
              timeout: options.timeoutMs ?? 10_000,
              maxBuffer: 256 * 1024,
              encoding: 'utf8',
              env: childEnv(options.env)
            },
            (error, stdout, stderr) => {
              const exit = (error as { code?: unknown } | null)?.code
              resolve({
                code: !error ? 0 : typeof exit === 'number' ? exit : null,
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? ''),
                ...(error ? { error: error.message } : {})
              })
            }
          )
        } catch (error) {
          resolve({ code: null, stdout: '', stderr: '', error: String(error) })
        }
      })
    },
    spawn(command, args, options = {}) {
      return spawn(command, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: childEnv(options.env)
      })
    }
  }
}
