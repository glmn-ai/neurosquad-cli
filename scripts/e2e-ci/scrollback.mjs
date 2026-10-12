// Scrolling back through an agent's output in the dashboard, in a real pseudo-terminal (ConPTY
// on Windows) with real mouse reports. Three stand-in agents (scripts/e2e/scroll-agent.mjs,
// plain commands): `scroll` prints 300 numbered lines and then a tick every 400 ms on the normal
// screen, `mousey` asks for the mouse, `alty` sits on the alternate screen. Part of the
// dashboard suite.
//
//   grid         the wheel over the scroll tile shows earlier lines and "↑ N lines"; new
//                output doesn't move them; wheel down returns to the live screen; the wheel
//                over the sidebar still moves the selection; the wheel over mousey's tile goes
//                to mousey as mouse reports, over alty's tile to nobody
//   full screen  the wheel shows earlier lines, new output doesn't move them, End returns
//                (the newest tick shows); any other key returns too; Shift+PgUp / Shift+End;
//                mousey gets the wheel as mouse reports; alty gets it as cursor keys, and
//                Shift+PgUp reaches alty untouched
//
//   node scripts/e2e-ci/scrollback.mjs --root <repo under test> --work <scratch> [--out <dir>]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `scrollback-${Date.now()}`)))
const out = resolve(get('out', work))
mkdirSync(work, { recursive: true })
mkdirSync(out, { recursive: true })
const log = makeLog()
const { rows: checks, check, skip } = makeChecks(log)
// Plain commands run on Windows' own ConPTY, which redraws their screen instead of passing it
// through: an agent's mouse mode and alternate screen never reach nsq there (harness agents run
// on conpty.dll, which passes them through). Those checks run on Linux and macOS.
const passthrough = process.platform !== 'win32'
const NO_PASSTHROUGH =
  "Windows' ConPTY of a plain command does not pass the agent's mouse mode / alternate screen"
const cols = 120
const rows = 36

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
  NSQ_KEYRING: 'memory'
}
delete env.TERM_PROGRAM
delete env.WT_SESSION
const { bin, nsq, agentNamed } = makeNsq(root, env, sandbox.project, log)
const agentScript = join(root, 'scripts', 'e2e', 'scroll-agent.mjs')
const mouseLog = join(work, 'mousey.log')
const altLog = join(work, 'alty.log')
const readLog = (file) => (existsSync(file) ? readFileSync(file, 'latin1') : '')

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
/** SGR mouse report at a 0-based cell. */
const mouse = (code, x, y, release = false) =>
  `\x1b[<${code};${x + 1};${y + 1}${release ? 'm' : 'M'}`
const wheel = async (direction, x, y, notches = 1, shift = false) => {
  for (let i = 0; i < notches; i++) {
    press(mouse((direction === 'up' ? 64 : 65) | (shift ? 4 : 0), x, y))
    await sleep(40)
  }
  await sleep(300)
}
const doubleClick = async (x, y) => {
  press(mouse(0, x, y) + mouse(0, x, y, true))
  await sleep(60)
  press(mouse(0, x, y) + mouse(0, x, y, true))
  await sleep(400)
}
/** Where an agent's tile title is: its name's first cell. */
const titleAt = (text, name) => {
  const lines = text.split('\n')
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y].indexOf(` ${name}  `)
    // A tile title, not the sidebar (the sidebar is at the left edge).
    if (x > 30) return { x: x + 1, y }
  }
  return null
}
const numbers = (text, word) =>
  [...text.matchAll(new RegExp(`\\b${word} (\\d+)\\b`, 'g'))].map((m) => Number(m[1]))
