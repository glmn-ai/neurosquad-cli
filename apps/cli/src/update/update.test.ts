import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareVersions, isDevVersion, isNewer, nodeSatisfies, parseVersion } from './semver.js'
import {
  detectInstall,
  findNpmCli,
  installCommand,
  manualCommand,
  type InstallProbe
} from './install.js'
import {
  Updater,
  autoUpdateMode,
  failureReason,
  fetchRegistry,
  registryBase,
  type UpdateView
} from './updater.js'
import { describeUpdate, updateBadge } from './describe.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-update-unit-'))
  dirs.push(dir)
  return dir
}

describe('semver', () => {
  it('compares releases, prereleases and invalid versions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-next.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-next.10', '1.0.0-next.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBeGreaterThan(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(isNewer('garbage', '0.1.0')).toBe(false)
    expect(isNewer('0.1.1', 'garbage')).toBe(true)
    expect(parseVersion('1.2')).toBeNull()
  })

  it('knows a development build', () => {
    expect(isDevVersion('0.0.0')).toBe(true)
    expect(isDevVersion('0.2.0-dev.3')).toBe(true)
    expect(isDevVersion('nonsense')).toBe(true)
    expect(isDevVersion('0.1.0')).toBe(false)
    expect(isDevVersion('0.2.0-next.1')).toBe(false)
  })

  it('reads engines.node the way packages write it', () => {
    expect(nodeSatisfies('>=22.13', '22.13.0')).toBe(true)
    expect(nodeSatisfies('>=22.13', 'v22.12.1')).toBe(false)
    expect(nodeSatisfies('>=24', '22.20.0')).toBe(false)
    expect(nodeSatisfies('^22.13.0 || >=24', '24.1.0')).toBe(true)
    expect(nodeSatisfies('^22.13.0 || >=24', '23.0.0')).toBe(false)
    expect(nodeSatisfies(undefined, '22.0.0')).toBe(true)
    expect(nodeSatisfies('lts/*', '22.0.0')).toBe(true) // not understood: npm decides
  })
})

describe('opt-outs', () => {
  const base = { config: {}, env: {}, version: '0.1.0', method: 'npm' as const }
  it('is on by default for a published install', () => {
    expect(autoUpdateMode(base)).toEqual({ mode: 'on' })
  })
  it('NSQ_NO_UPDATE, autoUpdate false, CI, dev builds and checkouts turn it off', () => {
    expect(autoUpdateMode({ ...base, env: { NSQ_NO_UPDATE: '1' } }).mode).toBe('off')
    expect(autoUpdateMode({ ...base, env: { NSQ_NO_UPDATE: '0' } }).mode).toBe('on')
    expect(autoUpdateMode({ ...base, config: { autoUpdate: false } }).mode).toBe('off')
    expect(autoUpdateMode({ ...base, env: { CI: 'true' } })).toEqual({
      mode: 'off',
      reason: 'running in CI'
    })
    expect(autoUpdateMode({ ...base, env: { CI: 'false' } }).mode).toBe('on')
    expect(autoUpdateMode({ ...base, env: { CI: '' } }).mode).toBe('on')
    expect(autoUpdateMode({ ...base, version: '0.0.0' }).mode).toBe('off')
    expect(autoUpdateMode({ ...base, method: 'linked' }).mode).toBe('off')
  })
  it('"notify" checks without installing', () => {
    expect(autoUpdateMode({ ...base, config: { autoUpdate: 'notify' } }).mode).toBe('notify')
  })
  it('a custom registry only over http(s)', () => {
    expect(registryBase({})).toBe('https://registry.npmjs.org')
    expect(registryBase({ NSQ_UPDATE_REGISTRY: 'http://127.0.0.1:4873/' })).toBe(
      'http://127.0.0.1:4873'
    )
    expect(registryBase({ NSQ_UPDATE_REGISTRY: 'file:///etc' })).toBe('https://registry.npmjs.org')
  })
})

/** A probe over a set of existing paths (all writable unless listed). */
function probe(
  platform: NodeJS.Platform,
  existing: string[],
  options: { readOnly?: string[]; env?: NodeJS.ProcessEnv; execPath?: string } = {}
): InstallProbe {
  const norm = (path: string): string => path.replaceAll('\\', '/').toLowerCase()
  const set = new Set(existing.map(norm))
  return {
    platform,
    env: options.env ?? {},
    execPath:
      options.execPath ?? (platform === 'win32' ? 'C:\\nodejs\\node.exe' : '/usr/local/bin/node'),
    exists: (path) => set.has(norm(path)),
    writable: (path) => !(options.readOnly ?? []).map(norm).includes(norm(path)),
    realpath: (path) => path
  }
}

