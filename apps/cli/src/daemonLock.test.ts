// Two daemons started at the same moment on one nsq home: exactly one keeps running.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'nsq.js')
const built = existsSync(resolve(BIN, '..', '..', 'dist', 'bin.js'))
const home = mkdtempSync(join(tmpdir(), 'nsq-lock-home-'))
const env = { ...process.env, NSQ_HOME: home, NSQ_NO_NOTIFY: '1' }

afterAll(() => {
  spawnSync(process.execPath, [BIN, 'down'], { env, timeout: 30_000, windowsHide: true })
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!built)('daemon lock', () => {
  it('lets one of several simultaneous daemons win', async () => {
    const starts = Array.from({ length: 4 }, () =>
      spawn(process.execPath, [BIN, 'daemon', '--foreground'], {
        env,
        stdio: 'ignore',
        windowsHide: true
      })
    )
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
