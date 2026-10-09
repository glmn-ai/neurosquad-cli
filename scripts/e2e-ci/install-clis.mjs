// Installs the real harness CLIs for the live e2e into an isolated prefix —
// never globally, never into the repository — one folder per set (both
// OpenCode lines ship an `opencode` binary, so they cannot share a .bin):
//
//   <prefix>/main  Claude Code, Codex, OpenCode 1.x
//   <prefix>/oc2   OpenCode 2.x
//
// Writes <prefix>/installed.json ({ set: { bin, versions } }) for live.mjs.
//
//   node scripts/e2e-ci/install-clis.mjs --prefix <dir> [--channel pinned|latest] [--sets main,oc2]
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : fallback
}
const prefix = resolve(arg('prefix', join(HERE, '..', '..', '..', '.nsq-e2e', 'clis')))
const channel = arg('channel', 'pinned')
const { sets } = JSON.parse(readFileSync(join(HERE, 'clis.json'), 'utf8'))
const wanted = arg('sets', Object.keys(sets).join(',')).split(',').filter(Boolean)

const installed = {}
let failed = false
for (const set of wanted) {
  const packages = sets[set]?.[channel]
  if (!packages) throw new Error(`unknown set/channel: ${set}/${channel}`)
  const dir = join(prefix, set)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `nsq-e2e-${set}`, private: true })
  )
  const specs = Object.entries(packages).map(([name, version]) => `${name}@${version}`)
  console.log(`[${set}] npm install ${specs.join(' ')}`)
  // Fixed arguments (no user input), so a shell on Windows (npm is a .cmd there) is safe.
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...specs], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    console.error(`[${set}] npm install failed (${result.status})`)
    failed = true
    continue
  }
  const versions = {}
  for (const name of Object.keys(packages)) {
    try {
      versions[name] = JSON.parse(
        readFileSync(join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')
      ).version
    } catch {
      versions[name] = null
    }
  }
  installed[set] = { bin: join(dir, 'node_modules', '.bin'), versions }
  console.log(`[${set}]`, JSON.stringify(versions))
}
writeFileSync(join(prefix, 'installed.json'), JSON.stringify(installed, null, 2))
process.exitCode = failed ? 1 : 0
