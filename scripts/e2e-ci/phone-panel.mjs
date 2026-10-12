// The dashboard's phone panel (Q) in a real pseudo-terminal, read the way a phone camera reads
// it: everything the dashboard draws goes through a terminal emulator (term-view), the screen
// becomes a picture and a QR decoder (jsQR) reads the code off it. Part of the dashboard suite.
//
//   pairing     Q shows the LAN pairing QR → it decodes to the link with the token in the
//               token file; the token never shows in the main view
//   online      o, y in the panel → online through a fake cloudflared
//               (scripts/e2e/fake-cloudflared.mjs) → the QR is the https tunnel link
//   rotate      r, y → a new token, the QR follows it
//   ntfy        Tab, s → a topic on a local stand-in ntfy server (NSQ_NTFY_SERVER, never ntfy.sh;
//               secrets in memory, NSQ_KEYRING=memory — no OS keyring) → the QR is the ntfy://
//               subscribe link; i → the https topic for an iPhone; t → the test reaches the server
//   old daemon  a daemon of nsq 0.3.0 (the real release from npm, before push) kept running by a
//               busy agent: Q, Tab → the panel says which daemon runs and what push needs (never
//               a bare "unknown request") and offers U; U, y → the daemon restarts on this nsq, the
//               panel opens again on Notifications, and s sets push up
//
//   node scripts/e2e-ci/phone-panel.mjs --root <repo under test> --work <scratch> [--out <dir>]
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
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

const { get } = args()
const root = rootFrom(get)
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `phone-panel-${Date.now()}`)))
const out = resolve(get('out', work))
mkdirSync(work, { recursive: true })
mkdirSync(out, { recursive: true })
const log = makeLog()
const { rows: checks, check } = makeChecks(log)
const cols = 120
const rows = 36

const requireRoot = createRequire(join(root, 'package.json'))
const pty = createRequire(join(root, 'apps', 'cli', 'package.json'))('node-pty')
const jsQR = requireRoot('jsqr')
const { createTermView, gridToText } = await import(
  pathToFileURL(join(root, 'packages', 'term-view', 'dist', 'index.js')).href
)
const { gridPicture } = await import(
  pathToFileURL(join(root, 'apps', 'cli', 'dist', 'tui', 'screenshot.js')).href
)

