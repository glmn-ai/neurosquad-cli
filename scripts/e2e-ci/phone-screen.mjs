// The phone page's terminal view in a real mobile browser (headless Chrome/Edge, 390×844, touch):
// an agent (scripts/e2e/ansi-agent.mjs, a plain command) prints the 16 colours, the 256-colour
// cube, truecolor, attributes, box drawing, CJK and emoji, and markup. The page must show them as
// styled spans in nsq's palette, with the cursor, wide characters two cells wide, the whole width
// fitted to the phone, a pinch zooming in — and the markup as text: no element from it, no script
// run. Fails on any page error or Content-Security-Policy violation. Part of the dashboard suite.
//
//   node scripts/e2e-ci/phone-screen.mjs --root <repo under test> --work <scratch> [--out <dir>]
//        [--browser <path>]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `phone-screen-${Date.now()}`)))
const out = resolve(get('out', work))
mkdirSync(work, { recursive: true })
mkdirSync(out, { recursive: true })
const log = makeLog()
const { rows: checks, check, skip } = makeChecks(log)

const browserPath = [
  get('browser'),
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]
  .filter(Boolean)
  .find((path) => existsSync(path))
if (!browserPath) {
  skip('phone page terminal view', 'no Chrome/Edge/Chromium on this runner')
  writeChecks(out, checks)
  process.exit(0)
}

const e2e = await loadE2e(root)
const sandbox = e2e.makeSandbox(join(work, 'sandbox'), 'http://127.0.0.1:9')
const home = sandbox.env.NSQ_HOME
const env = { ...sandbox.env, NSQ_NO_NOTIFY: '1' }
const { nsq, agentNamed } = makeNsq(root, env, sandbox.project, log)

/* global WebSocket */
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
async function waitFor(fn, ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(300)
  }
  return undefined
}

// What the page shows, measured in the page.
const FACTS = `(() => {
  const term = document.getElementById('term')
  const screen = document.getElementById('screen')
  const spans = [...term.querySelectorAll('span')]
  const find = (text) => spans.find((s) => s.textContent.trim() === text)
  const css = (text, prop) => { const s = find(text); return s ? getComputedStyle(s)[prop] : null }
  const wide = find('中')
  // One cell: the page's grid unit (1ch of its monospace font), measured on a cell of its own —
  // not on text, which a runner without a monospace font would draw proportionally.
  const probe = document.createElement('span')
  probe.style.display = 'inline-block'
  probe.style.width = '1ch'
  probe.textContent = 'x'
  term.firstElementChild.append(probe)
  const cell = probe.getBoundingClientRect().width
  probe.remove()
  return {
    rows: term.children.length,
    text: term.textContent,
    red: css('RED', 'color'),
    brightRed: css('BRIGHTRED', 'color'),
    onGreen: css('ON-GREEN', 'backgroundColor'),
    orange: css('ORANGE256', 'color'),
    pink: css('PINKTRUE', 'color'),
    blueBg: css('BLUEBG', 'backgroundColor'),
    blueFg: css('BLUEBG', 'color'),
    bold: css('BOLD', 'fontWeight'),
    dim: css('DIM', 'opacity'),
    italic: css('ITALIC', 'fontStyle'),
    under: css('UNDER', 'textDecorationLine'),
    strike: css('STRIKE', 'textDecorationLine'),
    inverse: find('INVERSE')?.className ?? null,
    wideRatio: wide ? wide.getBoundingClientRect().width / cell : null,
    // Cells per character of a text run (ConPTY may carry a trailing space in the same run).
    textCells: find('RED')
      ? find('RED').getBoundingClientRect().width / cell / find('RED').textContent.length
      : null,
    emoji: find('🚀') ? find('🚀').getBoundingClientRect().width / cell : null,
    rows3: [...term.children].slice(4, 7).map((r) => r.lastElementChild ? Math.round(r.lastElementChild.getBoundingClientRect().right * 10) / 10 : 0),
    box: spans.some((s) => s.textContent.includes('┌──────────┬──────┐')),
    cursor: [...term.querySelectorAll('.cur')].map((s) => s.textContent),
    markup: term.querySelectorAll('img, script, b').length,
    markupText: term.textContent.includes('<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>'),
    xss: window.__xss ?? null,
    fontSize: parseFloat(term.style.fontSize || '0'),
    // The computed size (CSS px) and what the scroller shows of the newest line and the cursor.
    fontPx: parseFloat(getComputedStyle(term).fontSize),
    lastLineVisible: (() => {
      const box = screen.getBoundingClientRect()
      const last = term.lastElementChild.getBoundingClientRect()
      return last.top >= box.top - 1 && last.bottom <= box.bottom + 1
    })(),
    cursorInView: (() => {
      const box = screen.getBoundingClientRect()
      const c = term.querySelector('.cur')
      if (!c) return false
      const r = c.getBoundingClientRect()
      return r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom
    })(),
    mode: document.querySelector('[data-fit][aria-pressed="true"]')?.dataset.fit ?? null,
    fits: screen.scrollWidth <= screen.clientWidth + 1,
    scrollWidth: screen.scrollWidth,
    clientWidth: screen.clientWidth
  }
})()`

