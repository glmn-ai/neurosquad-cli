// Records the dashboard (`nsq` with no arguments) in a real pseudo-terminal of
// this OS (ConPTY on Windows) while it drives three real agents against the
// fake model, and checks what it did:
//
//   the dashboard opens; three agents appear as live tiles; one asks for a
//   permission → "needs you" and the dashboard rings its terminal (BEL + OSC 9,
//   the fallback when no desktop notification can show); Enter opens an agent
//   full screen, Ctrl+] goes back to the grid; `l` selects the waiting agent,
//   `y` answers it → it finishes and the approved command ran; `q` quits.
//
// Output (--out): dashboard.cast (asciicast v2, for agg → GIF), <shot>.ansi
// (everything drawn up to that moment, for tui-theme's term-dump → PNG),
// checks.json.
//
//   node scripts/e2e-ci/tui-record.mjs --root <repo under test> --bin <dir with the CLIs>
//        --out <dir> [--cols 140 --rows 38] [--native-notify] [--headless-check] [--display :99]
//        [--project <dir>]
//        [--agents "claude:api-fix:[nsq:hello] …,codex:reviewer:[nsq:perm] …,opencode:docs:[nsq:hello] …"]
//
// --native-notify keeps desktop notifications on (a headless Linux has no
// notification server, so the dashboard must still ring); without it they are
// switched off (NSQ_NO_NOTIFY=1), which silences the ring too. --headless-check first runs the
// dashboard with no X display (SSH, servers): it must keep running and keep
// native noise off the screen; --display then records against a virtual X server.
// --project is the folder the agents work in, shown in the recording (default: on
// GitHub Actions ~/demo-shop of the runner, so the GIF shows a clean name; else a
// folder in the scratch work dir). Created for the run and removed afterwards.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  args,
  loadE2e,
  makeChecks,
  makeLog,
  makeNsq,
  plain,
  rootFrom,
  sleep,
  stopDaemon,
  writeChecks
} from './lib.mjs'

const { get, has } = args()
const root = rootFrom(get)
const out = resolve(get('out', join(root, '..', '.nsq-e2e', 'tui-record')))
const work = resolve(get('work', join(out, 'work')))
const cols = Number(get('cols', '140'))
const rows = Number(get('rows', '38'))
// Never delete a folder this script did not make: a --work or --project of the caller
// must be new (or an empty folder); only the default scratch under --out is wiped.
const refuseExisting = (dir, option) => {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    console.error(`tui-record: ${option} ${dir} exists and is not empty; pass a new folder`)
    process.exit(2)
  }
}
if (get('work')) refuseExisting(work, '--work')
mkdirSync(out, { recursive: true })
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const log = makeLog()
const { rows: checks, check, skip } = makeChecks(log)
if (!existsSync(join(root, 'apps', 'cli', 'src', 'tui'))) {
  // A build from before the dashboard: `nsq` alone lists agents.
  skip('dashboard', 'this build has no dashboard')
  writeChecks(out, checks)
  process.exit(0)
}
if (has('native-notify')) process.env.NSQ_E2E_NOTIFY = '1'
const e2e = await loadE2e(root)
const fake = await e2e.startFakeModel({ logFile: join(out, 'fake-requests.jsonl') })
const sandbox = e2e.makeSandbox(work, fake.base, {
  binDirs: get('bin') ? [resolve(get('bin'))] : []
})
const env = {
  ...sandbox.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  // Logos as glyph badges: a recording renders cells, not inline images.
  NSQ_IMAGES: '0'
}
delete env.TERM_PROGRAM
delete env.WT_SESSION
// --display <X display>: record against a virtual X server (Linux CI), after the headless check.
if (get('display')) env.DISPLAY = get('display')
const project = get('project')
  ? resolve(get('project'))
  : process.env.GITHUB_ACTIONS
    ? join(homedir(), 'demo-shop')
    : sandbox.project
