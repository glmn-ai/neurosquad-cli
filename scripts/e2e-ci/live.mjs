// One live e2e suite of the CI matrix, on this runner. The CLIs come from
// install-clis.mjs (--clis <prefix>), the scenarios from the repository under
// test (--root): scripts/e2e/run.mjs plus this folder's extra.mjs, or the
// dashboard recording and dictation.
//
//   claude | codex | opencode-1 | opencode-2
//       run.mjs: hello, perm (needs you + inline answer), phone, resume after a
//       daemon restart, cost vs the fake's log, OpenRouter attribution headers,
//       worktree; extra.mjs: interrupt, question
//   dashboard
//       tui-record.mjs (real pty, 3 agents, keys, BEL/OSC 9 ring, asciicast),
//       dictation.mjs (synthesised speech → Whisper tiny.en → paste)
//
// Writes <out>/results.json: { os, arch, suite, versions, parts: [{ part, exit, checks }] }.
//
//   node scripts/e2e-ci/live.mjs --suite <name> --root <repo> --clis <prefix> --out <dir>
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { args, HERE, makeNsq, rootFrom } from './lib.mjs'

const { get } = args()
const root = rootFrom(get)
const suite = get('suite')
const clis = resolve(get('clis', join(root, '..', '.nsq-e2e', 'clis')))
const out = resolve(get('out', join(root, '..', '.nsq-e2e', `live-${suite}`)))
mkdirSync(out, { recursive: true })
const installed = existsSync(join(clis, 'installed.json'))
  ? JSON.parse(readFileSync(join(clis, 'installed.json'), 'utf8'))
  : {}

const SUITES = {
  claude: { harness: 'claude', set: 'main' },
  codex: { harness: 'codex', set: 'main' },
  'opencode-1': { harness: 'opencode', set: 'main' },
  'opencode-2': { harness: 'opencode', set: 'oc2' },
  dashboard: { set: 'main' }
}
const plan = SUITES[suite]
if (!plan) throw new Error(`unknown suite ${suite}; one of ${Object.keys(SUITES).join(', ')}`)
const bin = installed[plan.set]?.bin
if (!bin) throw new Error(`CLI set "${plan.set}" is not installed under ${clis}`)

// What this build of nsq has (the workflow can test any ref).
const { help } = makeNsq(root, process.env, root)
const usage = help()
const hasPhone = /nsq phone/.test(usage)

const parts = []
function part(name, script, scriptArgs, work) {
  console.log(`\n::group::${suite} · ${name}`)
  const started = Date.now()
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    stdio: 'inherit',
    timeout: 25 * 60_000
  })
  console.log('::endgroup::')
  let checks = []
  try {
    checks = JSON.parse(readFileSync(join(work, 'checks.json'), 'utf8'))
  } catch {
    checks = [{ name: `${name}: produced no checks`, ok: false }]
  }
  if (result.status !== 0 && checks.every((check) => check.ok))
    checks.push({ name: `${name}: exited ${result.status ?? result.signal}`, ok: false })
  parts.push({ part: name, exit: result.status, seconds: (Date.now() - started) / 1000, checks })
}

if (plan.harness) {
  const steps = [
    'hello',
    'perm',
    ...(hasPhone ? ['phone'] : []),
    'resume',
    'update',
    'cost',
    'openrouter',
    'worktree'
  ]
  const runWork = join(out, 'run')
  part(
    'run.mjs',
    join(root, 'scripts', 'e2e', 'run.mjs'),
    ['--harness', plan.harness, '--bin', bin, '--work', runWork, '--only', steps.join(',')],
    runWork
  )
  const extraWork = join(out, 'extra')
  part(
    'extra.mjs',
    join(HERE, 'extra.mjs'),
    ['--root', root, '--harness', plan.harness, '--bin', bin, '--work', extraWork],
    extraWork
  )
} else {
  const recordOut = join(out, 'recording')
  part(
    'tui-record.mjs',
    join(HERE, 'tui-record.mjs'),
    [
      '--root',
      root,
      '--bin',
      bin,
      '--out',
      recordOut,
      ...(process.platform === 'linux' ? ['--native-notify', '--headless-check'] : []),
      ...(get('display') ? ['--display', get('display')] : [])
    ],
    recordOut
  )
  const dictationWork = join(out, 'dictation')
  part(
    'dictation.mjs',
    join(HERE, 'dictation.mjs'),
    [
      '--root',
      root,
      '--work',
      dictationWork,
      ...(get('models') ? ['--models', resolve(get('models'))] : [])
    ],
    dictationWork
  )
}

const results = {
  os: get('os-label', `${process.platform}-${process.arch}`),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  suite,
  versions: installed[plan.set]?.versions ?? {},
  parts
}
// Failures of an open nsq bug (known.json) are reported with their issue, not failing the job.
const { known } = JSON.parse(readFileSync(join(HERE, 'known.json'), 'utf8'))
const all = parts.flatMap((p) => p.checks)
for (const check of all) {
  const entry = known.find((k) => k.check === check.name)
  if (entry) check.known = entry.issue
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
const failed = all.filter((check) => !check.ok && !check.known)
const knownFailed = all.filter((check) => !check.ok && check.known)
for (const check of all.filter((c) => c.ok && c.known))
  console.log(`::notice::known failure now passes — drop it from known.json: ${check.name}`)
console.log(
  `\n${suite} on ${results.os}: ${all.filter((c) => c.ok).length}/${all.length} checks passed` +
    (knownFailed.length
      ? `\nknown (open issues):\n  ${knownFailed.map((c) => `${c.name} — ${c.known}`).join('\n  ')}`
      : '') +
    (failed.length ? `\nfailed:\n  ${failed.map((check) => check.name).join('\n  ')}` : '')
)
process.exitCode = failed.length ? 1 : 0
