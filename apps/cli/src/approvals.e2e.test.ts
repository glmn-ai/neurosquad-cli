// The approvals log end to end: the daemon with a stand-in `claude` that asks permission
// questions through its real hook endpoint (PermissionRequest + Notification, as Claude Code
// does). Each question is answered another way — `nsq answer`, the dashboard's key, the phone
// page, a key typed into the agent's terminal, the CLI itself, an interrupt, a stop — and each
// must land in logs/approvals.jsonl with the right outcome and origin, the command's secret
// masked. Then `nsq log approvals` and the off switch. Needs the built CLI (`npm run build`).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'nsq.js')
const built = existsSync(resolve(BIN, '..', '..', 'dist', 'bin.js'))
let work = ''
let home = ''
let pids = ''
let env: NodeJS.ProcessEnv = {}

const nsq = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: work,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function until(check: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  return check()
}

interface Logged {
  agent: { id: string; name: string }
  harness: string
  workspace: string
  question: { text: string; tool?: string; command?: string }
  outcome: string
  answer?: string
  by?: { via: string; from: string; device?: string; client?: string }
}

const logged = (): Logged[] => {
  try {
    return readFileSync(join(home, 'logs', 'approvals.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Logged)
  } catch {
    return []
  }
}

const status = (): string | undefined => {
  const ls = nsq('ls', '--json')
  try {
    return (JSON.parse(ls.stdout) as { name: string; status?: string }[]).find(
      (agent) => agent.name === 'fa'
    )?.status
  } catch {
    return undefined
  }
}

/**
 * The stand-in Claude Code. It finds its hook endpoint in the `--settings` file nsq gave it and
 * asks question after question: UserPromptSubmit, PermissionRequest (the tool and its command),
 * Notification (permission_prompt). Any key ends the turn (Stop), and the next question follows.
 * The question numbered NSQ_TEST_AUTO is approved by the CLI itself (a PostToolUse, no key).
 */
const FAKE_CLAUDE = `
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs')
appendFileSync(process.env.NSQ_TEST_PIDS, process.pid + '\\n')
const args = process.argv.slice(2)
const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'))
const base = settings.hooks.PermissionRequest[0].hooks[0].url.replace(/\\/ClaudePermission$/, '')
const post = (event, body) =>
  fetch(base + '/' + event, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
const counter = process.env.NSQ_TEST_COUNTER
const next = () => { let n = 0; try { n = Number(readFileSync(counter, 'utf8')) || 0 } catch {} writeFileSync(counter, String(n + 1)); return n }
let waiting = false
async function ask() {
  const n = next()
  await post('UserPromptSubmit', { prompt: 'never logged ' + n })
  await post('ClaudePermission', { tool_name: 'Bash', tool_input: { command: 'deploy step-' + n + ' --token=supersecret' + n } })
  await post('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  waiting = true
  console.log('asking ' + n)
  if (String(n) === process.env.NSQ_TEST_AUTO) {
    setTimeout(async () => { waiting = false; await post('PostToolUse', { tool_name: 'Bash' }); await post('Stop', {}); setTimeout(ask, 1500) }, 1000)
  }
}
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', async (data) => {
  console.log('key ' + JSON.stringify(data.toString()))
  if (!waiting) return
  waiting = false
  await post('PostToolUse', { tool_name: 'Bash' })
  await post('Stop', {})
  setTimeout(ask, 1500)
})
console.log('fake claude ready')
setTimeout(ask, 1000)
setInterval(() => {}, 1000)
`

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

describe.skipIf(!built)('the approvals log', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'nsq-approvals-'))
    home = join(work, 'home')
    const bin = join(work, 'bin')
    mkdirSync(bin, { recursive: true })
    pids = join(work, 'pids.txt')
    const script = join(work, 'fake-claude.cjs')
    writeFileSync(script, FAKE_CLAUDE)
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`)
    } else {
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755
        }
      )
    }
    const base: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(NSQ_|CLAUDE|ANTHROPIC_|OPENROUTER_)/i.test(key)) base[key] = value
    }
    const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    env = {
      ...base,
      // Only the stand-in: folders with a real Claude Code are left out (never run it here).
      [pathKey]: [
        bin,
        ...(base[pathKey] ?? '')
          .split(delimiter)
          .filter(
            (dir) =>
              dir &&
              !['claude', 'claude.exe', 'claude.cmd'].some((name) => existsSync(join(dir, name)))
          )
      ].join(delimiter),
      NSQ_HOME: home,
      NSQ_NO_NOTIFY: '1',
      NSQ_NO_UPDATE: '1',
      NSQ_TEST_PIDS: pids,
      NSQ_TEST_COUNTER: join(work, 'counter.txt'),
      NSQ_TEST_AUTO: '4'
    }
  })

  afterAll(() => {
    nsq('down')
    try {
      const state = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }
      process.kill(state.pid)
    } catch {
      // stopped
    }
    try {
      for (const pid of readFileSync(pids, 'utf8').split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid))
        } catch {
          // gone
        }
      }
    } catch {
      // none started
    }
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('logs every question with its answer and who gave it, from where', async () => {
    const run = nsq('run', 'claude', '--name', 'fa')
    expect(run.status, run.stderr).toBe(0)
    const id = (JSON.parse(nsq('ls', '--json').stdout) as { id: string; name: string }[]).find(
      (agent) => agent.name === 'fa'
    )!.id
    const asked = (): Promise<boolean> => until(() => status() === 'needs-input')
    const entries = (count: number): Promise<boolean> => until(() => logged().length >= count)

    // 0: `nsq answer`.
    expect(await asked()).toBe(true)
    const answer = nsq('answer', 'fa', 'yes')
    expect(answer.status, answer.stderr).toBe(0)
    expect(await entries(1)).toBe(true)

    // 1: the dashboard's key (a client named "dashboard" sending the same request).
    expect(await asked()).toBe(true)
    process.env['NSQ_HOME'] = home
    const { DaemonClient } = await import('./client/client.js')
    const dashboard = await DaemonClient.open('dashboard', { autostart: false })
    try {
      // Two answers at once: one at a time — the second finds the question answered.
      const both = await Promise.allSettled([
        dashboard.request({ t: 'answer', id, key: 'always' }),
        dashboard.request({ t: 'answer', id, key: 'no' })
      ])
      expect(both.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    } finally {
      dashboard.close()
      delete process.env['NSQ_HOME']
    }
    expect(await entries(2)).toBe(true)

    // 2: the phone page, on this machine, from an iPhone's browser.
    expect(await asked()).toBe(true)
    const on = nsq('phone', 'on', '--port', '0')
    expect(on.status, on.stderr).toBe(0)
    const port = /port (\d+)/.exec(on.stdout)?.[1]
    const token = readFileSync(join(home, 'phone-token'), 'utf8').trim()
    const phone = await fetch(`http://127.0.0.1:${port}/api/agent/${id}/answer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': IPHONE
      },
      body: JSON.stringify({ key: 'no' })
    })
    expect(phone.status).toBe(202)
    expect(await entries(3)).toBe(true)
    nsq('phone', 'off')

    // 3: a key typed into the agent's own terminal (as `nsq attach` sends it): Claude's "1".
    expect(await asked()).toBe(true)
    expect(nsq('_input', 'fa', JSON.stringify('1')).status).toBe(0)
    expect(await entries(4)).toBe(true)

    // 4: the CLI approves it by itself (NSQ_TEST_AUTO).
    expect(await entries(5)).toBe(true)

    // 5: an interrupt.
    expect(await asked()).toBe(true)
    expect(nsq('interrupt', 'fa').status).toBe(0)
    expect(await entries(6)).toBe(true)

    // 6: the agent is stopped while it waits.
    expect(await asked()).toBe(true)
    expect(nsq('stop', 'fa').status).toBe(0)
    expect(await entries(7)).toBe(true)

    const log = logged()
    expect(
      log.map((entry) => [entry.outcome, entry.answer, entry.by?.via, entry.by?.from])
    ).toEqual([
      ['answered', 'yes', 'cli', 'local'],
      ['answered', 'always', 'dashboard', 'local'],
      ['answered', 'no', 'phone', 'local'],
      ['terminal', 'yes', 'terminal', 'local'],
      ['cli', undefined, undefined, undefined],
      ['interrupted', undefined, 'cli', 'local'],
      ['exited', undefined, undefined, undefined]
    ])
    expect(log[2]!.by!.device).toBe('iPhone · Safari')
    expect(log[3]!.by!.client).toBe('attach')
    log.forEach((entry, n) => {
      expect(entry.agent).toEqual({ id, name: 'fa' })
      expect(entry.harness).toBe('claude-code')
      expect(entry.question.tool).toBe('Bash')
      expect(entry.question.command).toBe(`deploy step-${n} --token=***`)
      expect(entry.question.text).toContain(`deploy step-${n}`)
    })
    const raw = readFileSync(join(home, 'logs', 'approvals.jsonl'), 'utf8')
    expect(raw).not.toContain('supersecret')
    expect(raw).not.toContain('never logged')
    expect(raw).not.toContain(token)

    // The command: a table, a filter, JSON.
    const table = nsq('log', 'approvals')
    expect(table.status, table.stderr).toBe(0)
    expect(table.stdout).toMatch(/TIME\s+AGENT\s+HARNESS\s+ANSWER\s+BY\s+QUESTION/)
    expect(table.stdout).toContain('phone (local, iPhone · Safari)')
    expect(table.stdout).toContain('Bash: deploy step-0 --token=***')
    expect(table.stdout).toContain('terminal (attach)')
    expect(table.stdout).toContain('nsq interrupt')
    const json = nsq('log', 'approvals', '--agent', 'fa', '--since', '1h', '--json')
    expect((JSON.parse(json.stdout) as unknown[]).length).toBe(7)
    expect(JSON.parse(nsq('log', 'approvals', '--agent', 'nobody', '--json').stdout)).toEqual([])

    // The off switch: a question answered now is not logged.
    expect(nsq('config', 'set', 'approvalsLog', 'false').status).toBe(0)
    expect(nsq('start', 'fa').status).toBe(0)
    expect(await asked()).toBe(true)
    expect(nsq('answer', 'fa', 'yes').status).toBe(0)
    expect(await until(() => status() === 'working' || status() === 'finished', 10_000)).toBe(true)
    expect(logged()).toHaveLength(7)
    expect(nsq('log', 'approvals').stdout).toContain('the approvals log is off')
  }, 240_000)
})
