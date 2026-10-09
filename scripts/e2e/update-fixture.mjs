// Test doubles for nsq's updater (apps/cli/src/update): a copy of the built CLI laid out like an
// `npm install -g` (so nsq detects "npm" and updates itself), a stand-in npm that "installs" a
// version by rewriting that copy's package.json, and a stand-in registry. Nothing is published
// and the real registry is never asked.
//
// Used by apps/cli/src/update/update.e2e.test.ts and the `update` step of scripts/e2e/run.mjs.
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

/**
 * Copies the built CLI (apps/cli: bin, dist, package.json at `version`) into
 * `<work>/prefix` the way npm installs a global package, with the repository's node_modules
 * linked for its dependencies. Returns the copy's `nsq` script and an environment for it.
 */
export function makeInstalledCopy({ root, work, version, registry }) {
  const win = process.platform === 'win32'
  const prefix = join(work, 'prefix')
  const nodeModules = win ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
  const packageDir = join(nodeModules, 'neurosquad')
  const cli = join(root, 'apps', 'cli')
  mkdirSync(packageDir, { recursive: true })
  cpSync(join(cli, 'bin'), join(packageDir, 'bin'), { recursive: true })
  cpSync(join(cli, 'dist'), join(packageDir, 'dist'), { recursive: true })
  const pkg = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'))
  pkg.version = version
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  symlinkSync(join(root, 'node_modules'), join(packageDir, 'node_modules'), 'junction')
  // npm's command shim next to the package marks a global install.
  if (win) {
    writeFileSync(
      join(prefix, 'nsq.cmd'),
      '@node "%~dp0node_modules\\neurosquad\\bin\\nsq.js" %*\r\n'
    )
  } else {
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    writeFileSync(join(prefix, 'bin', 'nsq'), '#!/bin/sh\n', { mode: 0o755 })
  }
  const npmLog = join(work, 'fake-npm.jsonl')
  const fakeNpm = join(work, 'fake-npm.mjs')
  writeFileSync(
    fakeNpm,
    [
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      'const args = process.argv.slice(2)',
      `appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args) + '\\n')`,
      'if (process.env.NSQ_FAKE_NPM_FAIL) {',
      "  console.error('npm error code E500')",
      "  console.error('npm error 500 Internal Server Error - GET fake-registry/neurosquad')",
      '  process.exit(1)',
      '}',
      'const spec = args[args.length - 1]',
      "const version = spec.slice(spec.lastIndexOf('@') + 1)",
      "const prefix = args[args.indexOf('--prefix') + 1]",
      `const file = join(prefix, ${win ? "''" : "'lib'"}, 'node_modules', 'neurosquad', 'package.json')`,
      "const pkg = JSON.parse(readFileSync(file, 'utf8'))",
      'pkg.version = version',
      "writeFileSync(file, JSON.stringify(pkg, null, 2) + '\\n')",
      "console.log('changed 1 package')",
      ''
    ].join('\n')
  )
  return {
    prefix,
    packageDir,
    bin: join(packageDir, 'bin', 'nsq.js'),
    npmLog,
    readNpmCalls: () => {
      try {
        return readFileSync(npmLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
    env: {
      NSQ_UPDATE_REGISTRY: registry,
      NSQ_UPDATE_NPM: fakeNpm,
      // The updater stays off in CI; this run checks it.
      CI: ''
    }
  }
}

/** A registry that serves the abbreviated metadata of `neurosquad` with an ETag, and logs requests. */
export async function startFakeRegistry({ latest, engines = '>=22.13' }) {
  const requests = []
  let current = latest
  const etag = () => `"nsq-${current}"`
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: { ...req.headers } })
    if (req.url !== '/neurosquad') {
      res.writeHead(404).end('{}')
      return
    }
    if (req.headers['if-none-match'] === etag()) {
      res.writeHead(304, { etag: etag() }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/vnd.npm.install-v1+json', etag: etag() })
    res.end(
      JSON.stringify({
        name: 'neurosquad',
        'dist-tags': { latest: current },
        versions: {
          [current]: { name: 'neurosquad', version: current, engines: { node: engines } }
        }
      })
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    setLatest: (version) => {
      current = version
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/** `0.1.0` → `0.1.1` */
export function nextPatch(version) {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}