let browser
try {
  const ansi = join(root, 'scripts', 'e2e', 'ansi-agent.mjs')
  const run = nsq('run', '--name', 'colors', '--', process.execPath, ansi)
  check('a plain-command agent that prints colours starts', run.status === 0, run.stderr)
  const started = await waitFor(() => agentNamed('colors')?.running)
  check('it runs', started)
  const on = nsq('phone', 'on', '--port', '0')
  const port = /port (\d+)/.exec(on.stdout)?.[1]
  if (!port) throw new Error(`nsq phone on printed no port: ${on.stdout} ${on.stderr}`)
  const token = readFileSync(join(home, 'phone-token'), 'utf8').trim()
  const origin = `http://127.0.0.1:${port}`

  // Port 0: the browser picks a free port and writes it to DevToolsActivePort in its own
  // profile, so this attaches to the browser it started and to no other.
  const profile = join(work, 'browser-profile')
  browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )
  const wsUrl = await waitFor(() => {
    try {
      const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
      return port && path ? `ws://127.0.0.1:${port.trim()}${path.trim()}` : undefined
    } catch {
      return undefined
    }
  }, 20_000)
  if (!wsUrl) throw new Error('the browser did not open its DevTools port')
  const client = await cdp(wsUrl)
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
  const evaluate = async (expression) =>
    (await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
      .value
  const shot = async (name) => {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'))
  }

  await page('Page.navigate', { url: `${origin}/?t=${token}` })
  const card = await waitFor(() => evaluate("document.querySelector('.card') ? true : undefined"))
  check('the page lists the agent', card)
  await evaluate("document.querySelector('.card').click()")
  const facts = await waitFor(async () => {
    const value = await evaluate(FACTS)
    return value && value.text.includes('type here') ? value : undefined
  })
  if (!facts) throw new Error('the agent screen never showed')
  await sleep(500)
  await shot('phone-terminal')
  const f = await evaluate(FACTS)
  log('facts', JSON.stringify({ ...f, text: undefined }))
  check('16 colours in nsq’s palette (red #f3625f)', f.red === 'rgb(243, 98, 95)', f.red)
  check('bright red (#ff8782)', f.brightRed === 'rgb(255, 135, 130)', f.brightRed)
  check('a palette background (green #17c964)', f.onGreen === 'rgb(23, 201, 100)', f.onGreen)
  check('256 colours (208 → #ff8700)', f.orange === 'rgb(255, 135, 0)', f.orange)
  check('truecolor foreground', f.pink === 'rgb(255, 105, 180)', f.pink)
  check(
    'truecolor background with a bright white text',
    f.blueBg === 'rgb(20, 40, 120)' && f.blueFg === 'rgb(250, 250, 250)',
    [f.blueBg, f.blueFg]
  )
  check('bold', Number(f.bold) >= 700, f.bold)
  // Windows ConPTY re-renders what the agent wrote; some versions drop faint, turn inverse into
  // explicit colours and bold into bold bright white — the same screen nsq's dashboard shows.
  const conpty = process.platform === 'win32'
  if (conpty && Number(f.dim) === 1) skip('dim', 'this ConPTY drops SGR 2')
  else check('dim', f.dim !== null && Number(f.dim) < 1, f.dim)
  check('italic', f.italic === 'italic', f.italic)
  check('underline', /underline/.test(f.under), f.under)
  check('strikethrough', /line-through/.test(f.strike), f.strike)
  check(
    'inverse swaps the default colours',
    (/\bfi\b/.test(f.inverse) && /\bbi\b/.test(f.inverse)) ||
      (conpty && /\bf0\b/.test(f.inverse) && /\bb7\b/.test(f.inverse)),
    f.inverse
  )
  check('a CJK character is two cells wide', f.wideRatio > 1.8 && f.wideRatio < 2.2, f.wideRatio)
  check(
    'text keeps the cell grid (a monospace font)',
    Math.abs(f.textCells - 1) < 0.05,
    f.textCells
  )
  check('an emoji is two cells wide', f.emoji > 1.8 && f.emoji < 2.2, f.emoji)
  check(
    'the box lines up (its three rows end at the same column)',
    Math.max(...f.rows3) - Math.min(...f.rows3) < 1,
    f.rows3
  )
  check('box drawing comes through', f.box)
  check('the cursor is shown where the agent left it', f.cursor.join('') === 'r', f.cursor)
  check('markup from the agent is text: no element made from it', f.markup === 0, f.markup)
  check('… shown literally', f.markupText)
  check('… and no script from it ran', f.xss === null, f.xss)

  // Readable by default: a font a phone can read; a wider agent scrolls sideways, the newest
  // line and the cursor stay in view.
  check('readable by default', f.mode === 'readable', f.mode)
  check('readable: font at least 12 CSS px', f.fontPx >= 12, f.fontPx)
  check('readable: the newest line is in view (anchored at the bottom)', f.lastLineVisible)
  check('readable: the cursor is in view', f.cursorInView)
  const sideways = await evaluate(
    "(() => { const s = document.getElementById('screen'); const before = s.scrollWidth > s.clientWidth; s.scrollLeft = 120; const moved = s.scrollLeft > 0; s.scrollLeft = 0; return before && moved })()"
  )
  check('readable: a wider screen scrolls sideways', sideways)

  // Fit width: the whole width on the screen; the choice is remembered on this device.
  await evaluate("document.getElementById('size-fit').click()")
  await sleep(300)
  const fitted = await evaluate(FACTS)
  await shot('phone-terminal-fit')
  check('fit width: the whole width fits the phone', fitted.fits, [
    fitted.scrollWidth,
    fitted.clientWidth
  ])
  check('fit width: smaller than readable', fitted.fontPx < f.fontPx, [f.fontPx, fitted.fontPx])
  check('fit width: the newest line is in view', fitted.lastLineVisible)
  await page('Page.reload')
  await waitFor(() => evaluate("document.querySelector('.card') ? true : undefined"))
  await evaluate("document.querySelector('.card').click()")
  const again = await waitFor(async () => {
    const value = await evaluate(FACTS)
    return value && value.text.includes('type here') ? value : undefined
  })
  check('fit width is remembered after a reload', again?.mode === 'fit' && again.fits, again?.mode)

  // In fit width, a pinch zooms the terminal in (not the page).
  const box = await evaluate(
    "(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()"
  )
  const touch = (type, spread) =>
    page('Input.dispatchTouchEvent', {
      type,
      touchPoints:
        type === 'touchEnd'
          ? []
          : [
              { x: box.x - spread, y: box.y, id: 1 },
              { x: box.x + spread, y: box.y, id: 2 }
            ]
    })
  await touch('touchStart', 30)
  for (const spread of [45, 60, 75, 90]) await touch('touchMove', spread)
  await touch('touchEnd', 0)
  await sleep(300)
  const zoomed = await evaluate(FACTS)
  await shot('phone-terminal-zoomed')
  check('a pinch zooms the terminal in (font about 3×)', zoomed.fontSize > again.fontSize * 2.5, [
    again.fontSize,
    zoomed.fontSize
  ])
  check('… and it scrolls sideways', !zoomed.fits)
  // Back to readable for the next visit.
  await evaluate("document.getElementById('size-readable').click()")
  await sleep(300)
  const back = await evaluate(FACTS)
  check('readable again', back.mode === 'readable' && back.fontPx >= 12, back.fontPx)
  check('no page errors or CSP violations', problems.length === 0, problems)
} catch (error) {
  check('phone-screen.mjs: ran', false, String(error?.stack ?? error))
} finally {
  if (browser && browser.exitCode === null) browser.kill()
  nsq('phone', 'off')
  nsq('rm', 'colors')
  stopDaemon(nsq, home)
  writeChecks(out, checks)
  await sleep(500)
  if (out !== work) rmSync(work, { recursive: true, force: true })
  const failed = checks.filter((row) => !row.ok).length
  log(`${checks.length - failed}/${checks.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
