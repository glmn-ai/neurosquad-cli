// Live checks that scripts/e2e/run.mjs does not cover, with the same real CLIs,
// fake model and sandbox. Per harness:
//
//   interrupt  a long turn is interrupted with `nsq interrupt`: the agent
//              leaves "working" without exiting (Ctrl+C would close some CLIs),
//              the scripted answer never shows, and a next prompt runs a turn
//   ask        the model asks a question (AskUserQuestion / question tool):
//              "needs you" carries the question text
//
//   node scripts/e2e-ci/extra.mjs --root <repo under test> --harness claude|codex|opencode
//        --bin <dir with the CLIs> --work <scratch> [--only interrupt,ask]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  args,
  HARNESSES,
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

const { get } = args()
const root = rootFrom(get)
const short = get('harness', 'claude')
if (!HARNESSES[short]) throw new Error(`unknown harness ${short}`)
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `extra-${short}-${Date.now()}`)))
const only = get('only') ? new Set(get('only').split(',')) : null
const runs = (step) => !only || only.has(step)
mkdirSync(work, { recursive: true })

const log = makeLog()
const { rows, check, skip } = makeChecks(log)
const e2e = await loadE2e(root)
// A turn long enough to interrupt for sure. After an interrupt some harnesses
// fold the interrupted prompt into the next user message, so the fake still
// sees the `long` marker first: only the first model call is held back.
let longCalls = 0
const scenarios = {
  ...e2e.SCENARIOS,
  long: [
    () =>
      longCalls++ === 0
        ? { text: 'NSQ_LONG_DONE — should never show', delayMs: 45_000 }
        : { text: 'NSQ_AFTER_INTERRUPT_DONE', delayMs: 500 }
  ],
  // A question in each harness's own tool shape; what the tool returned is kept for the log.
  ask: [
    (ctx) => ({ tool: questionCall(ctx.tools) ?? e2e.SCENARIOS.ask[0](ctx).tool }),
    (ctx) => {
      askResults.push(String(ctx.lastResult ?? '').slice(0, 300))
      return { text: 'NSQ_ASK_DONE' }
    }
  ]
}
const askResults = []
function questionCall(tools) {
  const options = [
    { label: 'Blue', description: 'Calm' },
    { label: 'Red', description: 'Loud' }
  ]
  const question = 'Which color should the button be?'
  if (tools.includes('request_user_input'))
    return {
      name: 'request_user_input',
      input: { questions: [{ id: 'color', header: 'Color', question, options }] }
    }
  if (tools.includes('question'))
    return { name: 'question', input: { questions: [{ question, header: 'Color', options }] } }
  return null
}
const fake = await e2e.startFakeModel({ logFile: join(work, 'fake-requests.jsonl'), scenarios })
const sandbox = e2e.makeSandbox(work, fake.base, {
  binDirs: get('bin') ? [resolve(get('bin'))] : []
})
writeFileSync(join(work, 'env.json'), JSON.stringify(sandbox.set, null, 2))
const { nsq, waitStatus } = makeNsq(root, sandbox.env, sandbox.project, log)
const peek = (name, n = 60) => plain(nsq('peek', name, '-n', String(n)).stdout)

try {
  if (runs('interrupt')) {
    const name = `${short}-int`
    nsq('run', short, '--name', name, '[nsq:long] take your time')
    const working = await waitStatus(name, ['working'], 90_000)
    // Into the model call (the fake holds the answer back).
    const held = () => fake.requests.some((r) => r.scenario === 'long' && !r.side)
    for (let i = 0; i < 60 && !held(); i++) await sleep(500)
    await sleep(1500)
    nsq('interrupt', name)
    const stopped = await waitStatus(name, ['idle', 'finished', 'needs-input', 'exited'], 30_000)
    check(
      `${short}: interrupt — the turn stops, the agent stays`,
      working.agent?.status === 'working' &&
        ['idle', 'finished'].includes(stopped.agent?.status) &&
        stopped.agent?.running === true,
      [...working.seen, ...stopped.seen]
    )
    await sleep(3000)
    check(`${short}: interrupt — the held answer never shows`, !/NSQ_LONG_DONE/.test(peek(name)))
    nsq('send', name, '[nsq:long] go on, quickly now')
    const again = await waitStatus(name, ['finished'], 90_000)
    let screen = ''
    for (let i = 0; i < 10 && !/NSQ_AFTER_INTERRUPT_DONE/.test(screen); i++) {
      screen = peek(name, 80)
      if (!/NSQ_AFTER_INTERRUPT_DONE/.test(screen)) await sleep(1000)
    }
    check(
      `${short}: interrupt — the next prompt runs a turn`,
      again.agent?.status === 'finished' && /NSQ_AFTER_INTERRUPT_DONE/.test(screen),
      again.seen
    )
    if (again.agent?.status !== 'finished') log(screen.slice(-1500))
    nsq('stop', name)
  }

  if (runs('ask') && short === 'codex') {
    // Codex 0.16x: request_user_input is unavailable in Default mode (Plan mode only).
    skip('codex: a question → needs you', 'Codex asks questions only in Plan mode')
  } else if (runs('ask')) {
    const name = `${short}-ask`
    nsq('run', short, '--name', name, '[nsq:ask] pick a colour')
    const asked = await waitStatus(name, ['needs-input', 'finished'], 120_000)
    const detail = asked.agent?.detail ?? ''
    check(
      `${short}: a question → needs you, with its text`,
      asked.agent?.status === 'needs-input' && /Which color should the button be/.test(detail),
      { seen: asked.seen, toolReturned: askResults }
    )
    if (asked.agent?.status !== 'needs-input') log(peek(name).slice(-1500))
    nsq('interrupt', name)
    await sleep(1500)
    nsq('stop', name)
  }
} catch (error) {
  check('extra.mjs: crashed', false, String(error?.stack ?? error))
} finally {
  stopDaemon(nsq, sandbox.env.NSQ_HOME)
  // The held answer may keep a connection open: do not wait for it.
  await Promise.race([fake.close(), sleep(3000)])
  writeChecks(work, rows)
  const failed = rows.filter((row) => !row.ok).length
  log(`${rows.length - failed}/${rows.length} checks passed; work dir ${work}`)
  process.exit(failed ? 1 : 0)
}