const ownProject = project !== sandbox.project
if (ownProject) {
  refuseExisting(project, get('project') ? '--project' : '~/demo-shop')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'README.md'), '# demo-shop\n\nA small web shop.\n')
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'demo-shop', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`
  )
}
const { bin, nsq, waitStatus, agentNamed } = makeNsq(root, env, project, log)
const pty = createRequire(join(root, 'apps', 'cli', 'package.json'))('node-pty')

const agents = get(
  'agents',
  'claude:api-fix:[nsq:hello] fix the flaky test,codex:reviewer:[nsq:perm] tidy up the build folder,opencode:docs:[nsq:hello] update the docs'
)
  .split(',')
  .filter(Boolean)
  .map((spec) => {
    const [harness, name, ...rest] = spec.split(':')
    return { harness, name, prompt: rest.join(':') }
  })
const asking = agents.find((agent) => /\[nsq:perm\]/.test(agent.prompt))

// ---- headless: no X display, as over SSH or on a server ----------------------------------
if (has('headless-check')) {
  const headless = { ...env }
  delete headless.DISPLAY
  delete headless.WAYLAND_DISPLAY
  let text = ''
  let code = null
  const probe = pty.spawn(process.execPath, [bin], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: project,
    env: headless
  })
  probe.onData((data) => {
    if (/\x1b\[0?c/.test(data)) probe.write('\x1b[?62;22c') // eslint-disable-line no-control-regex
    text += data
  })
  probe.onExit(({ exitCode: exit }) => {
    code = exit
  })
  await sleep(6000)
  const alive = code === null
  const stray = /XOpenDisplay|hook_thread_proc|Could not set thread priority/.exec(text)?.[0]
  check(
    'without an X display the dashboard keeps running and draws only its own screen',
    alive && !stray,
    {
      exitedWith: code,
      stray,
      tail: plain(text).trim().slice(-240)
    }
  )
  if (alive) {
    probe.write('q')
    for (let i = 0; i < 20 && code === null; i++) await sleep(250)
    if (code === null)
      try {
        probe.kill()
      } catch {}
  }
}

// ---- recording ---------------------------------------------------------------------------
const cast = join(out, 'dashboard.cast')
const raw = join(out, 'dashboard.ansi')
writeFileSync(
  cast,
  `${JSON.stringify({
    version: 2,
    width: cols,
    height: rows,
    timestamp: Math.floor(Date.now() / 1000),
    idle_time_limit: 2,
    title: `nsq dashboard (${process.platform}-${process.arch})`,
    env: { TERM: env.TERM, SHELL: process.platform === 'win32' ? 'pwsh' : '/bin/bash' }
  })}\n`
)
writeFileSync(raw, '')
let output = ''
let started = 0
const term = pty.spawn(process.execPath, [bin], {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: project,
  env,
  useConptyDll: true
})
started = Date.now()
let exitCode = null
term.onExit(({ exitCode: code }) => {
  exitCode = code
})
term.onData((data) => {
  // Be the terminal: answer Device Attributes (ConPTY and the dashboard ask at start).
  // eslint-disable-next-line no-control-regex -- terminal escapes
  if (/\x1b\[0?c/.test(data)) term.write('\x1b[?62;22c')
  output += data
  appendFileSync(raw, data)
  appendFileSync(cast, `${JSON.stringify([(Date.now() - started) / 1000, 'o', data])}\n`)
})
const press = (keys, label) => {
  log('key', label ?? JSON.stringify(keys))
  term.write(keys)
}
const shots = []
const shot = (name) => {
  copyFileSync(raw, join(out, `${name}.ansi`))
  shots.push(name)
  log('shot', name)
}

try {
  const opened = () => output.includes('\x1b[?1049h')
  for (let i = 0; i < 80 && !opened(); i++) await sleep(250)
  const firstFrameMs = Date.now() - started
  await sleep(1500)
  check('dashboard opens and draws', opened() && output.length > 500, {
    firstFrameMs,
    bytes: output.length
  })

  for (const agent of agents) {
    nsq('run', agent.harness, '--name', agent.name, agent.prompt)
    await sleep(1200)
  }
  // Everyone at work: the "needs you" one waits, the others finish.
  const waiting = asking
    ? await waitStatus(asking.name, ['needs-input'], 150_000)
    : { agent: undefined, seen: [] }
  if (asking)
    check(
      `${asking.harness} asks → needs you (seen by the dashboard's daemon)`,
      waiting.agent?.status === 'needs-input',
      waiting.seen
    )
  for (const agent of agents.filter((a) => a !== asking))
    await waitStatus(agent.name, ['finished'], 90_000)
  await sleep(2500)
  shot('grid')
  check(
    'the grid shows every agent',
    exitCode === null && agents.every((agent) => plain(output).includes(agent.name)),
    { exitCode, missing: agents.filter((a) => !plain(output).includes(a.name)).map((a) => a.name) }
  )
  // The fallback when no desktop notification can show: BEL + OSC 9 with the text.
  // Notifications switched off (NSQ_NO_NOTIFY=1) silence it as well.
  // eslint-disable-next-line no-control-regex -- terminal escapes
  const rings = [...output.matchAll(/\x07\x1b\]9;([^\x07]*)\x07/g)].map((m) => m[1])
  if (has('native-notify')) {
    check(
      'needs you rings the terminal (BEL + OSC 9)',
      asking
        ? rings.some((text) => text.includes(asking.name) && /needs you/.test(text))
        : rings.length > 0,
      rings
    )
  } else {
    check('notifications off: needs you does not ring the terminal', rings.length === 0, rings)
  }

  // The first agent full screen, then back to the grid.
  press('\r', 'Enter (open full screen)')
  await sleep(3500)
  shot('expanded')
  press('\x1d', 'Ctrl+] (back to the grid)')
  await sleep(2500)

  if (asking) {
    // Selection starts on the first agent; the waiting one is the next tile.
    const steps = agents.indexOf(asking)
    for (let i = 0; i < steps; i++) {
      press('l', 'l (next agent)')
      await sleep(700)
    }
    await sleep(1200)
    shot('needs-you')
    press('y', 'y (answer yes)')
    const done = await waitStatus(asking.name, ['finished'], 90_000)
    check(
      `answered from the dashboard → ${asking.name} finished, the command ran`,
      done.agent?.status === 'finished' && existsSync(join(project, e2e.PERM_DIR)),
      done.seen
    )
    await sleep(3000)
    shot('answered')
  }

  check('the dashboard is still running before q', exitCode === null, { exitCode })
  press('q', 'q (quit; agents keep running)')
  for (let i = 0; i < 20 && exitCode === null; i++) await sleep(250)
  check('q quits the dashboard', exitCode === 0, { exitCode })
  check(
    'agents keep running after the dashboard quits',
    agents.every((agent) => agentNamed(agent.name)?.running === true)
  )
} catch (error) {
  check('tui-record.mjs: crashed', false, String(error?.stack ?? error))
} finally {
  if (exitCode === null)
    try {
      term.kill()
    } catch {}
  stopDaemon(nsq, sandbox.env.NSQ_HOME)
  await Promise.race([fake.close(), sleep(3000)])
  writeFileSync(
    join(out, 'shots.json'),
    JSON.stringify({ cols, rows, shots, platform: `${process.platform}-${process.arch}` }, null, 2)
  )
  writeChecks(out, checks)
  rmSync(work, { recursive: true, force: true })
  if (ownProject) rmSync(project, { recursive: true, force: true })
  const failed = checks.filter((row) => !row.ok).length
  log(`${checks.length - failed}/${checks.length} checks passed; recording in ${out}`)
  process.exit(failed ? 1 : 0)
}
