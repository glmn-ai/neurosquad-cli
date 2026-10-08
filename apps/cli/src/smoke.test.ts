// The daemon end to end, with a plain command as the agent: start on demand,
// run, status from the terminal, peek, send, stop, resume after a daemon
// restart, shut down. Needs the built CLI (`npm run build`) and node-pty.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'nsq.js')
const built = existsSync(resolve(BIN, '..', '..', 'dist', 'bin.js'))
let home = ''
let work = ''

const nsq = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: work,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, NSQ_HOME: home, NSQ_NO_NOTIFY: '1' }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

interface Row {
  name: string
  status?: string
  running: boolean
}
const list = (): Row[] => {
  try {
    return JSON.parse(nsq('ls', '--json').stdout) as Row[]
  } catch {
    return []
  }
}
async function until(check: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  }
  return check()
}

// A command that prints, goes quiet, and echoes what it is sent.
const SCRIPT =
  "console.log('ready');process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{for(const l of d.split(/\\r|\\n/))if(l.trim())console.log('got:'+l.trim())})"

describe.skipIf(!built)('daemon smoke', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'nsq-smoke-home-'))
    work = mkdtempSync(join(tmpdir(), 'nsq-smoke-work-'))
  })

  afterAll(() => {
    nsq('down')
    try {
      const state = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }
      process.kill(state.pid)
    } catch {
      // stopped
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  })

  it('runs a command agent through its lifecycle', async () => {
    const run = nsq('run', '--name', 'echo', '--', process.execPath, '-e', SCRIPT)
    expect(run.status, run.stderr).toBe(0)
    expect(
      await until(() => list().some((a) => a.name === 'echo' && a.status === 'finished'))
    ).toBe(true)

    expect(nsq('send', 'echo', 'hello there').status).toBe(0)
    expect(await until(() => /got:hello there/.test(nsq('peek', 'echo').stdout))).toBe(true)

    expect(nsq('down').status).toBe(0)
    expect(list()).toEqual([])
    expect(nsq('up').status).toBe(0)
    expect(await until(() => list().some((a) => a.name === 'echo' && a.running))).toBe(true)

    expect(nsq('stop', 'echo').status).toBe(0)
    expect(await until(() => list().some((a) => a.name === 'echo' && a.status === 'exited'))).toBe(
      true
    )
    expect(nsq('rm', 'echo').status).toBe(0)
    expect(list()).toEqual([])
  }, 120_000)
})
