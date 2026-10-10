// Two daemons started at the same moment on one nsq home: exactly one keeps running.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'nsq.js')
const built = existsSync(resolve(BIN, '..', '..', 'dist', 'bin.js'))
const home = mkdtempSync(join(tmpdir(), 'nsq-lock-home-'))
const env = { ...process.env, NSQ_HOME: home, NSQ_NO_NOTIFY: '1' }

// Every daemon this file starts: cleanup waits for all of them to be gone before deleting the
// home — on Windows a file a live process still holds cannot be removed (EPERM/EBUSY).
const children: ChildProcess[] = []

function startDaemon(): ChildProcess {
  const child = spawn(process.execPath, [BIN, 'daemon', '--foreground'], {
    env,
    stdio: 'ignore',
    windowsHide: true
  })
  children.push(child)
  return child
}

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
  })
}

afterAll(async () => {
  spawnSync(process.execPath, [BIN, 'down'], { env, timeout: 30_000, windowsHide: true })
  for (const child of children) {
    if (await exited(child, 10_000)) continue
    child.kill()
    await exited(child, 5_000)
  }
  // Antivirus and the indexer may still hold a just-closed file for a moment on Windows.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}, 60_000)

async function race(count: number): Promise<{ codes: (number | null)[]; winner?: number }> {
  const starts = Array.from({ length: count }, startDaemon)
  const codes = await Promise.all(
    starts.map(
      (child) =>
        new Promise<number | null>((done) => {
          child.on('exit', (code) => done(code))
          setTimeout(() => done(null), 15_000)
        })
    )
  )
  return { codes, winner: starts.find((child) => child.exitCode === null)?.pid }
}

describe.skipIf(!built)('daemon lock', () => {
  it('takes over a stale lock once, even when several start together', async () => {
    // The lock of a daemon that died: a pid that no longer runs.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    writeFileSync(join(home, 'daemon.lock'), String(dead))
    const { codes, winner } = await race(4)
    expect(codes.filter((code) => code === null)).toHaveLength(1)
    expect(codes.filter((code) => code === 0)).toHaveLength(3)
    expect(Number(readFileSync(join(home, 'daemon.lock'), 'utf8'))).toBe(winner)
    const down = spawnSync(process.execPath, [BIN, 'down'], {
      env,
      timeout: 30_000,
      windowsHide: true
    })
    expect(down.status).toBe(0)
    // `nsq down` returns once the daemon process is gone, not just its socket (spawnSync blocks
    // the loop, so ask the OS rather than wait for the child's exit event).
    expect(() => process.kill(winner!, 0)).toThrow()
    expect(existsSync(join(home, 'daemon.lock'))).toBe(false)
  }, 60_000)

  it('lets one of several simultaneous daemons win', async () => {
    const starts = Array.from({ length: 4 }, startDaemon)
    const exits = starts.map(
      (child) =>
        new Promise<number | null>((done) => {
          child.on('exit', (code) => done(code))
          setTimeout(() => done(null), 15_000)
        })
    )
    const codes = await Promise.all(exits)
    // Three exit on their own ("already running", code 0); one is still serving.
    expect(codes.filter((code) => code === 0)).toHaveLength(3)
    expect(codes.filter((code) => code === null)).toHaveLength(1)
    const state = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }
    const winner = starts.find((child) => child.exitCode === null)
    expect(state.pid).toBe(winner?.pid)
    expect(Number(readFileSync(join(home, 'daemon.lock'), 'utf8'))).toBe(winner?.pid)
    const ls = spawnSync(process.execPath, [BIN, 'ls', '--json'], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true
    })
    expect(ls.status).toBe(0)
  }, 60_000)
})
