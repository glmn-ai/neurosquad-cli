// The herdr status protocol end to end: the daemon, a plain command that
// speaks it (scripts/e2e/fake-herdr-agent.mjs) through the shim at
// HERDR_BIN_PATH and straight to the socket, the status it reports (working /
// needs you with its message / finished), its session id, its resume command
// after a daemon restart, and a report for another agent's pane refused.
// Needs the built CLI (`npm run build`) and node-pty.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BIN = resolve(HERE, '..', 'bin', 'nsq.js')
const SHIM = resolve(HERE, '..', 'dist', 'herdrShim.js')
const FAKE = resolve(HERE, '..', '..', '..', 'scripts', 'e2e', 'fake-herdr-agent.mjs')
const built = existsSync(resolve(BIN, '..', '..', 'dist', 'bin.js')) && existsSync(SHIM)
let home = ''
let work = ''

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  NSQ_HOME: home,
  NSQ_NO_NOTIFY: '1',
  NSQ_RESTART_PAUSE_MS: '300'
})
const nsq = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: work,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: env()
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

interface Row {
  id: string
  name: string
  status?: string
  detail?: string
  running: boolean
}
const agent = (name: string): Row | undefined => {
  try {
    return (JSON.parse(nsq('ls', '--json').stdout) as Row[]).find((a) => a.name === name)
  } catch {
    return undefined
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
const statusOf = (name: string): string | undefined => agent(name)?.status

/** Keys typed into the agent as the person would (an answer to its question). */
async function type(name: string, data: string): Promise<void> {
  process.env['NSQ_HOME'] = home
  const { DaemonClient } = await import('./client/client.js')
  const client = await DaemonClient.open('test', { autostart: false })
  try {
    await client.request({ t: 'input', id: agent(name)!.id, data })
  } finally {
    client.close()
  }
}

async function turn(name: string): Promise<void> {
  expect(await until(() => statusOf(name) === 'idle')).toBe(true)
  expect(nsq('send', name, 'go').status).toBe(0)
  expect(await until(() => statusOf(name) === 'needs-input')).toBe(true)
  expect(agent(name)?.detail).toBe('Fake wants to run: mkdir out')
  await type(name, 'y\r')
  expect(await until(() => statusOf(name) === 'finished')).toBe(true)
}

describe.skipIf(!built)('herdr status protocol', () => {
  const previousHome = process.env['NSQ_HOME']
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'nsq-herdr-home-'))
    work = mkdtempSync(join(tmpdir(), 'nsq-herdr-work-'))
  })

  afterAll(() => {
    nsq('down')
    try {
      const state = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }
      process.kill(state.pid)
    } catch {
      // stopped
    }
    if (previousHome === undefined) delete process.env['NSQ_HOME']
    else process.env['NSQ_HOME'] = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('a command reporting through HERDR_BIN_PATH: status, question, session, resume', async () => {
    const envOut = join(work, 'cli-env.json')
    const run = nsq(
      'run',
      '--name',
      'fake-cli',
      '--',
      process.execPath,
      FAKE,
      '--mode',
      'cli',
      '--env-out',
      envOut
    )
    expect(run.status, run.stderr).toBe(0)
    await turn('fake-cli')
    const record = (
      JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8')) as {
        agents: { name: string; harnessSessionId?: string; resumeCommand?: string[] }[]
      }
    ).agents.find((a) => a.name === 'fake-cli')
    expect(record?.harnessSessionId).toBe('fake-session-1')
    expect(record?.resumeCommand?.[0]).toBe('node')

    // Another agent's pane (or a made-up one) is refused, and changes nothing.
    const given = JSON.parse(readFileSync(envOut, 'utf8')) as Record<string, string>
    expect(given['HERDR_ENV']).toBe('1')
    const forged = given['HERDR_PANE_ID']!.replace(/^[0-9a-f]/, (c) => (c === 'a' ? 'b' : 'a'))
    const refused = spawnSync(
      process.execPath,
      [SHIM, 'pane', 'report-agent', forged, '--source', 'x', '--agent', 'x', '--state', 'working'],
      { encoding: 'utf8', env: { ...process.env, ...given }, windowsHide: true }
    )
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('pane_not_found')
    expect(statusOf('fake-cli')).toBe('finished')

    // The daemon restarts: the agent comes back through the command it reported.
    expect(nsq('down').status).toBe(0)
    expect(nsq('up').status).toBe(0)
    expect(
      await until(() => /fake: resumed fake-session-1/.test(nsq('peek', 'fake-cli').stdout))
    ).toBe(true)
    await turn('fake-cli')
  }, 180_000)

  it('a command writing to the socket itself (a Unix socket, the named pipe on Windows)', async () => {
    const run = nsq(
      'run',
      '--name',
      'fake-socket',
      '--',
      process.execPath,
      FAKE,
      '--mode',
      'socket'
    )
    expect(run.status, run.stderr).toBe(0)
    await turn('fake-socket')
    // `nsq restart` resumes it too; a fresh start would print "fake: ready".
    expect(nsq('restart', 'fake-socket').status).toBe(0)
    expect(
      await until(() => /fake: resumed fake-session-1/.test(nsq('peek', 'fake-socket').stdout))
    ).toBe(true)
  }, 120_000)
})
