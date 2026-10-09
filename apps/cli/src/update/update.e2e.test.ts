// The updater end to end, with a stand-in registry and a stand-in npm (scripts/e2e/update-fixture.mjs):
// a copy of the built CLI laid out like `npm install -g` finds a new release on its own, installs
// it in the background, does NOT restart while an agent would be lost, restarts onto it once
// nothing is in the way, and comes back on the new version. Needs the built CLI (`npm run build`).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pty from 'node-pty'
import xtermHeadless from '@xterm/headless'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const built = existsSync(join(ROOT, 'apps', 'cli', 'dist', 'bin.js'))

interface Fixture {
  bin: string
  packageDir: string
  breakNextRelease(): void
  prefix: string
  env: Record<string, string>
  readNpmCalls(): string[][]
}
interface Registry {
  base: string
  requests: { url: string; headers: Record<string, string | string[] | undefined> }[]
  setLatest(version: string): void
  close(): Promise<void>
}

let work = ''
let home = ''
let fixture: Fixture
let registry: Registry

const env = (): NodeJS.ProcessEnv => {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(base)) if (/^NSQ_/.test(key)) delete base[key]
  return { ...base, ...fixture.env, NSQ_HOME: home, NSQ_NO_NOTIFY: '1' }
}
// Asynchronous: the stand-in registry answers from this process.
const nsq = (
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, [fixture.bin, ...args], {
      cwd: work,
      windowsHide: true,
      env: env()
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolveRun({ status, stdout, stderr })
    })
  })
const daemonState = (): { pid: number; version: string } | null => {
  try {
    return JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as {
      pid: number
      version: string
    }
  } catch {
    return null
  }
}
const updateCache = (): { installed?: { version: string }; applied?: { version: string } } => {
  try {
    return JSON.parse(readFileSync(join(home, 'update.json'), 'utf8')) as object
  } catch {
    return {}
  }
}
async function until(
  check: () => boolean,
  ms = 45_000,
  refresh?: () => Promise<void>
): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await refresh?.()
    if (check()) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  }
  return check()
}
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const KEEP = 'setInterval(() => {}, 1000); console.log("ready")'

