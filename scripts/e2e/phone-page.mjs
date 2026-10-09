// The phone page in a real mobile browser (Chrome or Edge, headless, phone-sized, touch) against
// real harnesses on the fake model, in the sandbox: pairs through the link (/?t=…), sees the
// agents, answers a permission prompt with the Yes button, opens an agent, sends a prompt from
// the page. Fails on any Content-Security-Policy violation or page error. Screenshots to --out.
//
//   node scripts/e2e/phone-page.mjs --bin <dir with the CLIs> [--browser <path>] [--out dir]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERM_DIR, startFakeModel } from './fake-model.mjs'
import { makeSandbox } from './sandbox.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(ROOT, 'apps', 'cli', 'bin', 'nsq.js')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : fallback
}
const out = resolve(arg('out', join(ROOT, '.cache', 'phone-page')))
const work = resolve(join(ROOT, '..', '.nsq-e2e', `phone-${Date.now()}`))
mkdirSync(out, { recursive: true })
mkdirSync(work, { recursive: true })

const BROWSERS = [
  arg('browser'),
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean)
const browserPath = BROWSERS.find((path) => existsSync(path))
if (!browserPath) throw new Error('no Chrome/Edge/Chromium found (--browser <path>)')

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok) })
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${JSON.stringify(detail)}` : ''}`
  )
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fake = await startFakeModel({ logFile: join(work, 'fake-requests.jsonl') })
const sandbox = makeSandbox(work, fake.base, { binDirs: arg('bin') ? [resolve(arg('bin'))] : [] })
const nsq = (...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    env: sandbox.env,
    cwd: sandbox.project,
    encoding: 'utf8',
    windowsHide: true
  })
const list = () => {
  try {
    return JSON.parse(nsq('ls', '--json').stdout)
  } catch {
    return []
  }
}
async function waitFor(fn, ms = 60_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(400)
  }
  return undefined
}

/* global WebSocket */
// ---- a minimal CDP client over the browser's WebSocket ---------------------------------------
async function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((r, j) => {
    socket.onopen = r
    socket.onerror = j
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  socket.onmessage = (message) => {
    const data = JSON.parse(String(message.data))
    if (data.id && pending.has(data.id)) {
      const { resolve: done, reject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) reject(new Error(data.error.message))
      else done(data.result)
    } else if (data.method) for (const listener of listeners) listener(data)
  }
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((done, reject) => {
        const n = ++id
        pending.set(n, { resolve: done, reject })
        socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
      }),
    on: (fn) => listeners.push(fn),
    close: () => socket.close()
  }
}