// A stand-in ntfy server: records what nsq publishes.
const posts = []
const ntfy = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    try {
      posts.push({ path: req.url, body: JSON.parse(body) })
    } catch {
      posts.push({ path: req.url, body })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((r) => ntfy.listen(0, '127.0.0.1', r))
const ntfyServer = `http://127.0.0.1:${ntfy.address().port}`

const e2e = await loadE2e(root)
const sandbox = e2e.makeSandbox(join(work, 'sandbox'), 'http://127.0.0.1:9')
const home = sandbox.env.NSQ_HOME
const fakeDir = join(work, 'fake')
mkdirSync(fakeDir, { recursive: true })
copyFileSync(
  join(root, 'scripts', 'e2e', 'fake-cloudflared.mjs'),
  join(fakeDir, 'fake-cloudflared.mjs')
)
const env = {
  ...sandbox.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  NSQ_IMAGES: '0',
  NSQ_NO_NOTIFY: '1',
  NSQ_KEYRING: 'memory',
  NSQ_NTFY_SERVER: ntfyServer,
  NSQ_CLOUDFLARED: join(fakeDir, 'fake-cloudflared.mjs')
}
delete env.TERM_PROGRAM
delete env.WT_SESSION
const { bin, nsq } = makeNsq(root, env, work, log)
const token = () => {
  const file = join(home, 'phone-token')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

const view = createTermView({ cols, rows })
let raw = ''
let term
let exitCode = null
const screen = async () => {
  await view.flush()
  const grid = view.snapshot()
  const picture = gridPicture(grid)
  return {
    text: gridToText(grid),
    qr: jsQR(picture.data, picture.width, picture.height)?.data
  }
}
/** Polls the screen until `test` holds (or the time is up); returns the last screen. */
const until = async (test, ms = 15_000) => {
  const deadline = Date.now() + ms
  let last = await screen()
  while (!test(last) && Date.now() < deadline) {
    await sleep(250)
    last = await screen()
  }
  return last
}
const shot = (name) => writeFileSync(join(out, `${name}.ansi`), raw)
const press = (keys) => term.write(keys)
/** The dashboard of the code under test in a pty, its screen into `view`. */
const openDashboard = (dashboardEnv) => {
  exitCode = null
  term = pty.spawn(process.execPath, [bin], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: work,
    env: dashboardEnv,
    useConptyDll: true
  })
  term.onExit(({ exitCode: code }) => (exitCode = code))
  term.onData((data) => {
    // eslint-disable-next-line no-control-regex -- terminal escapes
    if (/\x1b\[0?c/.test(data)) term.write('\x1b[?62;22c')
    raw += data
    view.write(data)
  })
}

// ---- an older daemon (nsq 0.3.0, before push) --------------------------------------------------
const OLD = '0.3.0'
const oldHome = join(work, 'old-home')
const oldEnv = {
  ...env,
  NSQ_HOME: oldHome,
  // The old daemon must never update itself from npm.
  NSQ_NO_UPDATE: '1',
  NSQ_UPDATE_REGISTRY: 'http://127.0.0.1:9'
}
let oldBin = ''
const oldNsq = (...cmd) =>
  spawnSync(process.execPath, [oldBin, ...cmd], {
    env: oldEnv,
    cwd: work,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
const oldAgent = (name) => {
  try {
    return JSON.parse(oldNsq('ls', '--json').stdout).find((agent) => agent.name === name)
  } catch {
    return undefined
  }
}
const oldState = () => {
  try {
    return JSON.parse(readFileSync(join(oldHome, 'daemon.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The owner's case: the dashboard of a newer nsq on a daemon its hand-over cannot restart yet
 * (an agent is busy). The phone panel's push needs a newer daemon: it says so and offers U.
 */
async function oldDaemonScenario() {
  const prefix = join(work, `nsq-${OLD}`)
  mkdirSync(prefix, { recursive: true })
  // One command line (no arguments array): a shell is needed for npm.cmd on Windows.
  const npm = spawnSync(
    `npm install --prefix "${prefix}" neurosquad@${OLD} --no-audit --no-fund --loglevel=error`,
    { encoding: 'utf8', timeout: 300_000, shell: true, windowsHide: true }
  )
  oldBin = join(prefix, 'node_modules', 'neurosquad', 'bin', 'nsq.js')
  check(
    `old daemon: nsq ${OLD} installed from npm`,
    npm.status === 0 && existsSync(oldBin),
    npm.stderr
  )
  if (!existsSync(oldBin)) return

  // A busy agent keeps the old daemon from restarting: a command speaking the herdr protocol,
  // waiting for an answer (a state that holds still).
  const fakeAgent = join(root, 'scripts', 'e2e', 'fake-herdr-agent.mjs')
  const run = oldNsq('run', '--name', 'busy', '--', process.execPath, fakeAgent, '--mode', 'cli')
  check(`old daemon: nsq ${OLD} runs the daemon and an agent`, run.status === 0, run.stderr)
  const waitOld = async (status, ms = 30_000) => {
    const deadline = Date.now() + ms
    while (oldAgent('busy')?.status !== status && Date.now() < deadline) await sleep(400)
    return oldAgent('busy')?.status === status
  }
  await waitOld('idle')
  oldNsq('send', 'busy', 'go')
  const busy = await waitOld('needs-input')
  const first = oldState()
  check('old daemon: its agent is busy (needs you)', busy && first?.version === OLD, {
    status: oldAgent('busy')?.status,
    version: first?.version
  })

  raw = ''
  openDashboard(oldEnv)
  const main = await until((s) => /neurosquad/.test(s.text), 30_000)
  check(
    'old daemon: the dashboard opens on it and the hand-over waits for the busy agent',
    /neurosquad/.test(main.text) && oldState()?.pid === first?.pid,
    main.text.slice(0, 300)
  )
  press('Q')
  await until((s) => s.text.includes('Pairing'))
  press('\t')
  const outdated = await until((s) => s.text.includes('need a newer daemon'))
  shot('panel-old-daemon')
  const flat = (text) => text.replace(/\s+/g, ' ')
  check(
    'old daemon: Notifications says which daemon runs and what push needs, and offers U',
    flat(outdated.text).includes('The running daemon is nsq 0.3.0; this needs 0.4.0') &&
      flat(outdated.text).includes('Press U to restart it now') &&
      outdated.text.includes('restart the daemon now'),
    outdated.text
  )
  press('s')
  await sleep(1000)
  const pressed = await screen()
  check(
    'old daemon: s never shows a bare "unknown request"',
    !/unknown request/i.test(pressed.text) && oldState()?.pid === first?.pid,
    pressed.text
  )
  press('U')
  await until((s) => s.text.includes('Restart the daemon'))
  press('y')
  const reopened = await until(
    (s) => s.text.includes('Phone notifications are off') && oldState()?.pid !== first?.pid,
    120_000
  )
  const after = oldState()
  shot('panel-old-daemon-restarted')
  check(
    'old daemon: U, y restarts the daemon on this nsq and opens Notifications again',
    reopened.text.includes('Phone notifications are off') &&
      after?.pid !== first?.pid &&
      Boolean(after?.version) &&
      after?.version !== OLD,
    { version: after?.version, text: reopened.text.slice(0, 600) }
  )
  press('s')
  const android = await until((s) => s.qr?.startsWith('ntfy://') ?? false, 20_000)
  check(
    'old daemon: after the restart, s sets push up (the ntfy QR)',
    /^ntfy:\/\/127\.0\.0\.1:\d+\/nsq-[0-9a-f]{24}\?/.test(android.qr ?? ''),
    { qr: android.qr }
  )
  press('\x1b')
  await until((s) => !s.text.includes('Notifications'))
  press('q')
  for (let i = 0; i < 20 && exitCode === null; i++) await sleep(250)
  check('old daemon: q quits the dashboard', exitCode === 0, { exitCode })
}

try {
  const on = nsq('phone', 'on', '--lan', '--port', '0')
  check('phone access on for the LAN', on.status === 0, on.stderr || on.stdout)
  const status = nsq('phone', 'status').stdout
  const port = /port (\d+)/.exec(status)?.[1]

  openDashboard(env)
  const main = await until((s) => /neurosquad/.test(s.text))
  check('the dashboard opens', /neurosquad/.test(main.text), main.text.slice(0, 300))
  check('the main view never shows the pairing token', !main.text.includes(token()))

  // ---- pairing: the LAN link -------------------------------------------------------------
  press('Q')
  const lan = await until((s) => Boolean(s.qr))
  shot('panel-lan')
  check(
    'Q: the QR on the screen decodes to the LAN pairing link',
    new RegExp(`^http://[0-9.]+:${port}/\\?t=${token()}$`).test(lan.qr ?? ''),
    { qr: lan.qr, port }
  )
  check('Q: mode "Local network"', lan.text.includes('Local network'))

  // ---- online through the (fake) tunnel ----------------------------------------------------
  press('o')
  await until((s) => s.text.includes('Go online?'))
  press('y')
  const tunnel = 'https://fake-e2e-tunnel.trycloudflare.com'
  const online = await until((s) => s.qr?.startsWith(tunnel) ?? false, 30_000)
  shot('panel-online')
  check(
    'online: the QR is the https tunnel link with the token',
    online.qr === `${tunnel}/?t=${token()}`,
    {
      qr: online.qr
    }
  )
  check('online: the mode says ONLINE', online.text.includes('ONLINE'))

  // ---- a new token ---------------------------------------------------------------------------
  const before = token()
  press('r')
  await until((s) => s.text.includes('New pairing token?'))
  press('y')
  const rotated = await until((s) => Boolean(s.qr) && !s.qr.includes(before))
  check(
    'rotate: the QR follows the new token',
    token() !== before && rotated.qr === `${tunnel}/?t=${token()}`,
    { qr: rotated.qr }
  )

  // ---- notifications ---------------------------------------------------------------------
  press('\t')
  await until((s) => s.text.includes('Phone notifications are off'))
  press('s')
  const android = await until((s) => s.qr?.startsWith('ntfy://') ?? false)
  shot('panel-ntfy')
  const topic = /\/(nsq-[0-9a-f]{24})\?/.exec(android.qr ?? '')?.[1]
  check(
    'ntfy: the QR is the Android subscribe link on the local server',
    Boolean(topic) &&
      android.qr === `ntfy://127.0.0.1:${ntfy.address().port}/${topic}?display=nsq&secure=false`,
    { qr: android.qr }
  )
  press('i')
  const iphone = await until((s) => s.qr?.startsWith('http') ?? false)
  check('ntfy: i shows the https topic for an iPhone', iphone.qr === `${ntfyServer}/${topic}`, {
    qr: iphone.qr
  })
  press('t')
  const tested = await until((s) => s.text.includes('delivered'))
  check(
    'ntfy: t sends a test to the topic',
    posts.some((p) => p.body?.topic === topic) && tested.text.includes('delivered'),
    { posts: posts.length }
  )

  // ---- closing forgets the secrets ---------------------------------------------------------
  press('\x1b')
  const closed = await until((s) => !s.text.includes('Notifications'))
  check(
    'Esc closes the panel; no token or topic left on the screen',
    !closed.text.includes(token()) && !closed.text.includes(topic ?? '-'),
    closed.text.slice(0, 400)
  )
  press('q')
  for (let i = 0; i < 20 && exitCode === null; i++) await sleep(250)
  check('q quits the dashboard', exitCode === 0, { exitCode })

  await oldDaemonScenario()
} catch (error) {
  check('phone-panel.mjs: ran', false, String(error?.stack ?? error))
} finally {
  if (exitCode === null)
    try {
      term?.kill()
    } catch {
      // gone
    }
  nsq('phone', 'off')
  stopDaemon(nsq, home)
  // The old scenario's daemon (still old, or restarted on this nsq): by its own home and PID only.
  if (existsSync(join(oldHome, 'daemon.json'))) {
    const inOldHome = (...cmd) =>
      spawnSync(process.execPath, [bin, ...cmd], {
        env: { ...oldEnv, NSQ_NO_HANDOVER: '1' },
        cwd: work,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true
      })
    stopDaemon(inOldHome, oldHome)
  }
  ntfy.close()
  writeChecks(out, checks)
  if (out !== work) rmSync(work, { recursive: true, force: true })
  const failed = checks.filter((row) => !row.ok).length
  log(`${checks.length - failed}/${checks.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
