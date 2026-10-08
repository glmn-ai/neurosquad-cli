// End-to-end check of nsq with real harness CLIs against the fake model, in an
// isolated sandbox (scripts/e2e/sandbox.mjs). Per harness:
//
//   hello      a turn: working → finished
//   perm       a permission prompt: needs-input with the question text →
//              answered inline (`nsq answer yes`) → finished, the command ran
//   resume     the daemon restarts; the agent comes back on its session
//   cost       `nsq cost` matches the usage the fake reported
//   openrouter an agent on the OpenRouter recipe: every request to the
//              (fake) OpenRouter carries the attribution headers, no
//              visibility header, the key never in argv
//   worktree   an agent in its own git worktree
//
//   node scripts/e2e/run.mjs --harness claude|codex|opencode|all
//        [--work <scratch dir>] [--bin <dir with the CLIs>] [--only hello,perm]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeModel, PERM_DIR, STEP_USAGE } from './fake-model.mjs'
import { makeSandbox } from './sandbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BIN = join(ROOT, 'apps', 'cli', 'bin', 'nsq.js')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : fallback
}
const HARNESSES = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode' }
const wanted = arg('harness', 'all')
const harnesses = wanted === 'all' ? Object.keys(HARNESSES) : wanted.split(',')
const only = arg('only', '') ? new Set(arg('only').split(',')) : null
// Outside this repository: harnesses treat a folder inside a git repository as part of it.
const WORK = resolve(arg('work', join(ROOT, '..', '.nsq-e2e', `run-${Date.now()}`)))
const binDirs = arg('bin') ? [resolve(arg('bin'))] : []

mkdirSync(WORK, { recursive: true })
const t0 = Date.now()
const log = (...parts) =>
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...parts)
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail })
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  return Boolean(ok)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fake = await startFakeModel({ logFile: join(WORK, 'fake-requests.jsonl') })
log('fake model', fake.base)
const sandbox = makeSandbox(WORK, fake.base, { binDirs })
writeFileSync(join(WORK, 'env.json'), JSON.stringify({ ...sandbox.env, PATH: undefined }, null, 2))

function nsq(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: sandbox.env,
    cwd: sandbox.project,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
  if (result.status !== 0)
    log(`nsq ${args.join(' ')} → ${result.status}: ${(result.stderr || result.stdout).trim()}`)
  return result
}
const list = () => {
  const result = nsq('ls', '--json')
  try {
    return JSON.parse(result.stdout)
  } catch {
    return []
  }
}
const agentNamed = (name) => list().find((agent) => agent.name === name)

/** Polls until the agent's status is one of `kinds`; returns the agent and the statuses seen. */
async function waitStatus(name, kinds, timeoutMs = 120_000) {
  const seen = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const agent = agentNamed(name)
    const label = agent
      ? `${agent.status ?? 'none'}${agent.detail ? `:${agent.detail.slice(0, 50)}` : ''}`
      : 'missing'
    if (seen[seen.length - 1] !== label) seen.push(label)
    if (agent && kinds.includes(agent.status)) return { agent, seen }
    if (
      agent?.status === 'exited' &&
      !kinds.includes('exited') &&
      Date.now() > deadline - timeoutMs + 5000
    ) {
      return { agent, seen, exited: true }
    }
    await sleep(400)
  }
  return { agent: agentNamed(name), seen, timedOut: true }
}

const runs = (step) => !only || only.has(step)

