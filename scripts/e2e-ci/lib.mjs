// Shared helpers for the CI live e2e: the code under test lives at --root
// (a checkout of the CLI at any ref), these scripts may come from another
// checkout, so the fake model and the sandbox are loaded from --root.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const HARNESSES = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode' }

export function args(argv = process.argv.slice(2)) {
  const get = (name, fallback) => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
  }
  const has = (name) => argv.includes(`--${name}`)
  return { get, has, argv }
}

/** The repository under test (default: the one these scripts are in). */
export function rootFrom(get) {
  return resolve(get('root', join(HERE, '..', '..')))
}

export async function loadE2e(root) {
  const url = (file) => pathToFileURL(join(root, 'scripts', 'e2e', file)).href
  const fake = await import(url('fake-model.mjs'))
  const sandbox = await import(url('sandbox.mjs'))
  return { ...fake, ...sandbox }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function makeLog() {
  const t0 = Date.now()
  return (...parts) =>
    console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...parts)
}

/** Check recorder: { name, ok, detail } rows written to <work>/checks.json at the end. */
export function makeChecks(log) {
  const rows = []
  const check = (name, ok, detail) => {
    rows.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
    log(
      ok ? 'PASS' : 'FAIL',
      name,
      detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)
    )
    return Boolean(ok)
  }
  const skip = (name, why) => {
    rows.push({ name, ok: true, skipped: why })
    log('SKIP', name, why)
  }
  return { rows, check, skip }
}

export function writeChecks(work, rows) {
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'checks.json'), JSON.stringify(rows, null, 2))
}

/** `nsq` of the code under test, in the sandbox's environment. */
export function makeNsq(root, env, cwd, log) {
  const bin = join(root, 'apps', 'cli', 'bin', 'nsq.js')
  const nsq = (...cmd) => {
    const result = spawnSync(process.execPath, [bin, ...cmd], {
      env,
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true
    })
    if (result.status !== 0 && log)
      log(
        `nsq ${cmd.join(' ')} → ${result.status}: ${(result.stderr || result.stdout || '').trim()}`
      )
    return result
  }
  const list = () => {
    try {
      return JSON.parse(nsq('ls', '--json').stdout)
    } catch {
      return []
    }
  }
  const agentNamed = (name) => list().find((agent) => agent.name === name)
  /** Polls until the agent's status is one of `kinds`; returns the agent and the statuses seen. */
  const waitStatus = async (name, kinds, timeoutMs = 120_000) => {
    const seen = []
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const agent = agentNamed(name)
      const label = agent
        ? `${agent.status ?? 'none'}${agent.detail ? `:${agent.detail.slice(0, 60)}` : ''}`
        : 'missing'
      if (seen[seen.length - 1] !== label) seen.push(label)
      if (agent && kinds.includes(agent.status)) return { agent, seen }
      await sleep(400)
    }
    return { agent: agentNamed(name), seen, timedOut: true }
  }
  const help = () => nsq('--help').stdout ?? ''
  return { bin, nsq, list, agentNamed, waitStatus, help }
}

/** Stops the sandbox's daemon; one that did not stop is killed by its own PID only. */
export function stopDaemon(nsq, nsqHome) {
  const down = nsq('down')
  const stateFile = join(nsqHome, 'daemon.json')
  if (down.status === 0 && !existsSync(stateFile)) return
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(state.pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/** A screen without escape sequences, for text checks. */
export function plain(text) {
  return String(text ?? '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // eslint-disable-line no-control-regex
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '') // eslint-disable-line no-control-regex
}
