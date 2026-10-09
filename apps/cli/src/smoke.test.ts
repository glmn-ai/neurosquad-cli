// The daemon end to end, with a plain command as the agent: start on demand,
// run, status from the terminal, peek, send, stop, resume after a daemon
// restart, shut down. Needs the built CLI (`npm run build`) and node-pty.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pty from 'node-pty'

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
    env: { ...process.env, NSQ_HOME: home, NSQ_NO_NOTIFY: '1', NSQ_RESTART_PAUSE_MS: '4000' }
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

    // A second daemon on the same home does not take over.
    const second = nsq('daemon', '--foreground')
    expect(second.status).toBe(0)
    expect(second.stdout).toMatch(/already running/)
    expect(list().some((a) => a.name === 'echo')).toBe(true)

    // Attach in a real terminal: keys go to the agent, Ctrl+] detaches.
    const attached = pty.spawn(process.execPath, [BIN, 'attach', 'echo'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: work,
      env: {
        ...process.env,
        NSQ_HOME: home,
        NSQ_NO_NOTIFY: '1',
        NSQ_RESTART_PAUSE_MS: '4000'
      } as Record<string, string>
    })
    let screen = ''
    attached.onData((data) => {
      screen += data
    })
    const exited = new Promise<number>((resolveExit) =>
      attached.onExit(({ exitCode }) => resolveExit(exitCode))
    )
    expect(await until(() => screen.includes('ready'), 15_000)).toBe(true)
    attached.write('typed in attach\r')
    expect(await until(() => screen.includes('got:typed in attach'), 15_000)).toBe(true)
    attached.write('\x1d')
    expect(await exited).toBe(0)
    expect(screen).toContain('detached from echo')

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

    // A stop during a restart's pause wins: the restart does not start the agent again.
    expect(nsq('start', 'echo').status).toBe(0)
    expect(await until(() => list().some((a) => a.name === 'echo' && a.running))).toBe(true)
    // The daemon's restart pause is 4 s here (NSQ_RESTART_PAUSE_MS): the stop lands inside it.
    let restartDone = false
    const restarting = new Promise<number | null>((resolveRestart) => {
      const child = spawn(process.execPath, [BIN, 'restart', 'echo'], {
        cwd: work,
        windowsHide: true,
        env: { ...process.env, NSQ_HOME: home, NSQ_NO_NOTIFY: '1', NSQ_RESTART_PAUSE_MS: '4000' }
      })
      child.on('exit', (code) => {
        restartDone = true
        resolveRestart(code)
      })
    })
    expect(await until(() => list().some((a) => a.name === 'echo' && !a.running), 5_000)).toBe(true)
    expect(nsq('stop', 'echo').status).toBe(0)
    expect(restartDone).toBe(false)
    expect(await restarting).toBe(0)
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
    expect(list().find((a) => a.name === 'echo')?.running).toBe(false)

    expect(nsq('rm', 'echo').status).toBe(0)
    expect(list()).toEqual([])
  }, 120_000)
})
