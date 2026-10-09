// Drives the dashboard in a pseudo-terminal against real harnesses and the
// fake model (sandboxed), records everything it draws, and renders
// screenshots (PNG) through packages/tui-theme's term-dump + render-frames.
//
//   node scripts/e2e/tui-shot.mjs --bin <dir with the CLIs> [--out dir] [--cols 150 --rows 42]
//        [--custom-provider <name>] [--steps "wait:6000,shot:grid,key:\r,wait:3000,shot:expanded,key:\u001d,wait:1500,shot:back"]
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'
import { startFakeModel } from './fake-model.mjs'
import { makeSandbox } from './sandbox.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(ROOT, 'apps', 'cli', 'bin', 'nsq.js')
const THEME = join(ROOT, 'packages', 'tui-theme', 'scripts')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : fallback
}
const cols = Number(arg('cols', '150'))
const rows = Number(arg('rows', '42'))
const out = resolve(arg('out', join(ROOT, '.cache', 'shots')))
const work = resolve(join(ROOT, '..', '.nsq-e2e', `shot-${Date.now()}`))
mkdirSync(out, { recursive: true })
mkdirSync(work, { recursive: true })

const fake = await startFakeModel({ logFile: join(work, 'fake-requests.jsonl') })
const sandbox = makeSandbox(work, fake.base, { binDirs: arg('bin') ? [resolve(arg('bin'))] : [] })
const env = {
  ...sandbox.env,
  COLORTERM: 'truecolor',
  TERM: 'xterm-256color',
  TERM_PROGRAM: arg('term', 'iTerm.app'),
  NSQ_ANIMATION: '1',
  NSQ_TUI_TRACE: join(out, 'input.jsonl')
}
const nsq = (...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    env,
    cwd: sandbox.project,
    encoding: 'utf8',
    windowsHide: true
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --custom-provider <name>: one of the user's own servers (the fake, every endpoint), for the
// Providers screen and the new-agent form's provider choice.
if (arg('custom-provider')) {
  const added = await new Promise((resolveAdd) => {
    const child = spawn(
      process.execPath,
      [BIN, 'provider', 'add', arg('custom-provider'), '--url', `${fake.base}/v1`],
      { env, cwd: sandbox.project, windowsHide: true }
    )
    child.on('close', resolveAdd)
  })
  if (added !== 0) {
    await fake.close()
    throw new Error(`nsq provider add exited ${added}: no capture without the provider`)
  }
}

const agents = arg(
  'agents',
  'claude:api-fix:[nsq:hello] fix the flaky test,codex:reviewer:[nsq:perm] tidy up,opencode:docs:[nsq:hello] update the docs'
).split(',')
for (const spec of agents.filter(Boolean)) {
  const [harness, name, ...rest] = spec.split(':')
  const prompt = rest.join(':')
  nsq('run', harness, '--name', name, prompt)
}
await sleep(Number(arg('settle', '12000')))

// --phone: phone access on and one phone (an iPhone user agent) holding the event stream open,
// so the shots show who is connected.
const phoneStream = new AbortController()
if (argv.includes('--phone')) {
  const on = nsq('phone', 'on', '--port', '0')
  const port = /port (\d+)/.exec(on.stdout)?.[1]
  const token = (await import('node:fs'))
    .readFileSync(join(sandbox.env.NSQ_HOME, 'phone-token'), 'utf8')
    .trim()
  void fetch(`http://127.0.0.1:${port}/api/events`, {
    signal: phoneStream.signal,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    }
  })
    .then((response) => response.body?.getReader().read())
    .catch(() => {})
  await sleep(500)
}

const raw = join(out, 'session.ansi')
writeFileSync(raw, '')
const term = pty.spawn(process.execPath, [BIN], {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: sandbox.project,
  env,
  useConptyDll: true
})
term.onData((data) => appendFileSync(raw, data))
const shots = []
const steps = arg(
  'steps',
  'wait:5000,shot:grid,key:\\r,wait:3500,shot:expanded,key:\\u001d,wait:1500,shot:back'
).split(',')
try {
  for (const step of steps) {
    const [kind, ...rest] = step.split(':')
    const value = rest.join(':')
    if (kind === 'wait') await sleep(Number(value))
    else if (kind === 'key') term.write(JSON.parse(`"${value}"`))
    else if (kind === 'shot') {
      const file = join(out, `${value}.ansi`)
      // Everything drawn so far, replayed, is the screen at this moment.
      execFileSync(process.execPath, [
        '-e',
        `require('fs').copyFileSync(${JSON.stringify(raw)}, ${JSON.stringify(file)})`
      ])
      shots.push(value)
    }
  }
} finally {
  phoneStream.abort()
  term.write('q')
  await sleep(1000)
  try {
    term.kill()
  } catch {}
  nsq('down')
  await fake.close()
}
for (const name of shots) {
  const json = join(out, `${name}.json`)
  execFileSync(
    process.execPath,
    [
      join(THEME, 'term-dump.mjs'),
      join(out, `${name}.ansi`),
      json,
      `--cols=${cols}`,
      `--rows=${rows}`
    ],
    { stdio: 'inherit', cwd: join(ROOT, 'packages', 'tui-theme') }
  )
  // python3 first (macOS and many Linux distributions have no `python`), then python. Each is
  // tried in turn: on Windows `python3` may be the Store's placeholder, which only fails.
  let rendered = false
  const failures = []
  for (const python of [arg('python'), 'python3', 'python'].filter(Boolean)) {
    try {
      execFileSync(python, [join(THEME, 'render-frames.py'), json, join(out, `${name}.png`)], {
        stdio: ['ignore', 'inherit', 'pipe']
      })
      rendered = true
      break
    } catch (error) {
      const reason =
        error.code === 'ENOENT'
          ? 'not found'
          : String(error.stderr || error.message)
              .trim()
              .split('\n')
              .at(-1)
      failures.push(`${python}: ${reason}`)
    }
  }
  if (!rendered) {
    console.error(
      `no PNG: Python 3 with Pillow is needed (--python <path>); tried ${failures.join('; ')}`
    )
  }
}
console.log(`shots in ${out}`)
