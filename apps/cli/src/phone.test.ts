// Phone access end to end: the daemon serves the phone API for its agents —
// list, screen, prompt, the token guard, rotate. Needs the built CLI.
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

async function until<T>(check: () => Promise<T | undefined>, ms = 20_000): Promise<T | undefined> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  }
  return undefined
}

const SCRIPT =
  "console.log('ready');process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{for(const l of d.split(/\\r|\\n/))if(l.trim())console.log('got:'+l.trim())})"

describe.skipIf(!built)('phone access', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'nsq-phone-home-'))
    work = mkdtempSync(join(tmpdir(), 'nsq-phone-work-'))
  })

  afterAll(() => {
    nsq('down')
    try {
      const state = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }
      process.kill(state.pid)
    } catch {
      // stopped
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('serves the agents to a paired phone, and rotate revokes it', async () => {
    expect(nsq('run', '--name', 'echo', '--', process.execPath, '-e', SCRIPT).status).toBe(0)
    const on = nsq('phone', 'on', '--port', '0')
    expect(on.status, on.stderr).toBe(0)
    expect(on.stdout).toContain('this machine only')
    // The token is never printed by `on`, only by `pair`.
    const token = readFileSync(join(home, 'phone-token'), 'utf8').trim()
    expect(on.stdout).not.toContain(token)
    const port = /port (\d+)/.exec(on.stdout)?.[1]
    expect(port).toBeDefined()
    const base = `http://127.0.0.1:${port}`
    const api = (path: string, init: RequestInit = {}, key = token): Promise<Response> =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
      })

    expect((await api('/api/state', {}, 'wrong-token-wrong-token-wrong')).status).toBe(401)
    const state = (await (await api('/api/state')).json()) as {
      agents: { id: string; name: string; running: boolean }[]
    }
    const agent = state.agents.find((a) => a.name === 'echo')
    expect(agent?.running).toBe(true)

    const prompt = await api(`/api/agent/${agent!.id}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text: 'from the phone' })
    })
    expect(prompt.status).toBe(202)
    const seen = await until(async () => {
      const screen = (await (await api(`/api/agent/${agent!.id}/screen`)).json()) as {
        screen: string
      }
      return screen.screen.includes('got:from the phone') ? true : undefined
    })
    expect(seen).toBe(true)

    // Not waiting for an answer: refused, nothing typed.
    const answer = await api(`/api/agent/${agent!.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ key: 'yes' })
    })
    expect(answer.status).toBeGreaterThanOrEqual(400)

    // Who is connected: this test's fetch, by address and device.
    const status = nsq('phone', 'status')
    expect(status.stdout).toContain('1 connected')
    expect(status.stdout).toMatch(/node\s+(::ffff:)?127\.0\.0\.1/)

    const pair = nsq('phone', 'pair')
    expect(pair.stdout).toContain(`/?t=${token}`)

    expect(nsq('phone', 'rotate').status).toBe(0)
    expect((await api('/api/state')).status).toBe(401)
    const fresh = readFileSync(join(home, 'phone-token'), 'utf8').trim()
    expect((await api('/api/state', {}, fresh)).status).toBe(200)

    expect(nsq('phone', 'off').stdout).toContain('off')
    await expect(api('/api/state', {}, fresh)).rejects.toThrow()
  }, 90_000)
})