describe.skipIf(!built)('auto-update (fake registry, fake npm)', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'nsq-update-e2e-'))
    home = join(work, 'home')
    const helpers = (await import(
      pathToFileURL(join(ROOT, 'scripts', 'e2e', 'update-fixture.mjs')).href
    )) as {
      makeInstalledCopy(options: object): Fixture
      startFakeRegistry(options: object): Promise<Registry>
    }
    registry = await helpers.startFakeRegistry({ latest: '0.1.1' })
    fixture = helpers.makeInstalledCopy({
      root: ROOT,
      work,
      version: '0.1.0',
      registry: registry.base
    })
  })

  afterAll(async () => {
    if (fixture) await nsq('down')
    const state = daemonState()
    if (state && pidAlive(state.pid)) process.kill(state.pid)
    await registry?.close()
    // The dependency link first: never follow it into the repository's node_modules.
    try {
      if (fixture) unlinkSync(join(fixture.packageDir, 'node_modules'))
    } catch {
      // already gone
    }
    rmSync(work, { recursive: true, force: true })
  })

  it('finds, installs and applies an update without losing an agent', async () => {
    expect((await nsq('--version')).stdout.trim()).toBe('0.1.0')
    const run = await nsq('run', '--name', 'keep', '--', process.execPath, '-e', KEEP)
    expect(run.status, run.stderr).toBe(0)
    const first = daemonState()
    expect(first?.version).toBe('0.1.0')

    // The daemon checks ~10 s after it starts and installs through "npm" by itself.
    expect(await until(() => updateCache().installed?.version === '0.1.1', 60_000)).toBe(true)
    const calls = fixture.readNpmCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        'install',
        '--global',
        '--prefix',
        // The daemon sees its real path (macOS: /private/var/…).
        realpathSync(fixture.prefix),
        'neurosquad@0.1.1'
      ])
    )
    // Only the package's public metadata was asked for: no credentials, cookies or ids.
    expect(registry.requests.length).toBeGreaterThan(0)
    for (const request of registry.requests) {
      expect(request.url).toBe('/neurosquad')
      for (const header of ['authorization', 'cookie', 'npm-session', 'x-nsq-id']) {
        expect(request.headers[header]).toBeUndefined()
      }
    }

    // `keep` is a plain command: a restart would start it over, so the daemon waits.
    const check = await nsq('update', '--check')
    expect(check.stdout).toMatch(/0\.1\.1 is installed; the daemon runs 0\.1\.0/)
    expect(check.stdout).toMatch(/keep would start over/)
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
    expect(daemonState()?.pid).toBe(first?.pid)

    // Nothing in the way any more: it restarts onto 0.1.1 by itself.
    expect((await nsq('stop', 'keep')).status).toBe(0)
    expect(
      await until(() => {
        const state = daemonState()
        return state !== null && state.pid !== first?.pid && state.version === '0.1.1'
      }, 60_000)
    ).toBe(true)
    expect(pidAlive(first!.pid)).toBe(false)
    expect((await nsq('--version')).stdout.trim()).toBe('0.1.1')
    const ls = JSON.parse((await nsq('ls', '--json')).stdout) as { name: string }[]
    expect(ls.map((agent) => agent.name)).toEqual(['keep'])
    expect(await until(() => updateCache().applied?.version === '0.1.1', 10_000)).toBe(true)
    expect((await nsq('update', '--check')).stdout).toMatch(/0\.1\.1 is the latest/)
    expect(fixture.readNpmCalls()).toHaveLength(1)
  }, 180_000)

  it('the dashboard shows it, U restarts onto it, and the dashboard reconnects', async () => {
    expect((await nsq('start', 'keep')).status).toBe(0)
    const before = daemonState()
    expect(before?.version).toBe('0.1.1')
    // The dashboard in a real terminal, its screen kept by a headless xterm.
    const term = new xtermHeadless.Terminal({ cols: 140, rows: 30, allowProposedApi: true })
    const dashboard = pty.spawn(process.execPath, [fixture.bin], {
      name: 'xterm-256color',
      cols: 140,
      rows: 30,
      cwd: work,
      env: env() as Record<string, string>
    })
    let raw = ''
    dashboard.onData((data) => {
      raw = (raw + data).slice(-20_000)
      term.write(data)
    })
    const screen = (): string => {
      const lines: string[] = []
      for (let i = 0; i < term.rows; i++) {
        lines.push(
          term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true) ??
            ''
        )
      }
      return lines.join('\n')
    }
    // Every header and footer the dashboard showed (a toast lasts seconds).
    const seen = new Set<string>()
    const sampler = setInterval(() => {
      const lines = screen().split('\n')
      seen.add(lines[0] ?? '')
      seen.add(lines[lines.length - 1] ?? '')
    }, 100)
    // Waits for text on screen. A full repaint now and then (a resize) so that one stray line
    // that scrolled the terminal under the dashboard's diffing renderer cannot hide it.
    let cols = 140
    const shows = async (text: string, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms
      let repaintAt = Date.now() + 3000
      while (Date.now() < deadline) {
        if (screen().includes(text)) return true
        if (Date.now() > repaintAt) {
          cols = cols === 140 ? 141 : 140
          term.resize(cols, 30)
          dashboard.resize(cols, 30)
          repaintAt = Date.now() + 3000
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 200))
      }
      return screen().includes(text)
    }
    const debug = (): string => `${screen()}\n--- raw tail ---\n${JSON.stringify(raw.slice(-4000))}`
    const tail = (file: string): string => {
      try {
        return readFileSync(file, 'utf8').slice(-2500)
      } catch {
        return '(none)'
      }
    }
    try {
      expect(await shows('keep', 20_000), debug()).toBe(true)

      // A new release, installed by hand while the dashboard is open: the header says so.
      registry.setLatest('0.1.2')
      const update = await nsq('update')
      expect(update.stdout).toMatch(/0\.1\.2 is installed/)
      expect(await shows('updated to 0.1.2 · U restart', 20_000), debug()).toBe(true)
      // The dashboard is open: no restart on its own.
      expect(daemonState()?.pid).toBe(before?.pid)

      dashboard.write('U')
      expect(await shows('Restart nsq on 0.1.2?', 10_000), debug()).toBe(true)
      expect(screen()).toMatch(/Commands start over: keep/)
      dashboard.write('y')
      expect(
        await until(() => {
          const state = daemonState()
          return state !== null && state.pid !== before?.pid && state.version === '0.1.2'
        }, 60_000)
      ).toBe(true)
      // Same dashboard process, reconnected to the new daemon.
      expect(
        await until(
          () => [...seen].some((line) => line.includes('updated to 0.1.2 (was 0.1.1)')),
          30_000
        ),
        [
          screen(),
          '--- seen ---',
          ...seen,
          '--- update.json ---',
          tail(join(home, 'update.json')),
          '--- daemon.log ---',
          tail(join(home, 'daemon.log')),
          '--- raw tail ---',
          JSON.stringify(raw.slice(-1500))
        ].join('\n')
      ).toBe(true)
      expect(
        await until(() => {
          const agents = JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8')) as unknown
          return JSON.stringify(agents).includes('keep')
        })
      ).toBe(true)
    } finally {
      clearInterval(sampler)
      dashboard.write('q')
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      try {
        dashboard.kill()
      } catch {
        // gone
      }
      term.dispose()
    }
  }, 180_000)

  it('an installed release that does not start never replaces the running daemon', async () => {
    const before = daemonState()
    expect(before?.version).toBe('0.1.2')
    fixture.breakNextRelease()
    registry.setLatest('0.1.3')
    expect((await nsq('update')).stdout).toMatch(/0\.1\.3 is installed/)
    // Nothing in the way of a restart but the broken build itself.
    await nsq('stop', 'keep')
    let check = ''
    expect(
      await until(
        () => /does not start/.test(check),
        30_000,
        async () => {
          check = (await nsq('update', '--check')).stdout
        }
      )
    ).toBe(true)
    expect(check).toMatch(/installed 0\.1\.3 but it does not start \(broken build\)/)
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
    expect(daemonState()?.pid).toBe(before?.pid)
    expect(daemonState()?.version).toBe('0.1.2')
    expect(pidAlive(before!.pid)).toBe(true)
  }, 120_000)
})
