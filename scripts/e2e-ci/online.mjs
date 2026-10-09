// Online phone access on a CI runner (part of the dashboard suite, once per OS):
//
//   download   the real cloudflared for this OS/arch, fetched by nsq's own downloader from
//              Cloudflare's GitHub release and checked against the published sha256 (the macOS
//              archive unpacked), then `cloudflared --version` runs. GitHub's API rate limit
//              (shared runner IPs) is reported as a skip, not a failure.
//   tunnel     `nsq phone on --online` with a fake cloudflared (scripts/e2e/fake-cloudflared.mjs)
//              that forwards like Cloudflare's edge: the https link is printed with the QR, the page
//              loads through it, a wrong token is refused and locks the address out, the
//              connection shows as internet, `nsq phone off` stops the connector.
//
// No real tunnel is opened from CI.
//
//   node scripts/e2e-ci/online.mjs --root <repo under test> --work <scratch>
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  args,
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
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `online-${Date.now()}`)))
mkdirSync(work, { recursive: true })
const log = makeLog()
const { rows, check, skip } = makeChecks(log)

const remote = await import(
  pathToFileURL(join(root, 'packages', 'remote', 'dist', 'index.js')).href
)

// ---- the real download ------------------------------------------------------------------------
try {
  const binDir = join(work, 'bin')
  const got = await remote.ensureCloudflared({ binDir, findOnPath: async () => null })
  check('download: verified cloudflared in the bin folder', got.source === 'fresh-download', got)
  const version = execFileSync(got.path, ['--version'], { encoding: 'utf8', timeout: 30_000 })
  check(
    'download: cloudflared --version runs',
    /cloudflared version/i.test(version),
    version.trim()
  )
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/HTTP (403|429)/.test(message)) skip('download: verified cloudflared', `GitHub: ${message}`)
  else check('download: verified cloudflared', false, message)
}

// ---- nsq phone on --online with a fake connector -----------------------------------------------
const home = join(work, 'home')
const fakeDir = join(work, 'fake')
mkdirSync(home, { recursive: true })
mkdirSync(fakeDir, { recursive: true })
copyFileSync(
  join(root, 'scripts', 'e2e', 'fake-cloudflared.mjs'),
  join(fakeDir, 'fake-cloudflared.mjs')
)
const env = {
  ...process.env,
  NSQ_HOME: home,
  NSQ_NO_NOTIFY: '1',
  NSQ_CLOUDFLARED: join(fakeDir, 'fake-cloudflared.mjs')
}
const { nsq } = makeNsq(root, env, work, log)
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
try {
  const on = nsq('phone', 'on', '--online', '--port', '0')
  const url = 'https://fake-e2e-tunnel.trycloudflare.com'
  const token = existsSync(join(home, 'phone-token'))
    ? readFileSync(join(home, 'phone-token'), 'utf8').trim()
    : ''
  check('tunnel: nsq phone on --online succeeds', on.status === 0, on.stderr || on.stdout)
  check('tunnel: the https pairing link is shown', on.stdout.includes(`${url}/?t=${token}`))
  check(
    'tunnel: with the warning',
    on.stdout.includes('anyone with this link and token can control your agents')
  )
  const state = JSON.parse(readFileSync(join(fakeDir, 'fake-cloudflared.state.json'), 'utf8'))
  const via = (path, key, ip = '198.51.100.30') =>
    fetch(`http://127.0.0.1:${state.port}${path}`, {
      headers: { 'x-fake-client-ip': ip, ...(key ? { authorization: `Bearer ${key}` } : {}) }
    })
  check('tunnel: the page loads through it', (await via('/', null)).status === 200)
  check('tunnel: the right token is let in', (await via('/api/state', token)).status === 200)
  check(
    'tunnel: a wrong token is refused',
    (await via('/api/state', 'f'.repeat(48), '203.0.113.9')).status === 401
  )
  for (let i = 0; i < 4; i++) await via('/api/state', 'f'.repeat(48), '203.0.113.9')
  check(
    'tunnel: the guessing address is locked out',
    (await via('/api/state', token, '203.0.113.9')).status === 429
  )
  check(
    'tunnel: the phone shows as connected from the internet',
    /\(internet\)/.test(nsq('phone', 'status').stdout)
  )
  nsq('phone', 'off')
  let stopped = false
  for (let i = 0; i < 50 && !stopped; i++) {
    stopped = !alive(state.pid)
    if (!stopped) await sleep(200)
  }
  check('tunnel: nsq phone off stops the connector', stopped)
} catch (error) {
  check('tunnel: ran', false, error instanceof Error ? error.message : String(error))
} finally {
  stopDaemon(nsq, home)
}

writeChecks(work, rows)
process.exitCode = rows.every((row) => row.ok) ? 0 : 1
