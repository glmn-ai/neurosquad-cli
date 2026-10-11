// Live checks of the herdr status protocol (https://herdr.dev/docs/add-herdr-support/)
// with a real agent that implements it: Crush (charmbracelet/crush, its release
// binary from npm @charmland/crush) run as a plain command, `nsq run -- crush`,
// against the fake model and the sandbox. nsq tells it it runs in a herdr pane;
// Crush then reports its own state over the socket (on Windows it dials AF_UNIX,
// which a small PowerShell listener of nsq's answers):
//
//   registers  the agent shows idle (its first report), not the terminal guess
//   perm       a shell command → working → needs you → Enter (Allow) → finished,
//              the folder made, Crush's session id recorded
//
//   node scripts/e2e-ci/herdr.mjs --root <repo under test> --crush <crush binary> --work <scratch>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

const { get } = args()
const root = rootFrom(get)
const crush = resolve(get('crush'))
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `herdr-${Date.now()}`)))
mkdirSync(work, { recursive: true })

const log = makeLog()
const { rows, check } = makeChecks(log)
const e2e = await loadE2e(root)
const fake = await e2e.startFakeModel({ logFile: join(work, 'fake-requests.jsonl') })
const sandbox = e2e.makeSandbox(work, fake.base)

// Crush: the fake as an OpenAI-compatible provider, its config and data in the sandbox, no
// metrics, no catalogue updates from the network.
const crushConfig = join(sandbox.home, 'crush-config')
const crushData = join(sandbox.home, 'crush-data')
const config = {
  providers: {
    fake: {
      type: 'openai-compat',
      base_url: `${fake.base}/v1`,
      api_key: 'sk-nsq-e2e-fake-crush-key',
      models: [{ id: 'fake-model', name: 'Fake', context_window: 200000, default_max_tokens: 4096 }]
    }
  },
  models: {
    large: { model: 'fake-model', provider: 'fake' },
    small: { model: 'fake-model', provider: 'fake' }
  },
  options: { disable_metrics: true, disable_provider_auto_update: true }
}
for (const dir of [crushConfig, crushData]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'crush.json'), JSON.stringify(config, null, 2))
}
Object.assign(sandbox.env, {
  CRUSH_GLOBAL_CONFIG: crushConfig,
  CRUSH_GLOBAL_DATA: crushData,
  CRUSH_DISABLE_METRICS: '1',
  CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: '1',
  DO_NOT_TRACK: '1'
})
// An initialized project: Crush asks to create AGENTS.md otherwise.
writeFileSync(join(sandbox.project, 'AGENTS.md'), '# nsq e2e project\n')

const { nsq, waitStatus, agentNamed } = makeNsq(root, sandbox.env, sandbox.project, log)
const peek = (name, n = 60) => plain(nsq('peek', name, '-n', String(n)).stdout)

/** The states the agent reported over herdr, in order (from the daemon's log). */
function herdrReports() {
  let text = ''
  try {
    text = readFileSync(join(sandbox.env.NSQ_HOME, 'daemon.log'), 'utf8')
  } catch {
    // no log yet
  }
  // Accepted reports only ("herdr working → working"; not "herdr working dropped: …").
  return [...text.matchAll(/: herdr (idle|working|blocked|unknown) →/g)].map((m) => m[1])
}

/** Keys typed into an agent, as the person would (the daemon's client protocol). */
async function type(name, data) {
  process.env.NSQ_HOME = sandbox.env.NSQ_HOME
  const url = pathToFileURL(join(root, 'apps', 'cli', 'dist', 'client', 'client.js')).href
  const { DaemonClient } = await import(url)
  const client = await DaemonClient.open('e2e', { autostart: false })
  try {
    await client.request({ t: 'input', id: agentNamed(name).id, data })
  } finally {
    client.close()
  }
}

try {
  check('crush: binary installed', existsSync(crush), crush)
  const name = 'crush'
  const run = nsq('run', '--name', name, '--', crush)
  check('crush: nsq run -- crush', run.status === 0, run.stderr)
  // Its first report: idle. The terminal guess alone would read working, then finished.
  const registered = await waitStatus(name, ['idle'], 60_000)
  check('crush: registers over the herdr socket (idle)', registered.agent?.status === 'idle', {
    seen: registered.seen
  })
  if (registered.agent?.status !== 'idle') log(peek(name).slice(-1500))
  // The prompt box takes keys a moment after the first frame.
  await sleep(2000)
  nsq('send', name, '[nsq:perm] make the folder')
  const asked = await waitStatus(name, ['needs-input'], 120_000)
  check('crush: a shell command → needs you', asked.agent?.status === 'needs-input', {
    seen: asked.seen,
    detail: asked.agent?.detail
  })
  if (asked.agent?.status !== 'needs-input') log(peek(name).slice(-2000))
  // Crush's permission dialog: "Allow" is focused, Enter confirms. The herdr report comes as the
  // request is made; the dialog is drawn a moment later, so wait for it before pressing Enter.
  const dialogShown = () => /Permission Required/.test(peek(name, 80))
  for (let i = 0; i < 40 && !dialogShown(); i++) await sleep(250)
  await sleep(500)
  await type(name, '\r')
  const done = await waitStatus(name, ['finished'], 120_000)
  // The answer (the person's key) moves it on at once, and Crush's own idle ends the turn. (Its
  // working after the answer can be shorter than a poll, or never sent: Crush 0.98 may already
  // have reported working right after the question — nsq drops that echo.)
  const reports = herdrReports()
  const afterQuestion = reports.slice(reports.lastIndexOf('blocked') + 1)
  check(
    'crush: answered → working → finished',
    done.agent?.status === 'finished' &&
      !done.seen[0]?.startsWith('needs-input') &&
      afterQuestion.includes('idle'),
    { seen: done.seen, reports }
  )
  check(
    'crush: the command ran',
    existsSync(join(sandbox.project, e2e.PERM_DIR)),
    peek(name).slice(-600)
  )
  const records = JSON.parse(readFileSync(join(sandbox.env.NSQ_HOME, 'agents.json'), 'utf8'))
  const record = records.agents.find((a) => a.name === name)
  check(
    'crush: its session id recorded (from the herdr report)',
    typeof record?.harnessSessionId === 'string' && record.harnessSessionId.length > 0,
    record?.harnessSessionId
  )
  nsq('stop', name)
} catch (error) {
  check('herdr.mjs: crashed', false, String(error?.stack ?? error))
} finally {
  stopDaemon(nsq, sandbox.env.NSQ_HOME)
  await Promise.race([fake.close(), sleep(3000)])
  writeChecks(work, rows)
  const failed = rows.filter((row) => !row.ok).length
  log(`${rows.length - failed}/${rows.length} checks passed; work dir ${work}`)
  process.exit(failed ? 1 : 0)
}
