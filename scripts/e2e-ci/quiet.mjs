// "Quiet while working" in the dashboard, in a real pseudo-terminal (ConPTY on Windows). A
// stand-in Claude Code (scripts/e2e/quiet-agent.mjs, first on PATH) starts a turn through its
// hook endpoint and runs a stand-in `git push` whose password prompt waits while a spinner keeps
// turning. With quietAfter = 0.05 min (3 s):
//
//   dashboard   the header counts "1 quiet", the tile says "quiet Ns — check it" with "looks
//               like it's asking: Password for …", no y/a/n keys; the sidebar marks it
//   ls / phone  `nsq ls` says quiet, the phone API carries the hint
//   push        a local stand-in ntfy gets one push: "<agent> has been quiet for N s" + the prompt
//   ring        (--native-notify: no notification server on the runner) BEL + OSC 9 "is quiet"
//   input       Enter on the tile opens it, typing the password clears quiet at once; the turn
//               then finishes and the approvals log has the episode, ended by input
//
//   node scripts/e2e-ci/quiet.mjs --root <repo under test> --work <scratch> [--out <dir>] [--native-notify]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  args,
  loadE2e,
  makeChecks,
  makeLog,
  makeNsq,
  rootFrom,
  sleep,
  stopDaemon,
  writeChecks
} from './lib.mjs'

const { get, has } = args()
const root = rootFrom(get)
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `quiet-${Date.now()}`)))
const out = resolve(get('out', work))
mkdirSync(work, { recursive: true })
mkdirSync(out, { recursive: true })
const log = makeLog()
const { rows: checks, check } = makeChecks(log)
const cols = 120
const rows = 36
const nativeNotify = has('native-notify')

const pty = createRequire(join(root, 'apps', 'cli', 'package.json'))('node-pty')
const { createTermView, gridToText } = await import(
  pathToFileURL(join(root, 'packages', 'term-view', 'dist', 'index.js')).href
)

// The local stand-in for ntfy.
const pushes = []
const ntfy = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    try {
      pushes.push(JSON.parse(body))
    } catch {
      pushes.push({ raw: body })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((done) => ntfy.listen(0, '127.0.0.1', done))

const e2e = await loadE2e(root)
const sandbox = e2e.makeSandbox(join(work, 'sandbox'), 'http://127.0.0.1:9')
const home = sandbox.env.NSQ_HOME
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'config.json'), JSON.stringify({ quietAfter: 0.05 }))
// The stand-in claude, ahead of any real one.
const shim = join(work, 'bin')
mkdirSync(shim, { recursive: true })
const agentScript = join(root, 'scripts', 'e2e', 'quiet-agent.mjs')
if (process.platform === 'win32')
  writeFileSync(join(shim, 'claude.cmd'), `@"${process.execPath}" "${agentScript}" %*\r\n`)
else
  writeFileSync(
    join(shim, 'claude'),
    `#!/bin/sh\nexec "${process.execPath}" "${agentScript}" "$@"\n`,
    {
      mode: 0o755
    }
  )
const pathKey = Object.keys(sandbox.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
const env = {
  ...sandbox.env,
  [pathKey]: [shim, sandbox.env[pathKey] ?? process.env[pathKey] ?? ''].join(delimiter),
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  NSQ_IMAGES: '0',
  NSQ_NO_NOTIFY: nativeNotify ? '0' : '1',
  NSQ_NO_UPDATE: '1',
  NSQ_KEYRING: 'memory',
  NSQ_NTFY_URL: `http://127.0.0.1:${ntfy.address().port}/nsq-e2e-quiet`
}
delete env.TERM_PROGRAM
delete env.WT_SESSION
if (nativeNotify) {
  // Notifications on, but no display to show one: the dashboard must ring its terminal instead.
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
}
const { bin, nsq, agentNamed } = makeNsq(root, env, sandbox.project, log)

const view = createTermView({ cols, rows })
let raw = ''
let term
let exitCode = null
const screen = async () => {
  await view.flush()
  return gridToText(view.snapshot())
}
const until = async (test, ms = 20_000) => {
  const deadline = Date.now() + ms
  let last = await screen()
  while (!test(last) && Date.now() < deadline) {
    await sleep(200)
    last = await screen()
  }
  return last
}
const waitFor = async (test, ms = 30_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = test()
    if (value) return value
    await sleep(300)
  }
  return undefined
}
const shot = (name) => writeFileSync(join(out, `${name}.ansi`), raw)