/** The scroll agent's lines and ticks on the screen, in order. */
const content = (text) => [...text.matchAll(/\b(?:line|tick) \d+\b/g)].map((m) => m[0]).join(',')
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
  for (const [name, mode, extra] of [
    ['scroll', 'lines'],
    ['mousey', 'mouse', mouseLog],
    ['alty', 'alt', altLog]
  ]) {
    const run = nsq(
      'run',
      '--name',
      name,
      '--',
      process.execPath,
      agentScript,
      mode,
      ...(extra ? [extra] : [])
    )
    check(`${name}: the stand-in agent starts`, run.status === 0, run.stderr)
  }
  check(
    'all three run',
    await waitFor(() => ['scroll', 'mousey', 'alty'].every((n) => agentNamed(n)?.running))
  )

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

  // ---- grid ------------------------------------------------------------------------------------
  const grid = await until(
    (t) => titleAt(t, 'scroll') && titleAt(t, 'mousey') && titleAt(t, 'alty') && /tick \d+/.test(t),
    30_000
  )
  shot('grid')
  const scrollTile = titleAt(grid, 'scroll')
  const mouseTile = titleAt(grid, 'mousey')
  const altTile = titleAt(grid, 'alty')
  check('the dashboard shows the three tiles', scrollTile && mouseTile && altTile, grid)
  if (!scrollTile || !mouseTile || !altTile) throw new Error('no tiles')
  const inScroll = { x: scrollTile.x + 4, y: scrollTile.y + 4 }

  const liveLines = numbers(grid, 'line')
  await wheel('up', inScroll.x, inScroll.y, 8)
  const back = await until((t) => t.includes('↑ '))
  shot('grid-scrolled')
  check(
    'grid: the wheel over a tile shows its earlier lines and how far back',
    back.includes('↑ ') &&
      back.includes('wheel down') &&
      Math.min(...numbers(back, 'line')) < Math.min(...(liveLines.length ? liveLines : [300])),
    { live: liveLines, back: numbers(back, 'line') }
  )
  await sleep(2000)
  const later = await screen()
  check('grid: new output does not move the scrolled view', content(later) === content(back), {
    back: content(back),
    later: content(later)
  })
  await wheel('down', inScroll.x, inScroll.y, 40)
  const liveAgain = await until((t) => !t.includes('↑ '))
  check(
    'grid: wheel down to the bottom follows the live screen again',
    !liveAgain.includes('↑ ') &&
      Math.max(...numbers(liveAgain, 'tick')) > Math.max(...numbers(later, 'tick'), 0),
    numbers(liveAgain, 'tick')
  )

  // The wheel over the sidebar still moves the selection (the focused tile shows "⏎ open").
  const openHint = (text) => {
    const lines = text.split('\n')
    const y = lines.findIndex((l) => l.includes('⏎ open'))
    return y < 0 ? 'none' : `${y}:${lines[y].indexOf('⏎ open')}`
  }
  const selectedBefore = openHint(liveAgain)
  await wheel('down', 2, 6, 1)
  const moved = await until((t) => openHint(t) !== selectedBefore, 3000)
  check(
    'grid: the wheel over the sidebar moves the selection',
    openHint(moved) !== selectedBefore && openHint(moved) !== 'none',
    { before: selectedBefore, after: openHint(moved) }
  )

  if (passthrough) {
    await wheel('up', mouseTile.x + 4, mouseTile.y + 3, 2)
    const mouseGot = await waitFor(() => /\x1b\[<64;\d+;\d+M/.test(readLog(mouseLog)), 5000) // eslint-disable-line no-control-regex
    check('grid: an agent that asked for the mouse gets the wheel as mouse reports', mouseGot, {
      log: JSON.stringify(readLog(mouseLog))
    })
    await wheel('up', altTile.x + 4, altTile.y + 3, 2)
    await sleep(500)
    check(
      'grid: the wheel over a full-screen TUI tile sends it nothing',
      readLog(altLog) === '',
      JSON.stringify(readLog(altLog))
    )
  } else skip('grid: the wheel over agents that scroll themselves', NO_PASSTHROUGH)

  // ---- full screen: the scroll agent -------------------------------------------------------------
  await doubleClick(scrollTile.x + 2, scrollTile.y + 2)
  const open = await until((t) => t.includes('Ctrl+] back to the grid') && /tick \d+/.test(t))
  shot('full')
  check(
    'full screen: opens with the scroll hint',
    open.includes('Ctrl+] back to the grid') && open.includes('scroll back'),
    open.slice(-400)
  )
  const center = { x: Math.floor(cols / 2), y: Math.floor(rows / 2) }
  const liveFull = numbers(open, 'line')
  await wheel('up', center.x, center.y, 10)
  const backFull = await until((t) => t.includes('End or any key to return'))
  shot('full-scrolled')
  const firstBack = Math.min(...numbers(backFull, 'line'))
  check(
    'full screen: the wheel shows earlier lines',
    backFull.includes('End or any key to return') &&
      firstBack < Math.min(...(liveFull.length ? liveFull : [300])),
    { live: liveFull.slice(0, 3), back: numbers(backFull, 'line').slice(0, 3) }
  )
  await sleep(2000)
  const laterFull = await screen()
  check('full screen: new output does not move the view', content(laterFull) === content(backFull))
  const lastTick = Math.max(...numbers(laterFull, 'tick'), 0)
  press('\x1b[F') // End
  const endLive = await until(
    (t) => !t.includes('↑ ') && Math.max(...numbers(t, 'tick')) > lastTick
  )
  check(
    'full screen: End returns to the live screen with the newest output',
    !endLive.includes('↑ ') && Math.max(...numbers(endLive, 'tick')) > lastTick,
    numbers(endLive, 'tick')
  )
  press('\x1b[5;2~') // Shift+PgUp
  const paged = await until((t) => t.includes('↑ '))
  check('full screen: Shift+PgUp scrolls a page back', /↑ \d+ lines/.test(paged))
  press('\x1b[1;2F') // Shift+End
  const shiftEnd = await until((t) => !t.includes('↑ '))
  check('full screen: Shift+End returns', !shiftEnd.includes('↑ '))
  await wheel('up', center.x, center.y, 3)
  await until((t) => t.includes('↑ '))
  press('x')
  const anyKey = await until((t) => !t.includes('↑ '))
  check('full screen: any key for the agent returns to the live view first', !anyKey.includes('↑ '))
  press('\x1d') // Ctrl+]
  await until((t) => !t.includes('Ctrl+] back to the grid'))

  if (passthrough) {
    // ---- full screen: the agents that scroll themselves --------------------------------------------
    const gridAgain = await until((t) => Boolean(titleAt(t, 'mousey')))
    const mouseAt = titleAt(gridAgain, 'mousey')
    await doubleClick(mouseAt.x + 2, mouseAt.y + 2)
    await until((t) => t.includes('Ctrl+] back to the grid'))
    writeFileSync(mouseLog, '')
    await wheel('down', center.x, center.y, 2)
    const mouseFull = await waitFor(() => /\x1b\[<65;\d+;\d+M/.test(readLog(mouseLog)), 5000) // eslint-disable-line no-control-regex
    const mouseScreen = await screen()
    check(
      'full screen: an agent that asked for the mouse gets the wheel, no scrollback',
      mouseFull && !mouseScreen.includes('↑ '),
      JSON.stringify(readLog(mouseLog))
    )
    press('\x1d')
    const gridThird = await until(
      (t) => !t.includes('Ctrl+] back to the grid') && Boolean(titleAt(t, 'alty'))
    )
    const altAt = titleAt(gridThird, 'alty')
    await doubleClick(altAt.x + 2, altAt.y + 2)
    await until((t) => t.includes('Ctrl+] back to the grid'))
    await wheel('up', center.x, center.y, 1)
    // eslint-disable-next-line no-control-regex -- cursor keys
    const altKeys = await waitFor(() => /(\x1b\[A|\x1bOA){3}/.test(readLog(altLog)), 5000)
    check(
      'full screen: on the alternate screen the wheel arrives as cursor keys',
      altKeys,
      JSON.stringify(readLog(altLog))
    )
    press('\x1b[5;2~')
    const altShift = await waitFor(() => readLog(altLog).includes('\x1b[5;2~'), 5000)
    check('full screen: Shift+PgUp reaches a full-screen TUI untouched', altShift)
  } else skip('full screen: the wheel for agents that scroll themselves', NO_PASSTHROUGH)
  press('\x1d')
  await until((t) => !t.includes('Ctrl+] back to the grid'))
  press('q')
  for (let i = 0; i < 20 && exitCode === null; i++) await sleep(250)
  check('q quits the dashboard', exitCode === 0, { exitCode })
} catch (error) {
  check('scrollback.mjs: ran', false, String(error?.stack ?? error))
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
