// Online phone access end to end, with a fake cloudflared (scripts/e2e/fake-cloudflared.mjs) that
// prints a quick-tunnel address and forwards to the daemon's tunnel listener the way Cloudflare's
// edge does. The token guard through the "internet", the lockout, plain http refused, who is
// connected, and the connector stopped by `phone on` (no --online), `phone off` and `nsq down`.
// Needs the built CLI.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BIN = resolve(HERE, '..', 'bin', 'nsq.js')
const FAKE = resolve(HERE, '..', '..', '..', 'scripts', 'e2e', 'fake-cloudflared.mjs')
const built = existsSync(resolve(BIN, '..', '..', 'dist', 'bin.js'))
const URL_SHOWN = 'https://fake-e2e-tunnel.trycloudflare.com'
let home = ''
let work = ''
let fakeDir = ''

const nsq = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: work,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      NSQ_HOME: home,
      NSQ_NO_NOTIFY: '1',
      NSQ_CLOUDFLARED: join(fakeDir, 'fake-cloudflared.mjs')
    }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const fakeState = (): { port: number; pid: number; argv: string[] } =>
  JSON.parse(readFileSync(join(fakeDir, 'fake-cloudflared.state.json'), 'utf8')) as {
    port: number
    pid: number
    argv: string[]
  }

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  return !alive(pid)
}

describe.skipIf(!built)('online phone access (fake cloudflared)', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'nsq-online-home-'))
    work = mkdtempSync(join(tmpdir(), 'nsq-online-work-'))
    fakeDir = mkdtempSync(join(tmpdir(), 'nsq-online-fake-'))
    copyFileSync(FAKE, join(fakeDir, 'fake-cloudflared.mjs'))
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
      process.kill(fakeState().pid)
    } catch {
      // stopped
    }
    for (const dir of [home, work, fakeDir]) rmSync(dir, { recursive: true, force: true })
  })

  it('goes online, guards the token from the internet, and stops the tunnel', async () => {
    const on = nsq('phone', 'on', '--online', '--port', '0')
    expect(on.status, on.stderr + on.stdout).toBe(0)
    const token = readFileSync(join(home, 'phone-token'), 'utf8').trim()
    expect(on.stdout).toContain(`online at ${URL_SHOWN}`)
    expect(on.stdout).toContain('anyone with this link and token can control your agents')
    expect(on.stdout).toContain('changes every time')
    // Going online is pairing: the https link with the token, and its QR.
    expect(on.stdout).toContain(`${URL_SHOWN}/?t=${token}`)
    const { port, pid, argv } = fakeState()
    expect(argv.slice(0, 3)).toEqual(['tunnel', '--no-autoupdate', '--config'])
    // The tunnel forwards to its own listener, not the ordinary phone port.
    const localPort = /port (\d+)/.exec(on.stdout)?.[1]
    expect(argv.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(argv.at(-1)).not.toBe(`http://127.0.0.1:${localPort}`)

    const internet = `http://127.0.0.1:${port}`
    const call = (path: string, ip: string, key: string | null, proto = 'https') =>
      fetch(`${internet}${path}`, {
        headers: {
          'x-fake-client-ip': ip,
          'x-fake-proto': proto,
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
          ...(key ? { authorization: `Bearer ${key}` } : {})
        }
      })

    const page = await call('/', '198.51.100.20', null)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<html')
    expect((await call('/api/state', '198.51.100.20', null)).status).toBe(401)
    expect((await call('/api/state', '198.51.100.20', token)).status).toBe(200)

    // A stranger guessing: five wrong tokens and the address is locked out, even with the right one.
    for (let i = 0; i < 5; i++) {
      expect((await call('/api/state', '203.0.113.66', 'f'.repeat(48))).status).toBe(401)
    }
    expect((await call('/api/state', '203.0.113.66', token)).status).toBe(429)
    // The owner's phone is not caught by it.
    expect((await call('/api/state', '198.51.100.20', token)).status).toBe(200)
    // Plain http through the tunnel is refused, token or not.
    expect((await call('/api/state', '198.51.100.20', token, 'http')).status).toBe(403)

    const status = nsq('phone', 'status')
    expect(status.stdout).toContain(`online at ${URL_SHOWN}`)
    expect(status.stdout).toMatch(/iPhone · Safari\s+198\.51\.100\.20\s+\(internet\)/)
    expect(nsq('phone', 'pair').stdout).toContain(`${URL_SHOWN}/?t=${token}`)

    // `phone on` without --online: back to local only, the connector is stopped.
    const local = nsq('phone', 'on', '--port', '0')
    expect(local.status).toBe(0)
    expect(local.stdout).not.toContain('online at')
    expect(await gone(pid)).toBe(true)
    await expect(call('/api/state', '198.51.100.20', token)).rejects.toThrow()

    // On again; `phone off` stops it.
    expect(nsq('phone', 'on', '--online', '--port', '0').status).toBe(0)
    const second = fakeState().pid
    expect(second).not.toBe(pid)
    expect(nsq('phone', 'off').stdout).toContain('off')
    expect(await gone(second)).toBe(true)

    // On again; `nsq down` stops it with the daemon.
    expect(nsq('phone', 'on', '--online', '--port', '0').status).toBe(0)
    const third = fakeState().pid
    expect(alive(third)).toBe(true)
    nsq('down')
    expect(await gone(third)).toBe(true)
  }, 120_000)

  it('refuses a tunnel token on the command line and --tunnel-token without --online', () => {
    const inline = nsq('phone', 'on', '--online', '--tunnel-token=abc')
    expect(inline.status).not.toBe(0)
    expect(inline.stderr + inline.stdout).toContain('give no token on the command line')
    const alone = nsq('phone', 'on', '--tunnel-token')
    expect(alone.status).not.toBe(0)
    expect(alone.stderr + alone.stdout).toContain('--tunnel-token goes with --online')
    const zero = nsq('phone', 'on', '--online', '--tunnel-port', '0')
    expect(zero.status).not.toBe(0)
    expect(zero.stderr + zero.stdout).toContain('--tunnel-port takes a number from 1')
  })
})
