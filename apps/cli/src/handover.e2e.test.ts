// A newer nsq meeting an older running daemon (npx picked a new release, or `npm i -g` upgraded
// the package under it): the first command of the newer copy restarts the daemon on itself —
// unless an agent is busy, then it says so and the daemon does it once the agents are free.
// Two copies of the built CLI at different versions (scripts/e2e/update-fixture.mjs), one nsq
// home. (Daemons from before the hand-over request are covered by the live e2e, `handover`.)
// Needs the built CLI (`npm run build`).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const built = existsSync(join(ROOT, 'apps', 'cli', 'dist', 'bin.js'))

interface Copy {
  bin: string
  packageDir: string
}
interface Registry {
  base: string
  close(): Promise<void>
}

let work = ''
let home = ''
let older: Copy
let newer: Copy
let registry: Registry

const run = (
  copy: Copy,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveRun) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) if (/^NSQ_/.test(key)) delete env[key]
    const child = spawn(process.execPath, [copy.bin, ...args], {
      cwd: work,
      windowsHide: true,
      env: {
        ...env,
        NSQ_HOME: home,
        NSQ_NO_NOTIFY: '1',
        NSQ_RESTART_PAUSE_MS: '300',
        // No release to find: the updater stays out of this.
        NSQ_UPDATE_REGISTRY: registry.base
      }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), 120_000)
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
async function until(check: () => Promise<boolean> | boolean, ms = 45_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
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
interface Row {
  name: string
  running: boolean
  status?: string
}
const list = async (copy: Copy): Promise<Row[]> => {
  try {
    return JSON.parse((await run(copy, 'ls', '--json')).stdout) as Row[]
  } catch {
    return []
  }
}

const IDLE = 'setInterval(() => {}, 1000); console.log("ready")'
/** Output all the time: the agent counts as working. */
const BUSY = 'setInterval(() => console.log("tick " + Date.now()), 200)'

describe.skipIf(!built)('an older daemon is handed over to a newer nsq', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'nsq-handover-e2e-'))
    home = join(work, 'home')
    const helpers = (await import(
      pathToFileURL(join(ROOT, 'scripts', 'e2e', 'update-fixture.mjs')).href
    )) as {
      makeInstalledCopy(options: object): Copy
      startFakeRegistry(options: object): Promise<Registry>
    }
    registry = await helpers.startFakeRegistry({ latest: '0.1.0' })
    for (const dir of ['old', 'new']) mkdirSync(join(work, dir))
    older = helpers.makeInstalledCopy({
      root: ROOT,
      work: join(work, 'old'),
      version: '0.1.0',
      registry: registry.base
    })
    newer = helpers.makeInstalledCopy({
      root: ROOT,
      work: join(work, 'new'),
      version: '0.1.1',
      registry: registry.base
    })
  })

  afterAll(async () => {
    if (newer) await run(newer, 'down')
    const state = daemonState()
    if (state && pidAlive(state.pid)) process.kill(state.pid)
    await registry?.close()
    // The dependency links first: never follow them into the repository's node_modules.
    for (const copy of [older, newer]) {
      try {
        if (copy) unlinkSync(join(copy.packageDir, 'node_modules'))
      } catch {
        // already gone
      }
    }
    rmSync(work, { recursive: true, force: true })
  })

  it('waits for a busy agent, then restarts on the newer copy; the agents come back', async () => {
    expect(
      (await run(older, 'run', '--name', 'idle', '--', process.execPath, '-e', IDLE)).status
    ).toBe(0)
    expect(
      (await run(older, 'run', '--name', 'busy', '--', process.execPath, '-e', BUSY)).status
    ).toBe(0)
    const first = daemonState()
    expect(first?.version).toBe('0.1.0')
    expect(
      await until(async () => {
        const agents = await list(older)
        return (
          agents.some((a) => a.name === 'busy' && a.status === 'working') &&
          agents.some((a) => a.name === 'idle' && a.status === 'finished')
        )
      })
    ).toBe(true)

    // Busy: the newer copy runs its command on the old daemon and says why it did not restart.
    const waiting = await run(newer, 'ls')
    expect(waiting.status, waiting.stderr).toBe(0)
    expect(waiting.stderr).toMatch(
      /the daemon is 0\.1\.0, this nsq is 0\.1\.1 — it restarts on it when they are free \(busy is working;/
    )
    expect(daemonState()?.pid).toBe(first?.pid)

    // Free: the daemon (it was asked) restarts on 0.1.1 by itself — no further command needed.
    expect((await run(older, 'stop', 'busy')).status).toBe(0)
    expect(
      await until(() => {
        const state = daemonState()
        return state !== null && state.pid !== first?.pid && state.version === '0.1.1'
      }, 60_000)
    ).toBe(true)
    expect(pidAlive(first!.pid)).toBe(false)
    expect(
      await until(async () => (await list(newer)).some((a) => a.name === 'idle' && a.running))
    ).toBe(true)
    // Same version now: nothing more to say.
    const after = await run(newer, 'ls')
    expect(after.stderr).toBe('')
    // An older copy never takes the daemon back.
    const back = await run(older, 'ls')
    expect(back.stderr).toBe('')
    expect(daemonState()?.version).toBe('0.1.1')
  }, 240_000)
})
