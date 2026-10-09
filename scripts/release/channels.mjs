#!/usr/bin/env node
// Fills the install-channel manifests in packaging/ for a published nsq release and (optionally)
// opens the pull request to our tap / bucket. Run by a maintainer after the npm release
// (RELEASING.md, step 5); uses the signed-in `gh` account, no tokens in argv or files.
//
//   node scripts/release/channels.mjs homebrew [--version X] [--out <file>] [--pr [--draft]]
//   node scripts/release/channels.mjs scoop    [--version X] [--out <file>] [--pr [--draft]]
//   node scripts/release/channels.mjs winget   [--version X] [--out <dir>]
//
// Homebrew and Scoop install the npm package: the version and the tarball come from the npm
// registry (the tarball's sha512 `integrity` is verified, then its sha256 is computed), never typed
// by hand. --placeholder fills version 0.0.0-placeholder and an all-zero hash without the registry
// (only for preparing a draft PR before the first release). winget needs the standalone Windows
// zips from the GitHub release (their `digest`); it validates with `winget validate` when present
// and prints the next step — RELEASING.md, "winget".

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO = 'glmn-ai/neurosquad-cli'
const TAP = { repo: 'glmn-ai/homebrew-neurosquad', base: 'main', path: 'Formula/neurosquad-cli.rb' }
const BUCKET = {
  repo: 'glmn-ai/scoop-neurosquad',
  base: 'master',
  path: 'bucket/neurosquad-cli.json'
}
const ZERO = '0'.repeat(64)

const [channel, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (!a.startsWith('--')) continue
  const next = rest[i + 1]
  args[a.slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next)
}
if (!['homebrew', 'scoop', 'winget'].includes(channel)) {
  console.error(
    'usage: channels.mjs homebrew|scoop|winget [--version X] [--out path] [--pr [--draft]] [--placeholder]'
  )
  process.exit(2)
}

// The CLI's npm name: from apps/cli/package.json when it exists, else the planned default.
const cliPkgPath = join(root, 'apps', 'cli', 'package.json')
const npmName = String(
  args.package ??
    (existsSync(cliPkgPath) ? JSON.parse(readFileSync(cliPkgPath, 'utf8')).name : 'neurosquad')
)
const npmBasename = npmName.split('/').pop()
const gh = (argv, input) =>
  execFileSync('gh', argv, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  })

