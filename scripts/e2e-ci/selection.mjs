// Selecting text and clicking links in the dashboard, in a real pseudo-terminal with real mouse
// reports. The dashboard has the mouse, so the host terminal can't select or open links itself;
// nsq does. A stand-in agent (scripts/e2e/scroll-agent.mjs text) prints a line and a link. Runs
// as if over SSH, so nothing reaches this machine's clipboard or browser: the copy goes to the
// host terminal as OSC 52, which is what the checks read. Part of the dashboard suite.
//
//   grid         a drag over the agent's text copies exactly that text (OSC 52), shows it
//                inverted and says so; a key clears it; a click on the link hands it over
//                (over SSH: copied, without the full stop after it)
//   full screen  a drag still copies
//
//   node scripts/e2e-ci/selection.mjs --root <repo under test> --work <scratch> [--out <dir>]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `selection-${Date.now()}`)))
const out = resolve(get('out', work))
mkdirSync(work, { recursive: true })
mkdirSync(out, { recursive: true })
const log = makeLog()
const { rows: checks, check } = makeChecks(log)
const cols = 120
const rows = 36
const ATTR_INVERSE = 32
const URL = 'https://example.com/nsq/docs?x=1'

const pty = createRequire(join(root, 'apps', 'cli', 'package.json'))('node-pty')
const { createTermView, gridToText } = await import(
  pathToFileURL(join(root, 'packages', 'term-view', 'dist', 'index.js')).href
)

const e2e = await loadE2e(root)
const sandbox = e2e.makeSandbox(join(work, 'sandbox'), 'http://127.0.0.1:9')
const home = sandbox.env.NSQ_HOME
const env = {
  ...sandbox.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  NSQ_IMAGES: '0',
  NSQ_NO_NOTIFY: '1',
  NSQ_NO_UPDATE: '1',
  NSQ_NO_BROWSER: '1',
  NSQ_KEYRING: 'memory'
}
delete env.TERM_PROGRAM
delete env.WT_SESSION
const { bin, nsq, agentNamed } = makeNsq(root, env, sandbox.project, log)
const agentScript = join(root, 'scripts', 'e2e', 'scroll-agent.mjs')

const view = createTermView({ cols, rows })
let raw = ''
let term
let exitCode = null
const screen = async () => {
  await view.flush()
  return gridToText(view.snapshot())
}
const until = async (test, ms = 15_000) => {
  const deadline = Date.now() + ms
  let last = await screen()
  while (!test(last) && Date.now() < deadline) {
    await sleep(200)
    last = await screen()
  }
  return last
}
const press = (keys) => term.write(keys)
const shot = (name) => writeFileSync(join(out, `${name}.ansi`), raw)
const mouse = (code, x, y, release = false) =>
  `\x1b[<${code};${x + 1};${y + 1}${release ? 'm' : 'M'}`
const drag = async (from, to) => {
  press(mouse(0, from.x, from.y))
  await sleep(40)
  press(mouse(32, to.x, to.y))
  await sleep(40)
  press(mouse(0, to.x, to.y, true))
  await sleep(400)
}
const clickAt = async (at) => {
  press(mouse(0, at.x, at.y) + mouse(0, at.x, at.y, true))
  await sleep(400)
}
/** What the dashboard put on the host's clipboard last (OSC 52). */
const copied = () => {
  // eslint-disable-next-line no-control-regex -- terminal escapes
  const all = [...raw.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)]
  return all.length ? Buffer.from(all[all.length - 1][1], 'base64').toString('utf8') : null
}
/** The first cell of `needle` on the screen (outside the sidebar). */
const find = (text, needle) => {
  const lines = text.split('\n')
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y].indexOf(needle)
    if (x > 30) return { x, y }
  }
  return null
}
const inverted = async (at) => {
  await view.flush()
  const grid = view.snapshot()
  return (grid.attrs[at.y * grid.cols + at.x] & ATTR_INVERSE) !== 0
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

try {
  const run = nsq('run', '--name', 'linky', '--', process.execPath, agentScript, 'text')
  check('the stand-in agent starts', run.status === 0, run.stderr)
  check('it runs', await waitFor(() => agentNamed('linky')?.running))

  term = pty.spawn(process.execPath, [bin], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: sandbox.project,
    env: { ...env, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22' },
    useConptyDll: true
  })
  term.onExit(({ exitCode: code }) => (exitCode = code))
  term.onData((data) => {
    // eslint-disable-next-line no-control-regex -- terminal escapes
    if (/\x1b\[0?c/.test(data)) term.write('\x1b[?62;22c')
    raw += data
    view.write(data)
  })

  // ---- grid ------------------------------------------------------------------------------------
  const grid = await until((t) => Boolean(find(t, 'alpha beta gamma') && find(t, URL)), 30_000)
  shot('grid')
  const alpha = find(grid, 'alpha')
  const link = find(grid, URL)
  check('the dashboard shows the agent text', alpha && link, grid)
  if (!alpha || !link) throw new Error('no text')
  const gammaEnd = { x: alpha.x + 'alpha beta gamma'.length - 1, y: alpha.y }

  await drag(alpha, gammaEnd)
  const afterDrag = await until((t) => t.includes('copied 16 characters'), 5000)
  shot('grid-selected')
  check('grid: a drag copies exactly the text under it (OSC 52)', copied() === 'alpha beta gamma', {
    copied: copied()
  })
  check('grid: the dashboard says it copied', afterDrag.includes('copied 16 characters'))
  check(
    'grid: the selection shows inverted, and only it',
    (await inverted(alpha)) && (await inverted(gammaEnd)) && !(await inverted(link))
  )
  press('j')
  await sleep(500)
  check('grid: a key clears the selection', !(await inverted(alpha)))

  await clickAt({ x: link.x + 10, y: link.y })
  const afterClick = await until((t) => t.includes('link copied'), 5000)
  shot('grid-link')
  check('grid: a click on a link hands it over (over SSH: copied)', copied() === URL, {
    copied: copied()
  })
  check('grid: the dashboard says so', afterClick.includes(`link copied: ${URL}`))
  check('grid: a click is not a selection', !(await inverted({ x: link.x + 10, y: link.y })))

  // ---- full screen ----------------------------------------------------------------------------
  press('\r')
  const full = await until((t) => t.includes('Ctrl+] back to the grid') && Boolean(find(t, 'beta')))
  const beta = find(full, 'beta')
  if (!beta) throw new Error('no text in full screen')
  await drag(beta, { x: beta.x + 3, y: beta.y })
  check('full screen: a drag copies', copied() === 'beta', { copied: copied() })
  press('\x1d')
  await until((t) => !t.includes('Ctrl+] back to the grid'))
  press('q')
  for (let i = 0; i < 20 && exitCode === null; i++) await sleep(250)
  check('q quits the dashboard', exitCode === 0, { exitCode })
} catch (error) {
  check('selection.mjs: ran', false, String(error?.stack ?? error))
} finally {
  if (exitCode === null)
    try {
      term?.kill()
    } catch {
      // gone
    }
  stopDaemon(nsq, home)
  view.dispose()
  writeChecks(out, checks)
  if (out !== work) rmSync(work, { recursive: true, force: true })
  const failed = checks.filter((row) => !row.ok).length
  log(`${checks.length - failed}/${checks.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