let browser
const profile = join(work, 'browser-profile')
try {
  // Agents: one that will ask (Codex permission prompt), one that just answers.
  nsq('run', 'codex', '--name', 'reviewer', '[nsq:perm] make the folder')
  nsq('run', 'claude', '--name', 'api-fix', '[nsq:hello] fix the flaky test')
  const asked = await waitFor(() =>
    list().find((a) => a.name === 'reviewer' && a.status === 'needs-input')
  )
  check('the Codex agent waits for an answer', asked)
  await waitFor(() => list().find((a) => a.name === 'api-fix' && a.status === 'finished'))

  const on = nsq('phone', 'on', '--port', '0')
  const port = /port (\d+)/.exec(on.stdout)?.[1]
  if (!port) {
    throw new Error(`nsq phone on printed no port\nstdout: ${on.stdout}\nstderr: ${on.stderr}`)
  }
  const token = readFileSync(join(sandbox.env.NSQ_HOME, 'phone-token'), 'utf8').trim()
  const origin = `http://127.0.0.1:${port}`

  const debugPort = 9300 + Math.floor(Math.random() * 500)
  browser = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )
  const version = await waitFor(async () => {
    try {
      return await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
    } catch {
      return undefined
    }
  }, 20_000)
  const client = await cdp(version.webSocketDebuggerUrl)
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
  const page = (method, params) => client.send(method, params, sessionId)
  const problems = []
  client.on((event) => {
    if (event.sessionId !== sessionId) return
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
      problems.push(event.params.entry.text)
    if (event.method === 'Runtime.exceptionThrown')
      problems.push(event.params.exceptionDetails.text)
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
      problems.push(event.params.args.map((a) => a.value).join(' '))
  })
  await page('Log.enable')
  await page('Runtime.enable')
  await page('Page.enable')
  await page('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true
  })
  await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  })
  const evaluate = async (expression) =>
    (await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
      .value
  const shot = async (name) => {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'))
  }

  // 1. Not paired.
  await page('Page.navigate', { url: `${origin}/` })
  await sleep(1200)
  check(
    'without a token the page asks to pair',
    await evaluate("!document.getElementById('pair').hidden")
  )
  await shot('1-pair')

  // 2. The pairing link: the token is kept and taken out of the address bar.
  await page('Page.navigate', { url: `${origin}/?t=${token}` })
  const listed = await waitFor(() =>
    evaluate("document.querySelectorAll('.card').length >= 2 ? true : undefined")
  )
  check('paired: both agents listed', listed)
  check(
    'the token left the address bar',
    !(await evaluate('location.href')).includes(token),
    await evaluate('location.href')
  )
  check(
    'the question is shown on the card',
    await evaluate("document.querySelector('.card.needs .question')?.textContent ?? ''").then(
      (text) => /mkdir/.test(text)
    )
  )
  check(
    'the phone shows as connected on the computer',
    /iPhone · Safari/.test(nsq('phone', 'status').stdout)
  )
  await shot('2-list')

  // 3. Yes from the card.
  await evaluate("document.querySelector('.card.needs .answers .primary').click()")
  const done = await waitFor(() =>
    list().find((a) => a.name === 'reviewer' && a.status === 'finished')
  )
  check('Yes on the phone: the turn finished', done)
  check('the approved command ran', existsSync(join(sandbox.project, PERM_DIR)))

  // 4. Open an agent, read its screen, send a prompt.
  await sleep(1500)
  await evaluate(
    "[...document.querySelectorAll('.card')].find((c) => c.textContent.includes('api-fix')).click()"
  )
  const screen = await waitFor(() =>
    evaluate(
      "/NSQ_HELLO_DONE/.test(document.getElementById('screen').textContent) ? true : undefined"
    )
  )
  check('the agent screen shows its output', screen)
  await shot('3-agent')
  await evaluate(`(() => {
    const field = document.getElementById('prompt-text')
    field.value = '[nsq:hello] again from the phone page'
    document.getElementById('prompt').requestSubmit()
  })()`)
  const again = await waitFor(async () => {
    const peek = nsq('peek', 'api-fix', '-n', '80').stdout
    return /again from the phone page/.test(peek) ? true : undefined
  })
  check('a prompt from the page reached the agent', again)
  await waitFor(() => list().find((a) => a.name === 'api-fix' && a.status === 'finished'))
  await sleep(2000)
  await shot('4-sent')

  // Before rotating: from then on the page's calls are refused on purpose (401).
  check('no CSP violation or page error', problems.length === 0, problems)

  // 5. Rotate on the computer: the page goes back to pairing.
  nsq('phone', 'rotate')
  const unpaired = await waitFor(
    () => evaluate("!document.getElementById('pair').hidden ? true : undefined"),
    40_000
  )
  check('after rotate the page asks to pair again', unpaired)

  client.close()
} finally {
  try {
    if (browser?.pid) {
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' })
      else browser.kill('SIGKILL')
    }
  } catch {}
  nsq('down')
  await fake.close()
  await sleep(1000)
  try {
    // The browser lets go of its profile a moment after it exits.
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
  } catch (error) {
    console.error(`could not remove ${work}: ${error.code}`)
  }
}
const failed = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed; screenshots in ${out}`)
process.exitCode = failed ? 1 : 0