try {
  term = pty.spawn(process.execPath, [bin], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: sandbox.project,
    env,
    useConptyDll: true
  })
  term.onExit(({ exitCode: code }) => (exitCode = code))
  term.onData((data) => {
    // eslint-disable-next-line no-control-regex -- terminal escapes
    if (/\x1b\[0?c/.test(data)) term.write('\x1b[?62;22c')
    raw += data
    view.write(data)
  })
  await until((t) => t.includes('neurosquad'), 20_000)

  const run = nsq('run', 'claude', '--name', 'pusher')
  check('the stand-in agent starts', run.status === 0, run.stderr)
  check('it works (hook)', await waitFor(() => agentNamed('pusher')?.status === 'working'))

  // ---- the dashboard -----------------------------------------------------------------------------
  const quiet = await until((t) => /1 quiet/.test(t) && /quiet \d+s — check it/.test(t), 30_000)
  shot('quiet')
  check('the header counts the quiet agent', /◌ 1 quiet|\? 1 quiet/.test(quiet), quiet)
  check('the tile says quiet — check it', /pusher\s+◌? ?quiet \d+s — check it/.test(quiet), quiet)
  check(
    'the tile shows what it seems to ask (the git prompt)',
    quiet.includes("looks like it's asking: Password for"),
    quiet
  )
  check('no answer keys for a quiet agent', !quiet.includes('y yes · a always · n no'), quiet)
  check('the sidebar marks it', /pusher\s+quiet \d+s/.test(quiet), quiet)

  // ---- ls, phone, push ---------------------------------------------------------------------------
  const listed = agentNamed('pusher')
  check(
    'nsq ls --json: working, with quiet and the prompt',
    listed?.status === 'working' && /^Password for 'https:/.test(listed?.quiet?.asking ?? ''),
    listed
  )
  const table = nsq('ls').stdout
  check(
    'nsq ls: quiet Ns and the hint',
    /quiet \d+s/.test(table) && table.includes('asking: Password'),
    table
  )
  const on = nsq('phone', 'on', '--port', '0')
  const port = /port (\d+)/.exec(on.stdout)?.[1]
  const token = readFileSync(join(home, 'phone-token'), 'utf8').trim()
  const state = await (
    await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { authorization: `Bearer ${token}` }
    })
  ).json()
  const phoneAgent = state.agents.find((agent) => agent.name === 'pusher')
  check(
    'the phone API carries quiet and the hint',
    /Password for/.test(phoneAgent?.quiet?.asking ?? ''),
    phoneAgent
  )
  nsq('phone', 'off')
  check(
    'ntfy got one push',
    Boolean(await waitFor(() => pushes.length > 0, 10_000)) && pushes.length === 1,
    pushes
  )
  check(
    'the push names the agent, how long, and the prompt',
    /^pusher has been quiet for \d+ s$/.test(pushes[0]?.title ?? '') &&
      pushes[0]?.message === "Looks like it's asking: Password for 'https://me@git.example.com':",
    pushes[0]
  )
  if (nativeNotify) {
    // eslint-disable-next-line no-control-regex -- BEL + OSC 9
    const rings = [...raw.matchAll(/\x07\x1b\]9;([^\x07]*)\x07/g)].map((m) => m[1])
    check(
      'it rings the terminal like needs you (BEL + OSC 9)',
      rings.some((r) => r.includes('pusher is quiet')),
      rings
    )
  }

  // ---- input clears it ---------------------------------------------------------------------------
  term.write('\r') // Enter: open the selected agent
  const opened = await until((t) => t.includes('keys go to the agent'))
  check(
    'Enter opens the quiet agent: its screen and the hint',
    opened.includes('keys go to the agent') &&
      opened.includes("Password for 'https://me@git.example.com':") &&
      opened.includes("looks like it's asking"),
    opened
  )
  term.write('hunter2')
  await sleep(300)
  const typed = agentNamed('pusher')
  check(
    'typing into the agent clears quiet at once',
    typed?.status === 'working' && !typed?.quiet,
    typed
  )
  term.write('\r')
  check(
    'git got its line: the turn finishes',
    await waitFor(() => agentNamed('pusher')?.status === 'finished')
  )
  term.write('\x1d') // Ctrl+]
  const after = await until(
    (t) => !t.includes('keys go to the agent') && /pusher\s+\S+ finished/.test(t)
  )
  shot('after')
  check(
    'back in the grid: finished, and the header no longer counts it',
    /pusher\s+\S+ finished/.test(after) && !/\d quiet/.test(after),
    after
  )
  const episodes = readFileSync(join(home, 'logs', 'approvals.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === 'quiet')
  check(
    'the approvals log has the episode, ended by input',
    episodes.length === 1 && episodes[0].outcome === 'input' && episodes[0].by?.via === 'terminal',
    episodes
  )
  check('still one push', pushes.length === 1, pushes)
  term.write('q')
  for (let i = 0; i < 20 && exitCode === null; i++) await sleep(250)
  check('q quits the dashboard', exitCode === 0, { exitCode })
} catch (error) {
  check('quiet.mjs: ran', false, String(error?.stack ?? error))
} finally {
  if (exitCode === null)
    try {
      term?.kill()
    } catch {
      // gone
    }
  stopDaemon(nsq, home)
  view.dispose()
  ntfy.close()
  writeChecks(out, checks)
  if (out !== work) rmSync(work, { recursive: true, force: true })
  const failed = checks.filter((row) => !row.ok).length
  log(`${checks.length - failed}/${checks.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