try {
  for (const short of harnesses) {
    const harness = HARNESSES[short]
    log(`==== ${harness}`)

    if (runs('hello')) {
      const name = `${short}-hello`
      nsq('run', short, '--name', name, '[nsq:hello] say hello')
      const first = await waitStatus(name, ['working', 'finished'], 90_000)
      const done = await waitStatus(name, ['finished'], 90_000)
      check(`${short}: hello turn working → finished`, done.agent?.status === 'finished', [
        ...first.seen,
        ...done.seen
      ])
      const peek = nsq('peek', name, '-n', '60').stdout
      check(`${short}: the answer is on screen`, /NSQ_HELLO_DONE/.test(peek))
    }

    if (runs('perm')) {
      const name = `${short}-perm`
      rmSync(join(sandbox.project, PERM_DIR), { recursive: true, force: true })
      nsq('run', short, '--name', name, '[nsq:perm] make the folder')
      const asked = await waitStatus(name, ['needs-input'], 120_000)
      check(
        `${short}: permission prompt → needs you, with the question`,
        asked.agent?.status === 'needs-input' && Boolean(asked.agent?.detail),
        asked.seen
      )
      // A beat for the dialog to take keys.
      await sleep(1500)
      nsq('answer', name, 'yes')
      const done = await waitStatus(name, ['finished'], 120_000)
      check(`${short}: answered inline → finished`, done.agent?.status === 'finished', done.seen)
      check(`${short}: the approved command ran`, existsSync(join(sandbox.project, PERM_DIR)))
      if (done.agent?.status !== 'finished') log(nsq('peek', name, '-n', '40').stdout)
    }

    if (runs('resume')) {
      const name = runs('hello') ? `${short}-hello` : `${short}-resume`
      if (!runs('hello')) {
        nsq('run', short, '--name', name, '[nsq:hello] say hello')
        await waitStatus(name, ['finished'], 90_000)
      }
      nsq('down')
      check(`${short}: daemon stopped`, list().length === 0)
      nsq('up')
      const back = await waitStatus(name, ['idle', 'working', 'finished'], 60_000)
      let peek = ''
      for (let i = 0; i < 25 && !/NSQ_HELLO_DONE/.test(peek); i++) {
        await sleep(1000)
        peek = nsq('peek', name, '-n', '80').stdout
      }
      check(`${short}: agent back after a daemon restart`, back.agent?.running === true, back.seen)
      check(
        `${short}: the resumed session shows the earlier turn`,
        /NSQ_HELLO_DONE/.test(peek),
        peek.slice(-400)
      )
    }

    if (runs('cost')) {
      const rows = JSON.parse(nsq('cost', '--json').stdout || '[]').filter(
        (row) => row.harness === harness
      )
      const requests = rows.reduce((sum, row) => sum + row.requests, 0)
      const output = rows.reduce((sum, row) => sum + row.totals.output, 0)
      const scripted = fake.requests.filter(
        (r) => r.protocol && !r.side && r.usage?.output === STEP_USAGE.output
      )
      check(
        `${short}: cost read from the harness's own log`,
        requests > 0 && output >= STEP_USAGE.output,
        {
          requests,
          output,
          fakeScripted: scripted.length,
          rows: rows.map((row) => ({
            name: row.name,
            requests: row.requests,
            usd: row.usd,
            unpriced: row.unpricedRequests
          }))
        }
      )
    }

    if (runs('openrouter')) {
      const name = `${short}-or`
      const before = fake.requests.length
      nsq(
        'run',
        short,
        '--name',
        name,
        '--provider',
        'openrouter',
        '--model',
        short === 'opencode' ? 'fake-model' : 'fake/fake-model',
        '[nsq:hello] via openrouter'
      )
      const done = await waitStatus(name, ['finished'], 90_000)
      const viaOpenRouter = fake.requests.slice(before).filter((r) => r.path?.startsWith('/api/'))
      const headers = viaOpenRouter.map((r) => r.headers)
      const attributed =
        headers.length > 0 &&
        headers.every(
          (h) =>
            h['http-referer'] === 'https://neurosquad.ai/' &&
            h['x-openrouter-title'] === 'NeuroSquad' &&
            h['x-title'] === 'NeuroSquad' &&
            h['x-openrouter-categories'] === 'cli-agent,programming-app' &&
            !('x-openrouter-app-visibility' in h)
        )
      check(`${short}: OpenRouter turn finished`, done.agent?.status === 'finished', done.seen)
      check(
        `${short}: every OpenRouter request carries the attribution headers, no visibility header`,
        attributed,
        {
          requests: viaOpenRouter.length,
          sample:
            headers[0] &&
            Object.fromEntries(
              Object.entries(headers[0]).filter(([k]) =>
                /referer|title|categor|visib|authorization/i.test(k)
              )
            )
        }
      )
    }

    if (runs('worktree')) {
      const git = (...args) => execFileSync('git', args, { cwd: sandbox.project, stdio: 'ignore' })
      if (!existsSync(join(sandbox.project, '.git'))) {
        git('init', '-q')
        git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'add', '.')
        git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'init')
      }
      const name = `${short}-wt`
      nsq('run', short, '--name', name, '--worktree', '[nsq:hello] in a worktree')
      const done = await waitStatus(name, ['finished'], 90_000)
      const agent = done.agent
      check(
        `${short}: worktree agent runs in its own checkout`,
        Boolean(agent?.worktree?.branch === `nsq/${name}` && existsSync(agent.cwd)),
        agent?.worktree
      )
      nsq('rm', name, '--worktree')
      check(`${short}: rm --worktree deletes the checkout`, agent ? !existsSync(agent.cwd) : false)
    }
  }
} finally {
  nsq('down')
  // A daemon that did not stop (a failed run): by its own PID only.
  try {
    const state = JSON.parse(readFileSync(join(sandbox.env.NSQ_HOME, 'daemon.json'), 'utf8'))
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(state.pid, 'SIGKILL')
  } catch {
    // stopped
  }
  await fake.close()
  const failed = checks.filter((c) => !c.ok)
  writeFileSync(join(WORK, 'checks.json'), JSON.stringify(checks, null, 2))
  log(`${checks.length - failed.length}/${checks.length} checks passed; work dir ${WORK}`)
  process.exitCode = failed.length ? 1 : 0
}
