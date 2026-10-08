#!/usr/bin/env node
// Packs every public workspace exactly as `npm publish` would, installs the tarballs into a clean
// folder the way a user would get them, and checks that they work there:
//
//   - each tarball holds its README, LICENSE, `main`/`exports` targets and `bin` targets;
//   - every package's entry point imports;
//   - every `bin` runs (`nsq --version` prints the package version), through npm's own shim too;
//   - every native addon in the installed tree loads from a PREBUILT binary on this OS/arch/Node
//     (see NATIVE below; node-pty also spawns a real process).
//
// Two install modes:
//   ignore-scripts  `npm install --ignore-scripts` — no install script runs, so nothing can be
//                   compiled: an addon that loads here loads from a prebuild. Homebrew's
//                   std_npm_args install like this, and npm is moving to blocking unreviewed
//                   install scripts by default for `npm i -g` and `npx`.
//   default         a plain `npm install`, what most users run today.
//
//   node scripts/release/pack-smoke.mjs [--mode both|ignore-scripts|default] [--work <parent dir>] [--root <repo>] [--keep]
//
// Run `npm run build` first. Exit code 1 on any failure; a Markdown report goes to stdout and,
// on GitHub Actions, to the job summary. Uses only the public npm registry for third-party
// dependencies; our own packages come from the local tarballs, never from the registry.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const isWindows = process.platform === 'win32'
const target = `${process.platform}-${process.arch}`

const args = { mode: 'both', work: undefined, root: undefined, keep: false }
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--keep') args.keep = true
  else if (a === '--mode' || a === '--work' || a === '--root') {
    const value = process.argv[++i]
    if (!value || value.startsWith('-')) {
      console.error(`pack-smoke: ${a} needs a value`)
      process.exit(2)
    }
    args[a.slice(2)] = value
  } else {
    console.error(`pack-smoke: unknown argument ${a}`)
    process.exit(2)
  }
}
if (args.root) root = resolve(args.root)
const modes = args.mode === 'both' ? ['ignore-scripts', 'default'] : [args.mode]
if (!modes.every((m) => m === 'ignore-scripts' || m === 'default')) {
  console.error(`pack-smoke: --mode must be both, ignore-scripts or default`)
  process.exit(2)
}

// Native addons we ship (directly or through a helper package) and where each must load from a
// prebuild. `required`: the platforms where a load failure fails the run; elsewhere a failure is
// reported as a warning (the feature degrades, nsq still runs). A module that is not in the
// installed tree is skipped. `probe` exercises more than `require` where that is cheap and safe.
const ALL = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']
const NATIVE = [
  { name: 'node-pty', required: ALL, probe: 'pty' },
  { name: '@lydell/node-pty', required: ALL, probe: 'pty' },
  { name: '@napi-rs/keyring', required: ALL },
  // libuiohook needs X11 libraries on Linux; a server without them has no global hotkey.
  { name: 'uiohook-napi', required: ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64'] },
  // sherpa-onnx publishes no win32-arm64 build.
  {
    name: 'sherpa-onnx-node',
    required: ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']
  },
  // pvrecorder ships Linux arm64 only for Raspberry Pi CPUs.
  {
    name: '@picovoice/pvrecorder-node',
    required: ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64']
  }
]

const results = [] // { mode, check, status: 'ok' | 'warn' | 'fail' | 'skip', detail }
const record = (mode, check, status, detail = '') => {
  results.push({ mode, check, status, detail })
  const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', skip: 'skip' }[status]
  console.log(`[${mark}] ${mode ? `${mode}: ` : ''}${check}${detail ? ` — ${detail}` : ''}`)
}

const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') // Unix layout
].find((p) => p && /npm-cli\.c?js$/.test(p) && existsSync(p))
function npm(argv, opts = {}) {
  // Run npm through node + npm-cli.js when we know where it is (no shell, no .cmd quoting);
  // otherwise through the platform shim.
  const [cmd, pre] = npmCli ? [process.execPath, [npmCli]] : [isWindows ? 'npm.cmd' : 'npm', []]
  return execFileSync(cmd, [...pre, ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: !npmCli && isWindows,
    maxBuffer: 64 * 1024 * 1024,
    ...opts
  })
}

