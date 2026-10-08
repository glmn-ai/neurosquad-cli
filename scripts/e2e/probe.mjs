// Debug helper: start the fake and a sandbox, run one agent, print its screen
// after a while, stop everything.
//   node scripts/e2e/probe.mjs <harness> "<prompt>" [--bin dir] [--wait 20] [--work dir] [--keys "..."]
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeModel } from './fake-model.mjs'
import { makeSandbox } from './sandbox.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(ROOT, 'apps', 'cli', 'bin', 'nsq.js')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : fallback
}
const [harness, prompt] = argv
const work = resolve(arg('work', join(ROOT, '..', '.nsq-e2e', `probe-${Date.now()}`)))
mkdirSync(work, { recursive: true })
const fake = await startFakeModel({ logFile: join(work, 'fake-requests.jsonl') })
const sandbox = makeSandbox(work, fake.base, { binDirs: arg('bin') ? [resolve(arg('bin'))] : [] })
const nsq = (...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    env: sandbox.env,
    cwd: sandbox.project,
    encoding: 'utf8',
    windowsHide: true
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  console.log(nsq('run', harness, '--name', 'probe', ...(prompt ? [prompt] : [])).stdout)
  await sleep(Number(arg('wait', '20')) * 1000)
  if (arg('raw')) {
    nsq('_input', 'probe', arg('raw'))
    await sleep(3000)
  }
  if (arg('keys')) {
    nsq('answer', 'probe', arg('keys'))
    await sleep(8000)
  }
  console.log(nsq('ls').stdout)
  console.log(nsq('peek', 'probe', '-n', '50').stdout)
  for (const r of fake.requests)
    console.log(
      r.path,
      r.scenario ?? '-',
      r.step ?? '-',
      r.replied ?? r.status,
      (r.tools ?? []).join(',')
    )
} finally {
  nsq('down')
  await fake.close()
  try {
    console.log(
      readFileSync(join(work, 'nsq', 'daemon.log'), 'utf8')
        .split('\n')
        .slice(-8)
        .join('\n')
    )
  } catch {}
}