async function npmRelease() {
  if (args.placeholder)
    return { version: '0.0.0-placeholder', sha256: ZERO, tag: `${npmName}@0.0.0-placeholder` }
  const meta = await (
    await globalThis.fetch(`https://registry.npmjs.org/${npmName.replace('/', '%2F')}`)
  ).json()
  if (meta.error) throw new Error(`npm: ${npmName}: ${meta.error}`)
  const version = String(args.version ?? meta['dist-tags']?.latest)
  const dist = meta.versions?.[version]?.dist
  if (!dist) throw new Error(`npm: ${npmName}@${version} is not published`)
  const expectedUrl = `https://registry.npmjs.org/${npmName}/-/${npmBasename}-${version}.tgz`
  if (dist.tarball !== expectedUrl) throw new Error(`npm: unexpected tarball URL ${dist.tarball}`)
  const bytes = Buffer.from(await (await globalThis.fetch(dist.tarball)).arrayBuffer())
  const [algo, b64] = String(dist.integrity).split('-')
  if (algo !== 'sha512' || createHash('sha512').update(bytes).digest('base64') !== b64) {
    throw new Error(
      `npm: ${npmName}@${version}: the tarball does not match its integrity ${dist.integrity}`
    )
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  console.log(`${npmName}@${version}: ${bytes.length} bytes, sha256 ${sha256} (integrity verified)`)
  return { version, sha256, tag: `${npmName}@${version}` }
}

function fill(text, values) {
  let out = text
  for (const [k, v] of Object.entries(values)) out = out.replaceAll(`{{${k}}}`, v)
  const left = out.match(/\{\{\w+\}\}/)
  if (left) throw new Error(`unfilled placeholder ${left[0]}`)
  return out
}

async function openPr({ repo, base, path }, content, version) {
  const branch = `neurosquad-cli/${version}`
  const dir = mkdtempSync(join(tmpdir(), 'nsq-channel-'))
  try {
    gh(['repo', 'clone', repo, dir, '--', '--depth', '1', '--branch', base])
    const git = (...a) =>
      execFileSync('git', ['-C', dir, ...a], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    git('switch', '-c', branch)
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
    git('add', path)
    const title = `${path
      .split('/')
      .pop()
      .replace(/\.(rb|json)$/, '')} ${version}`
    git('commit', '-m', `${title}\n\nGenerated by ${REPO} scripts/release/channels.mjs.`)
    // Credentials come from gh's git credential helper; nothing secret on the command line.
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        'push',
        '--force',
        'origin',
        branch
      ],
      { stdio: 'inherit' }
    )
    const body = [
      `${title}, generated from the [${REPO}](https://github.com/${REPO}) release pipeline (\`scripts/release/channels.mjs\`).`,
      args.placeholder
        ? '\n**Draft placeholder: do not merge before the first npm release.** Re-run the script after the release to fill the real version and hash.'
        : ''
    ].join('\n')
    const existing = gh([
      'pr',
      'list',
      '-R',
      repo,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'url',
      '--jq',
      '.[0].url'
    ]).trim()
    if (existing) console.log(`updated ${existing}`)
    else
      console.log(
        gh([
          'pr',
          'create',
          '-R',
          repo,
          '--base',
          base,
          '--head',
          branch,
          '--title',
          title,
          '--body',
          body,
          ...(args.draft || args.placeholder ? ['--draft'] : [])
        ]).trim()
      )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (channel === 'homebrew' || channel === 'scoop') {
  const rel = await npmRelease()
  const template = join(
    root,
    'packaging',
    channel === 'homebrew' ? 'homebrew/neurosquad-cli.rb' : 'scoop/neurosquad-cli.json'
  )
  const text = fill(readFileSync(template, 'utf8'), {
    NPM_NAME: npmName,
    NPM_BASENAME: npmBasename,
    VERSION: rel.version,
    SHA256: rel.sha256
  })
  // The formula's header comment describes the template, not the generated file.
  const content = channel === 'homebrew' ? text.replace(/^(#.*\n)+/, '') : text
  if (channel === 'scoop') JSON.parse(content)
  if (args.out) {
    writeFileSync(resolve(String(args.out)), content)
    console.log(`wrote ${args.out}`)
  } else if (!args.pr) process.stdout.write(content)
  if (args.pr) await openPr(channel === 'homebrew' ? TAP : BUCKET, content, rel.version)
} else {
  // winget: the standalone zips must be assets of the GitHub release of the CLI.
  const tag = String(args.tag ?? `${npmName}@${args.version ?? ''}`)
  if (!args.version && !args.tag)
    throw new Error('winget: pass --version X (or --tag <release tag>)')
  const release = JSON.parse(gh(['api', `repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`]))
  const version = String(args.version ?? tag.split('@').pop())
  const digest = (arch) => {
    const asset = release.assets.find((a) => a.name === `nsq-${version}-win-${arch}.zip`)
    const m = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '')
    if (!m)
      throw new Error(
        `winget: release ${tag} has no nsq-${version}-win-${arch}.zip with a sha256 digest (the standalone Windows build — RELEASING.md, "winget")`
      )
    return m[1].toUpperCase()
  }
  const values = {
    VERSION: version,
    TAG: encodeURIComponent(tag),
    RELEASE_DATE: release.published_at.slice(0, 10),
    SHA256_X64: digest('x64'),
    SHA256_ARM64: digest('arm64')
  }
  const out = resolve(String(args.out ?? join(tmpdir(), `nsq-winget-${version}`)))
  mkdirSync(out, { recursive: true })
  const templates = join(root, 'packaging', 'winget')
  for (const name of readdirSync(templates).filter((f) => f.endsWith('.yaml'))) {
    writeFileSync(join(out, name), fill(readFileSync(join(templates, name), 'utf8'), values))
  }
  console.log(`winget: manifests in ${out}`)
  try {
    execFileSync('winget', ['validate', '--manifest', out], { stdio: 'inherit' })
  } catch (error) {
    if (error.code === 'ENOENT') console.log('winget: `winget` not found — skipped validation')
    else throw new Error('winget validate failed', { cause: error })
  }
  console.log(
    'Next: open the PR to microsoft/winget-pkgs (manifests/n/NeuroSquad/CLI/<version>/) — RELEASING.md, "winget".'
  )
}
