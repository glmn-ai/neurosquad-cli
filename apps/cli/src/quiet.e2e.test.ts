// "Quiet while working" end to end: the daemon with a stand-in `claude` (scripts/e2e/quiet-agent.mjs)
// that starts a turn through its real hook endpoint, then runs a stand-in `git push` whose
// password prompt waits on the terminal — a question no hook reports — while a spinner keeps
// turning above it. With a short threshold (config quietAfter = 0.05 min = 3 s) the agent must
// turn quiet with the prompt as its hint in `nsq ls` (table and --json) and on the phone API,
// ntfy (a local stand-in server) must get one push with the name, how long and the prompt line,
// and typing into the agent must clear it at once — logged in the approvals log as a quiet
// episode ended by input. Needs the built CLI (`npm run build`).
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BIN = resolve(HERE, '..', 'bin', 'nsq.js')
const AGENT = resolve(HERE, '..', '..', '..', 'scripts', 'e2e', 'quiet-agent.mjs')
const built = existsSync(resolve(BIN, '..', '..', 'dist', 'bin.js'))
let work = ''
let home = ''
let pids = ''
let env: NodeJS.ProcessEnv = {}
let ntfy: Server | null = null
const pushes: Record<string, unknown>[] = []

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

interface Listed {
  name: string
  status?: string
  quiet?: { since: number; at: number; line?: string; asking?: string }
}

const listed = (): Listed | undefined => {
  try {
    return (JSON.parse(nsq('ls', '--json').stdout) as Listed[]).find((agent) => agent.name === 'fq')
  } catch {
    return undefined
  }
}

const logged = (): {
  kind?: string
  outcome: string
  question: { text: string }
  by?: unknown
}[] => {
  try {
    return readFileSync(join(home, 'logs', 'approvals.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

describe.skipIf(!built)('quiet while working', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'nsq-quiet-'))
    home = join(work, 'home')
    const bin = join(work, 'bin')
    mkdirSync(bin, { recursive: true })
    mkdirSync(home, { recursive: true })
    pids = join(work, 'pids.txt')
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${AGENT}" %*\r\n`)
    } else {
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`,
        {
          mode: 0o755
        }
      )
    }
    // 0.05 min = 3 s: the threshold, as `nsq config set quietAfter 0.05` writes it.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ quietAfter: 0.05 }))
    // The local stand-in for ntfy: records what is published to it.
    ntfy = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      req.on('end', () => {
        try {
          pushes.push({ path: req.url, ...(JSON.parse(body) as Record<string, unknown>) })
        } catch {
          pushes.push({ path: req.url, raw: body })
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((done) => ntfy!.listen(0, '127.0.0.1', () => done()))
    const port = (ntfy.address() as AddressInfo).port
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
      NSQ_KEYRING: 'memory',
      NSQ_NTFY_URL: `http://127.0.0.1:${port}/nsq-quiet-test`,
      NSQ_TEST_PIDS: pids
    }
  })

  afterAll(async () => {
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
    await new Promise<void>((done) => (ntfy ? ntfy.close(() => done()) : done()))
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('flags a working agent whose tool waits for a password, and clears it on input', async () => {
    const run = nsq('run', 'claude', '--name', 'fq')
    expect(run.status, run.stderr).toBe(0)
    expect(await until(() => listed()?.status === 'working')).toBe(true)

    // The spinner keeps turning; only the threshold after the prompt appeared makes it quiet.
    expect(await until(() => listed()?.quiet !== undefined)).toBe(true)
    const agent = listed()!
    expect(agent.status).toBe('working')
    expect(agent.quiet!.asking).toMatch(/^Password for 'https:\/\/me@git\.example\.com':$/)
    expect(agent.quiet!.at - agent.quiet!.since).toBeGreaterThanOrEqual(3000)

    // `nsq ls`: "quiet 3s" and the prompt.
    const table = nsq('ls')
    expect(table.stdout).toMatch(/fq\s+Claude Code\s+quiet \d+s/)
    expect(table.stdout).toContain('check it — asking: Password for')

    // The phone API.
    const on = nsq('phone', 'on', '--port', '0')
    expect(on.status, on.stderr).toBe(0)
    const port = /port (\d+)/.exec(on.stdout)?.[1]
    const token = readFileSync(join(home, 'phone-token'), 'utf8').trim()
    const state = (await (
      await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json()) as { agents: { name?: string; status?: string; quiet?: { asking?: string } }[] }
    const phoneAgent = state.agents.find((entry) => entry.name === 'fq')
    expect(phoneAgent?.status).toBe('working')
    expect(phoneAgent?.quiet?.asking).toContain('Password for')
    nsq('phone', 'off')

    // One push: the name, how long, the prompt line — and no answer keys.
    expect(await until(() => pushes.length > 0, 10_000)).toBe(true)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({
      path: '/',
      topic: 'nsq-quiet-test',
      title: expect.stringMatching(/^fq has been quiet for \d+ s$/),
      message: "Looks like it's asking: Password for 'https://me@git.example.com':",
      tags: ['hourglass']
    })
    expect(JSON.stringify(pushes[0])).not.toMatch(/actions|yes|always/i)

    // Typing clears it at once (before git even answers), and the episode is logged.
    expect(nsq('_input', 'fq', JSON.stringify('hunter2\r')).status).toBe(0)
    expect(listed()?.quiet).toBeUndefined()
    expect(await until(() => logged().some((entry) => entry.kind === 'quiet'))).toBe(true)
    const episode = logged().find((entry) => entry.kind === 'quiet')!
    expect(episode).toMatchObject({
      kind: 'quiet',
      outcome: 'input',
      question: { text: expect.stringContaining("looks like it's asking: Password for") },
      by: { via: 'terminal', from: 'local' }
    })
    // git got its line, the turn ends: finished, and no second push.
    expect(await until(() => listed()?.status === 'finished')).toBe(true)
    expect(listed()?.quiet).toBeUndefined()
    expect(pushes).toHaveLength(1)
    const log = nsq('log', 'approvals')
    expect(log.stdout).toMatch(/fq\s+Claude Code\s+input\s+terminal \(attach\)\s+quiet; looks like/)
  }, 90_000)
})
