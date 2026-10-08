#!/usr/bin/env node
// One-time npm setup for trusted publishing, run by the package OWNER on their own machine with
// their own `npm login` session (2FA in the browser). It never reads, takes or prints a token.
//
// npm can only attach a trusted publisher to a package that already exists, and a new trusted
// publisher expires if it has not published within 2 days. Hence two steps:
//
//   reserve  publish a 0.0.0 placeholder (no code, just a README) for every public package that is
//            not on npm yet. Safe to do any time; it also reserves the names.
//   trust    bind each package to GitHub Actions: repo glmn-ai/neurosquad-cli, workflow
//            release.yml, environment npm, publish allowed. Do it at most 2 days before the
//            first real release (RELEASING.md, "First release").
//
//   node scripts/release/npm-bootstrap.mjs reserve            # dry run: shows what it would do
//   node scripts/release/npm-bootstrap.mjs reserve --apply
//   node scripts/release/npm-bootstrap.mjs trust --apply
//   node scripts/release/npm-bootstrap.mjs status             # what exists, which trust is set
//   node scripts/release/npm-bootstrap.mjs deprecate-placeholders --apply   # after the first release
//
// Packages: every workspace without "private": true (override with --packages a,b,c).
// Needs npm >= 11.15 (`npm trust`) and 2FA on the npm account.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'glmn-ai/neurosquad-cli'
const WORKFLOW = 'release.yml'
const ENVIRONMENT = 'npm'
const PLACEHOLDER = '0.0.0'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const isWindows = process.platform === 'win32'
const [command, ...rest] = process.argv.slice(2)
const apply = rest.includes('--apply')
const pkgArg = rest.indexOf('--packages')
const only = pkgArg >= 0 ? rest[pkgArg + 1]?.split(',').filter(Boolean) : undefined

const npmCli = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
].find((p) => existsSync(p))
function npm(argv, { cwd = root, interactive = false } = {}) {
  const [cmd, pre] = npmCli ? [process.execPath, [npmCli]] : [isWindows ? 'npm.cmd' : 'npm', []]
  return execFileSync(cmd, [...pre, ...argv], {
    cwd,
    encoding: 'utf8',
    shell: !npmCli && isWindows,
    // Interactive: npm prints the 2FA/web-login URL and waits; let the owner see and answer it.
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe']
  })
}
function exists(name) {
  try {
    return npm(['view', name, 'versions', '--json']).trim() !== ''
  } catch (error) {
    if (/E404|404 Not Found/.test(`${error.stderr}`)) return false
    throw error
  }
}

const usage = () => {
  console.log(
    'usage: npm-bootstrap.mjs reserve|trust|status|deprecate-placeholders [--apply] [--packages a,b]'
  )
  process.exit(2)
}
if (!['reserve', 'trust', 'status', 'deprecate-placeholders'].includes(command)) usage()

const npmVersion = npm(['--version']).trim()
const [maj, min] = npmVersion.split('.').map(Number)
if (command === 'trust' && (maj < 11 || (maj === 11 && min < 15))) {
  console.error(`npm ${npmVersion}: \`npm trust\` needs npm >= 11.15 (npm install -g npm@^11.15.0)`)
  process.exit(1)
}

const workspaces = JSON.parse(npm(['query', '.workspace']))
const packages = (only ?? workspaces.filter((w) => w.private !== true).map((w) => w.name)).sort()
if (packages.length === 0) {
  console.log('No public packages found.')
  process.exit(0)
}
const whoami = (() => {
  try {
    return npm(['whoami']).trim()
  } catch {
    return undefined
  }
})()
console.log(
  `npm ${npmVersion}, logged in as: ${whoami ?? '(not logged in — run `npm login` first)'}`
)
console.log(`packages: ${packages.join(', ')}${apply ? '' : '   [dry run — add --apply]'}\n`)
if (apply && !whoami && command !== 'status') process.exit(1)

for (const name of packages) {
  const onNpm = exists(name)
  if (command === 'status') {
    let trust = 'n/a'
    if (onNpm) {
      try {
        trust = npm(['trust', 'list', name]).trim() || 'none'
      } catch (error) {
        trust = `unknown (${`${error.stderr}`.trim().split('\n').pop()})`
      }
    }
    console.log(`${name}: ${onNpm ? 'on npm' : 'NOT on npm'}; trusted publisher: ${trust}`)
    continue
  }

  if (command === 'reserve') {
    if (onNpm) {
      console.log(`${name}: already on npm — skipped`)
      continue
    }
    console.log(`${name}: publish placeholder ${PLACEHOLDER}`)
    if (!apply) continue
    const dir = mkdtempSync(join(tmpdir(), 'nsq-reserve-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        `${JSON.stringify(
          {
            name,
            version: PLACEHOLDER,
            description: `Placeholder for ${name} (part of nsq — https://github.com/${REPO}). The first real release follows.`,
            license: 'MIT',
            repository: { type: 'git', url: `git+https://github.com/${REPO}.git` },
            homepage: `https://github.com/${REPO}`
          },
          null,
          2
        )}\n`
      )
      writeFileSync(
        join(dir, 'README.md'),
        `# ${name}\n\nPlaceholder: this version holds no code. ${name} is part of [nsq](https://github.com/${REPO}); install a real release once it is out.\n`
      )
      npm(['publish', '--access', 'public'], { cwd: dir, interactive: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    continue
  }

  if (command === 'trust') {
    if (!onNpm) {
      console.log(`${name}: not on npm yet — run \`reserve --apply\` first`)
      process.exitCode = 1
      continue
    }
    const argv = [
      'trust',
      'github',
      name,
      '--file',
      WORKFLOW,
      '--repo',
      REPO,
      '--env',
      ENVIRONMENT,
      '--allow-publish',
      '--yes'
    ]
    console.log(`${name}: npm ${argv.join(' ')}`)
    if (!apply) continue
    npm(argv, { interactive: true })
    // Rate limit (npm recommends ~2 s between trust calls).
    await new Promise((r) => setTimeout(r, 2000))
    continue
  }

  if (command === 'deprecate-placeholders') {
    if (!onNpm) continue
    const versions = JSON.parse(npm(['view', name, 'versions', '--json']))
    if (![versions].flat().includes(PLACEHOLDER)) continue
    const msg = 'Placeholder without code; install the latest version.'
    console.log(`${name}@${PLACEHOLDER}: npm deprecate "${msg}"`)
    if (apply) npm(['deprecate', `${name}@${PLACEHOLDER}`, msg], { interactive: true })
  }
}