// Always a fresh folder of our own (under --work when given): cleanup removes only that folder.
const parent = args.work ? resolve(args.work) : tmpdir()
mkdirSync(parent, { recursive: true })
const work = mkdtempSync(join(parent, 'nsq-pack-smoke-'))
const tarballDir = join(work, 'tarballs')
mkdirSync(tarballDir, { recursive: true })

let exitCode = 0
try {
  // ------------------------------------------------------------------ pack
  const workspaces = JSON.parse(npm(['query', '.workspace'], { cwd: root }))
  const publicWs = workspaces.filter((w) => w.private !== true)
  if (publicWs.length === 0) {
    record('', 'workspaces', 'skip', 'no public workspace packages yet')
  }
  const packed = []
  for (const ws of publicWs) {
    const out = JSON.parse(
      npm(['pack', '--json', '--pack-destination', tarballDir], { cwd: ws.path })
    )[0]
    const files = new Set(out.files.map((f) => f.path.replace(/\\/g, '/')))
    const pkg = JSON.parse(readFileSync(join(ws.path, 'package.json'), 'utf8'))
    const missing = []
    for (const f of ['package.json', 'README.md', 'LICENSE']) if (!files.has(f)) missing.push(f)
    for (const f of entryFiles(pkg)) if (!files.has(f)) missing.push(f)
    for (const f of Object.values(binMap(pkg))) if (!files.has(norm(f))) missing.push(norm(f))
    record(
      '',
      `pack ${pkg.name}@${pkg.version} (${out.files.length} files, ${(out.size / 1024).toFixed(0)} KiB)`,
      missing.length ? 'fail' : 'ok',
      missing.length ? `missing from the tarball: ${missing.join(', ')}` : ''
    )
    packed.push({ pkg, tarball: join(tarballDir, out.filename) })
  }

  // ------------------------------------------------------------------ install + check, per mode
  for (const mode of packed.length ? modes : []) {
    const dir = join(work, `install-${mode}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'nsq-pack-smoke', private: true }, null, 2)
    )
    try {
      npm(
        [
          'install',
          '--no-audit',
          '--no-fund',
          '--no-package-lock',
          ...(mode === 'ignore-scripts' ? ['--ignore-scripts'] : []),
          ...packed.map((p) => p.tarball)
        ],
        { cwd: dir }
      )
      record(mode, `npm install ${packed.length} tarball(s)`, 'ok')
    } catch (error) {
      record(mode, 'npm install', 'fail', tail(error))
      continue
    }

    for (const { pkg } of packed) {
      const pkgDir = join(dir, 'node_modules', ...pkg.name.split('/'))
      // Entry point imports (a top-level import of an optional native peer would fail here).
      if (pkg.main || pkg.exports) {
        const r = runNode(
          ['--input-type=module', '-e', `await import(${JSON.stringify(pkg.name)})`],
          dir
        )
        record(
          mode,
          `import ${pkg.name}`,
          r.status === 0 ? 'ok' : 'fail',
          r.status === 0 ? '' : r.err
        )
      }
      // Every bin: directly with node, and through npm's shim in node_modules/.bin.
      for (const [name, rel] of Object.entries(binMap(pkg))) {
        const direct = runNode([join(pkgDir, rel), '--version'], dir)
        const out = direct.out.trim()
        const versionOk = direct.status === 0 && out.includes(pkg.version)
        record(
          mode,
          `${name} --version`,
          versionOk ? 'ok' : 'fail',
          versionOk
            ? out
            : `exit ${direct.status}, stdout "${out}", expected ${pkg.version}; ${direct.err}`
        )
        const shim = join(dir, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name)
        const viaShim = spawnSync(isWindows ? `"${shim}"` : shim, ['--version'], {
          cwd: dir,
          encoding: 'utf8',
          shell: isWindows,
          timeout: 60_000
        })
        record(
          mode,
          `${name} --version via the npm shim`,
          viaShim.status === 0 ? 'ok' : 'fail',
          viaShim.status === 0
            ? ''
            : `exit ${viaShim.status}: ${(viaShim.stderr || '').trim().slice(-400)}`
        )
      }
    }

    // Native addons anywhere in the installed tree.
    for (const mod of NATIVE) {
      const at = findInstalled(dir, mod.name)
      if (!at) continue
      const version = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')).version
      // node-gyp output (node-pty's postinstall also creates build/Release, but only for conpty.dll).
      const release = join(at, 'build', 'Release')
      const compiled = existsSync(release) && readdirSync(release).some((f) => f.endsWith('.node'))
      const r = runNode(['--input-type=module', '-e', probeScript(at, mod.probe)], dir)
      const must = mod.required.includes(target)
      const label = `native ${mod.name}@${version}${compiled ? ' (compiled from source)' : ''}`
      if (r.status === 0) record(mode, label, 'ok', r.out.trim())
      else record(mode, label, must ? 'fail' : 'warn', `${must ? '' : 'optional here; '}${r.err}`)
    }
  }
} catch (error) {
  record('', 'pack-smoke', 'fail', tail(error))
} finally {
  if (results.some((r) => r.status === 'fail')) exitCode = 1
  report()
  if (!args.keep) rmSync(work, { recursive: true, force: true })
  else console.log(`pack-smoke: kept ${work}`)
}
process.exit(exitCode)

// ------------------------------------------------------------------ helpers

function norm(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

function binMap(pkg) {
  if (!pkg.bin) return {}
  if (typeof pkg.bin === 'string') return { [pkg.name.split('/').pop()]: pkg.bin }
  return pkg.bin
}

function entryFiles(pkg) {
  const files = new Set()
  if (pkg.main) files.add(norm(pkg.main))
  const walk = (v) => {
    if (typeof v === 'string') {
      if (!v.includes('*') && v.startsWith('./') && !v.endsWith('/package.json')) files.add(norm(v))
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(pkg.exports)
  return files
}

function runNode(argv, cwd) {
  const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: 60_000 })
  return {
    status: r.status,
    out: r.stdout || '',
    err: (r.stderr || r.error?.message || '').trim().split('\n').slice(-6).join(' ').slice(-600)
  }
}

function findInstalled(dir, name) {
  // npm hoists; check the top level first, then one level of nesting under our own packages.
  const top = join(dir, 'node_modules', ...name.split('/'))
  if (existsSync(join(top, 'package.json'))) return top
  try {
    const out = npm(['ls', name, '--all', '--parseable'], { cwd: dir })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
    return out.find((p) => existsSync(join(p, 'package.json')))
  } catch {
    return undefined
  }
}

function probeScript(at, probe) {
  const pkgJson = JSON.stringify(join(at, 'package.json'))
  if (probe === 'pty') {
    // Spawn `node -e` in a real pseudo-terminal and wait for its output.
    return `
      import { createRequire } from 'node:module'
      const pty = createRequire(${pkgJson})('./')
      const p = pty.spawn(${JSON.stringify(process.execPath)}, ['-e', 'process.stdout.write("nsq-pty-ok")'], { cols: 80, rows: 24 })
      let out = ''
      const timer = setTimeout(() => { console.error('no output from the pty child in 20 s: ' + JSON.stringify(out)); process.exit(1) }, 20000)
      p.onData((d) => { out += d })
      p.onExit(({ exitCode }) => {
        clearTimeout(timer)
        if (!out.includes('nsq-pty-ok')) { console.error('pty child exited ' + exitCode + ' without the marker: ' + JSON.stringify(out)); process.exit(1) }
        console.log('spawned a pty child')
        process.exit(0)
      })`
  }
  return `
    import { createRequire } from 'node:module'
    const m = createRequire(${pkgJson})('./')
    console.log('loaded (' + Object.keys(m).length + ' exports)')`
}

function tail(error) {
  const text = `${error.stderr || ''}${error.stdout || ''}${error.message || error}`
  return text.trim().split('\n').slice(-12).join('\n').slice(-1500)
}

function report() {
  const icon = { ok: '✅', warn: '⚠️', fail: '❌', skip: '➖' }
  const lines = [
    `### Pack smoke — ${target}, Node ${process.version}`,
    '',
    '| | Mode | Check | Detail |',
    '|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${icon[r.status]} | ${r.mode || '—'} | ${r.check} | ${(r.detail || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`
    ),
    ''
  ]
  const md = lines.join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
  const failed = results.filter((r) => r.status === 'fail').length
  const warned = results.filter((r) => r.status === 'warn').length
  console.log(
    `\npack-smoke: ${results.length} checks, ${failed} failed, ${warned} warnings (${target}, Node ${process.version})`
  )
}