describe('install method', () => {
  it('npm global on macOS / Linux', () => {
    const info = detectInstall(
      '/usr/local/lib/node_modules/neurosquad',
      'neurosquad',
      probe('linux', ['/usr/local/bin/nsq'])
    )
    expect(info).toMatchObject({ method: 'npm', prefix: '/usr/local', canInstall: true })
    expect(info.stableDir).toBe('/usr/local/lib/node_modules/neurosquad')
  })

  it('npm global with the install script prefix (~/.local)', () => {
    const info = detectInstall(
      '/home/me/.local/lib/node_modules/neurosquad',
      'neurosquad',
      probe('linux', ['/home/me/.local/bin/nsq'])
    )
    expect(info).toMatchObject({ method: 'npm', prefix: '/home/me/.local', canInstall: true })
  })

  it('npm global whose prefix is not writable: reports, never sudo', () => {
    const info = detectInstall(
      '/usr/lib/node_modules/neurosquad',
      'neurosquad',
      probe('linux', ['/usr/bin/nsq'], { readOnly: ['/usr/lib/node_modules'] })
    )
    expect(info).toMatchObject({ method: 'npm', canInstall: false })
    expect(info.reason).toMatch(/not writable/)
    expect(installCommand(info, 'neurosquad', '0.2.0', probe('linux', []))).toBeNull()
    expect(manualCommand(info, 'neurosquad', '0.2.0')).toBe(
      'npm install -g neurosquad@0.2.0  (needs write access to /usr)'
    )
  })

  it('npm global on Windows', () => {
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\neurosquad'
    const p = probe('win32', [
      'C:\\Users\\me\\AppData\\Roaming\\npm\\nsq.cmd',
      'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    ])
    const info = detectInstall(dir, 'neurosquad', p)
    expect(info).toMatchObject({
      method: 'npm',
      prefix: 'C:\\Users\\me\\AppData\\Roaming\\npm',
      canInstall: true
    })
    const command = installCommand(info, 'neurosquad', '0.2.0', p)
    expect(command?.file).toBe('C:\\nodejs\\node.exe')
    expect(command?.args).toEqual([
      'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      'install',
      '--global',
      '--prefix',
      'C:\\Users\\me\\AppData\\Roaming\\npm',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      'neurosquad@0.2.0'
    ])
  })

  it("a project's own node_modules is not a global install", () => {
    expect(
      detectInstall('C:\\code\\app\\node_modules\\neurosquad', 'neurosquad', probe('win32', []))
        .method
    ).toBe('unknown')
    expect(
      detectInstall('/code/app/node_modules/neurosquad', 'neurosquad', probe('darwin', [])).method
    ).toBe('unknown')
  })

  it('a scoped package name', () => {
    const info = detectInstall(
      '/usr/local/lib/node_modules/@neurosquad/cli',
      '@neurosquad/cli',
      probe('darwin', ['/usr/local/bin/nsq'])
    )
    expect(info).toMatchObject({ method: 'npm', prefix: '/usr/local' })
  })

  it('Homebrew (macOS and Linux)', () => {
    const mac = detectInstall(
      '/opt/homebrew/Cellar/neurosquad-cli/0.1.0/libexec/lib/node_modules/neurosquad',
      'neurosquad',
      probe('darwin', ['/opt/homebrew/bin/brew'])
    )
    expect(mac).toMatchObject({ method: 'homebrew', root: '/opt/homebrew', canInstall: true })
    expect(mac.stableDir).toBe(
      '/opt/homebrew/opt/neurosquad-cli/libexec/lib/node_modules/neurosquad'
    )
    const p = probe('darwin', ['/opt/homebrew/bin/brew'])
    const command = installCommand(mac, 'neurosquad', '0.2.0', p)
    expect(command).toMatchObject({
      file: '/opt/homebrew/bin/brew',
      args: ['upgrade', 'glmn-ai/neurosquad/neurosquad-cli']
    })
    expect(command?.env?.['HOMEBREW_NO_INSTALL_CLEANUP']).toBe('1')
    const linux = detectInstall(
      '/home/linuxbrew/.linuxbrew/Cellar/neurosquad-cli/0.1.0/libexec/lib/node_modules/neurosquad',
      'neurosquad',
      probe('linux', [])
    )
    expect(linux).toMatchObject({
      method: 'homebrew',
      canInstall: false,
      reason: 'brew was not found'
    })
  })

  it('Scoop, user and global', () => {
    const user = detectInstall(
      'C:\\Users\\me\\scoop\\apps\\neurosquad-cli\\0.1.0',
      'neurosquad',
      probe('win32', ['C:\\Users\\me\\scoop\\apps\\scoop\\current\\bin\\scoop.ps1'])
    )
    expect(user).toMatchObject({
      method: 'scoop',
      root: 'C:\\Users\\me\\scoop',
      stableDir: 'C:\\Users\\me\\scoop\\apps\\neurosquad-cli\\current',
      canInstall: true
    })
    expect(installCommand(user, 'neurosquad', '0.2.0', probe('win32', []))?.args.slice(-3)).toEqual(
      ['C:\\Users\\me\\scoop\\apps\\scoop\\current\\bin\\scoop.ps1', 'update', 'neurosquad-cli']
    )
    const global = detectInstall(
      'C:\\ProgramData\\scoop\\apps\\neurosquad-cli\\0.1.0',
      'neurosquad',
      probe('win32', ['C:\\ProgramData\\scoop\\apps\\scoop\\current\\bin\\scoop.ps1'])
    )
    expect(global).toMatchObject({ method: 'scoop', canInstall: false })
    expect(manualCommand(global, 'neurosquad', '0.2.0')).toMatch(/--global/)
  })

  it('npx, other package managers and checkouts only inform', () => {
    const npx = detectInstall(
      'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\neurosquad',
      'neurosquad',
      probe('win32', [])
    )
    expect(npx).toMatchObject({ method: 'npx', canInstall: false })
    expect(manualCommand(npx, 'neurosquad', '0.2.0')).toBe('npx neurosquad@latest')
    const cases: [string, string, string][] = [
      [
        '/home/me/.volta/tools/image/packages/neurosquad/lib/node_modules/neurosquad',
        'Volta',
        'volta install neurosquad@0.2.0'
      ],
      [
        '/home/me/.local/share/pnpm/global/5/node_modules/neurosquad',
        'pnpm',
        'pnpm add -g neurosquad@0.2.0'
      ],
      [
        '/home/me/.bun/install/global/node_modules/neurosquad',
        'bun',
        'bun add -g neurosquad@0.2.0'
      ],
      [
        '/home/me/.config/yarn/global/node_modules/neurosquad',
        'yarn',
        'yarn global add neurosquad@0.2.0'
      ]
    ]
    for (const [dir, manager, command] of cases) {
      const info = detectInstall(dir, 'neurosquad', probe('linux', ['/home/me/.local/bin/nsq']))
      expect(info).toMatchObject({ method: 'other', manager, canInstall: false })
      expect(manualCommand(info, 'neurosquad', '0.2.0')).toBe(command)
    }
    expect(
      detectInstall('/home/me/src/neurosquad-cli/apps/cli', 'neurosquad', probe('linux', [])).method
    ).toBe('linked')
  })

  it('finds npm next to node, or through PATH', () => {
    expect(findNpmCli(probe('linux', ['/usr/local/lib/node_modules/npm/bin/npm-cli.js']))).toBe(
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js'
    )
    expect(
      findNpmCli(
        probe('win32', ['C:\\tools\\npm.cmd', 'C:\\tools\\node_modules\\npm\\bin\\npm-cli.js'], {
          env: { PATH: 'C:\\tools', PATHEXT: '.CMD' }
        })
      )
    ).toBe('C:\\tools\\node_modules\\npm\\bin\\npm-cli.js')
    expect(findNpmCli(probe('linux', [], { env: { NSQ_UPDATE_NPM: '/x/npm.js' } }))).toBe(
      '/x/npm.js'
    )
    expect(findNpmCli(probe('linux', []))).toBeNull()
  })
})

describe('installer output', () => {
  it('names the error', () => {
    expect(
      failureReason('npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/lib', 243)
    ).toBe('permission denied')
    expect(
      failureReason(
        'npm error code ETARGET\nnpm error notarget No matching version found for neurosquad@9.9.9.',
        1
      )
    ).toMatch(/ETARGET|No matching version/)
    expect(failureReason('', 3)).toBe('the installer exited with code 3')
  })
})

describe('registry', () => {
  it('asks with an ETag and sends nothing about the user', async () => {
    const seen: IncomingHttpHeaders[] = []
    const server = createServer((req, res) => {
      seen.push(req.headers)
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304).end()
        return
      }
      res.writeHead(200, { etag: '"v1"', 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          'dist-tags': { latest: '0.2.0', next: '0.3.0-next.1', bogus: 'x' },
          versions: { '0.2.0': { engines: { node: '>=22.13' } } }
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const registry = `http://127.0.0.1:${address.port}`
    try {
      const first = await fetchRegistry('neurosquad', { registry })
      expect(first).toEqual({
        notModified: false,
        etag: '"v1"',
        tags: { latest: '0.2.0', next: '0.3.0-next.1' },
        engines: { '0.2.0': '>=22.13' }
      })
      const second = await fetchRegistry('neurosquad', { registry, etag: '"v1"' })
      expect(second.notModified).toBe(true)
      expect(seen[0]?.accept).toMatch(/application\/vnd\.npm\.install-v1\+json/)
      for (const headers of seen) {
        expect(headers.authorization).toBeUndefined()
        expect(headers.cookie).toBeUndefined()
        expect(headers['npm-session']).toBeUndefined()
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

/** An installed copy for the Updater: package.json at `version` under a global npm layout. */
function installed(version: string): { home: string; packageDir: string; prefix: string } {
  const root = tempDir()
  const prefix = join(root, 'prefix')
  const win = process.platform === 'win32'
  const packageDir = win
    ? join(prefix, 'node_modules', 'neurosquad')
    : join(prefix, 'lib', 'node_modules', 'neurosquad')
  mkdirSync(join(packageDir, 'dist'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'neurosquad', version }))
  writeFileSync(join(packageDir, 'dist', 'bin.js'), '')
  if (win) writeFileSync(join(prefix, 'nsq.cmd'), '')
  else {
    mkdirSync(join(prefix, 'bin'))
    writeFileSync(join(prefix, 'bin', 'nsq'), '')
  }
  const home = join(root, 'home')
  return { home, packageDir, prefix }
}

/** A stand-in npm: `mode` ok rewrites the version, fail exits 1 with npm's EACCES output. */
function fakeNpm(dir: string, mode: 'ok' | 'fail'): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `npm-${mode}.mjs`)
  writeFileSync(
    file,
    mode === 'fail'
      ? "console.error('npm error code EACCES'); console.error('npm error syscall rename'); process.exit(243)\n"
      : [
          "import { readFileSync, writeFileSync } from 'node:fs'",
          "import { join } from 'node:path'",
          'const args = process.argv.slice(2)',
          "const version = args.at(-1).split('@').at(-1)",
          "const prefix = args[args.indexOf('--prefix') + 1]",
          `const file = join(prefix, ${process.platform === 'win32' ? "''" : "'lib'"}, 'node_modules', 'neurosquad', 'package.json')`,
          "writeFileSync(file, JSON.stringify({ name: 'neurosquad', version }))",
          ''
        ].join('\n')
  )
  return file
}

const registryAnswer =
  (latest: string, engines = '>=22.13'): typeof fetch =>
  async () =>
    new Response(
      JSON.stringify({
        'dist-tags': { latest },
        versions: { [latest]: { engines: { node: engines } } }
      }),
      { status: 200, headers: { etag: `"${latest}"` } }
    )

describe('Updater', () => {
  it('checks, installs, verifies and remembers', async () => {
    const copy = installed('0.1.0')
    const views: UpdateView[] = []
    const updater = new Updater({
      version: '0.1.0',
      name: 'neurosquad',
      packageDir: copy.packageDir,
      home: copy.home,
      config: () => ({}),
      env: { NSQ_UPDATE_NPM: fakeNpm(copy.home + '-bin', 'ok') },
      fetchImpl: registryAnswer('0.2.0'),
      onChange: (view) => views.push(view)
    })
    expect(updater.info.method).toBe('npm')
    const checked = await updater.check()
    expect(checked).toMatchObject({ state: 'available', current: '0.1.0', latest: '0.2.0' })
    expect(updater.shouldAutoInstall()).toBe(true)
    const done = await updater.install()
    expect(done).toMatchObject({ state: 'installed', installed: '0.2.0' })
    expect(views.map((view) => view.state)).toContain('installing')
    const cache = JSON.parse(readFileSync(join(copy.home, 'update.json'), 'utf8')) as {
      installed?: { version: string; from: string }
      etag?: string
    }
    expect(cache.installed).toMatchObject({ version: '0.2.0', from: '0.1.0' })
    expect(cache.etag).toBe('"0.2.0"')
    expect(readFileSync(join(copy.home, 'logs', 'update.log'), 'utf8')).toMatch(/installed 0\.2\.0/)
    expect(updater.successor()?.script).toBe(join(copy.packageDir, 'dist', 'bin.js'))
    expect(describeUpdate(updater.view())[0]).toBe(
      '0.2.0 is installed; the daemon runs 0.1.0 until it restarts'
    )
    expect(updateBadge(updater.view())?.text).toBe('updated to 0.2.0 · U restart')

    // The daemon that comes up on 0.2.0 says so once.
    const next = new Updater({
      version: '0.2.0',
      name: 'neurosquad',
      packageDir: copy.packageDir,
      home: copy.home,
      config: () => ({}),
      env: {},
      fetchImpl: registryAnswer('0.2.0')
    })
    next.noteStarted()
    expect(next.view()).toMatchObject({ updatedFrom: '0.1.0', state: 'idle' })
    expect(updateBadge(next.view())?.text).toBe('updated to 0.2.0 (was 0.1.0)')
    expect(updateBadge(next.view(), Date.now() + 120_000)).toBeNull()
    expect((await next.check()).state).toBe('current') // the cached answer: no new request
  }, 30_000)

  it('a failed install says why and is not retried until the next check', async () => {
    const copy = installed('0.1.0')
    mkdirSync(copy.home + '-bin', { recursive: true })
    const updater = new Updater({
      version: '0.1.0',
      name: 'neurosquad',
      packageDir: copy.packageDir,
      home: copy.home,
      config: () => ({}),
      env: { NSQ_UPDATE_NPM: fakeNpm(copy.home + '-bin', 'fail') },
      fetchImpl: registryAnswer('0.2.0')
    })
    await updater.check()
    const done = await updater.install()
    expect(done).toMatchObject({ state: 'failed', reason: 'permission denied' })
    expect(done.command).toBe('npm install -g neurosquad@0.2.0')
    expect(updateBadge(done)?.tone).toBe('warn')
    await updater.check()
    expect(updater.shouldAutoInstall()).toBe(false)
  }, 30_000)

  it('never installs a release that needs a newer Node.js, nor with "notify"', async () => {
    const copy = installed('0.1.0')
    const updater = new Updater({
      version: '0.1.0',
      name: 'neurosquad',
      packageDir: copy.packageDir,
      home: copy.home,
      config: () => ({}),
      env: {},
      fetchImpl: registryAnswer('0.2.0', '>=99')
    })
    const view = await updater.check()
    expect(view.reason).toMatch(/needs Node\.js >=99/)
    expect(updater.shouldAutoInstall()).toBe(false)

    const notify = new Updater({
      version: '0.1.0',
      name: 'neurosquad',
      packageDir: copy.packageDir,
      home: copy.home + '2',
      config: () => ({ autoUpdate: 'notify' }),
      env: {},
      fetchImpl: registryAnswer('0.2.0')
    })
    expect((await notify.check()).state).toBe('available')
    expect(notify.shouldAutoInstall()).toBe(false)
    expect(updateBadge(notify.view())?.text).toBe('update 0.1.0 → 0.2.0 · nsq update')
  })

  it('with checks off it never asks the registry', async () => {
    const copy = installed('0.1.0')
    let asked = 0
    const updater = new Updater({
      version: '0.1.0',
      name: 'neurosquad',
      packageDir: copy.packageDir,
      home: copy.home,
      config: () => ({}),
      env: { NSQ_NO_UPDATE: '1' },
      fetchImpl: async () => {
        asked++
        return new Response('{}')
      }
    })
    expect(updater.view()).toMatchObject({ state: 'off', auto: 'off' })
    updater.start(() => {}, 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    updater.stop()
    expect(asked).toBe(0)
  })

  it('offline: quiet, keeps the last answer', async () => {
    const copy = installed('0.1.0')
    let online = true
    const updater = new Updater({
      version: '0.1.0',
      name: 'neurosquad',
      packageDir: copy.packageDir,
      home: copy.home,
      config: () => ({ autoUpdate: 'notify' }),
      env: {},
      now: () => (online ? 0 : 10 * 60 * 60 * 1000),
      fetchImpl: async (...args) => {
        if (!online) throw new Error('getaddrinfo ENOTFOUND')
        return registryAnswer('0.2.0')(...args)
      }
    })
    expect((await updater.check()).state).toBe('available')
    online = false
    expect((await updater.check()).state).toBe('available')
    expect((await updater.check(true)).state).toBe('failed')
  })
})
