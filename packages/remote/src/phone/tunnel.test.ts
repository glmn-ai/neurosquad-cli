import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cloudflaredAssetName,
  cloudflaredOnPath,
  ensureCloudflared,
  extractFromTarGz,
  publishedChecksums,
  verifiedAsset,
  type ReleaseInfo
} from './cloudflared.js'
import { Lockout } from './lockout.js'
import {
  CloudflareTunnel,
  normalizeTunnelHostname,
  parseQuickTunnelUrl,
  tunnelEnvironment
} from './tunnel.js'

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const DL = 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/'

/** A one-file ustar archive, gzipped. */
function tgz(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000755\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512)
  return gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]))
}

describe('quick tunnel address', () => {
  it('finds the trycloudflare address in cloudflared output, not the api one', () => {
    expect(
      parseQuickTunnelUrl(
        '2026-10-09T10:00:00Z INF Requesting new quick Tunnel on https://api.trycloudflare.com...'
      )
    ).toBeUndefined()
    expect(
      parseQuickTunnelUrl(
        '2026-10-09T10:00:01Z INF |  https://Calm-River-Owl-42.trycloudflare.com                |'
      )
    ).toBe('https://calm-river-owl-42.trycloudflare.com')
    expect(parseQuickTunnelUrl('see https://evil.trycloudflare.com.example.org/')).toBeUndefined()
    expect(parseQuickTunnelUrl('http://plain.trycloudflare.com')).toBeUndefined()
    expect(parseQuickTunnelUrl('nothing here')).toBeUndefined()
  })

  it('normalizes a named tunnel hostname', () => {
    expect(normalizeTunnelHostname('nsq.example.com')).toBe('https://nsq.example.com')
    expect(normalizeTunnelHostname('https://NSQ.Example.com/path')).toBe('https://nsq.example.com')
    expect(normalizeTunnelHostname('localhost')).toBeUndefined()
    expect(normalizeTunnelHostname('bad host.com')).toBeUndefined()
  })

  it('gives cloudflared a small environment, the token only for a named tunnel', () => {
    const env = tunnelEnvironment(
      {
        PATH: '/bin',
        HOME: '/h',
        OPENROUTER_API_KEY: 'k',
        TUNNEL_TOKEN: 'stray',
        HTTPS_PROXY: 'p'
      },
      undefined
    )
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'p' })
    expect(tunnelEnvironment({ PATH: '/bin' }, 'secret')).toEqual({
      PATH: '/bin',
      TUNNEL_TOKEN: 'secret'
    })
  })
})

describe('cloudflared download verification', () => {
  const binary = Buffer.from('fake cloudflared binary')
  const release = (overrides: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
    tag_name: '2026.10.0',
    body: `### SHA256 Checksums:\n\`\`\`\ncloudflared-linux-amd64: ${sha(binary)}\ncloudflared-darwin-arm64.tgz: ${'0'.repeat(64)}\n\`\`\``,
    assets: [
      {
        name: 'cloudflared-linux-amd64',
        size: binary.length,
        browser_download_url: `${DL}cloudflared-linux-amd64`,
        digest: `sha256:${sha(binary)}`
      }
    ],
    ...overrides
  })

  it('maps platforms to release assets', () => {
    expect(cloudflaredAssetName('win32', 'x64')).toBe('cloudflared-windows-amd64.exe')
    expect(cloudflaredAssetName('win32', 'arm64')).toBe('cloudflared-windows-amd64.exe')
    expect(cloudflaredAssetName('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz')
    expect(cloudflaredAssetName('linux', 'arm64')).toBe('cloudflared-linux-arm64')
    expect(cloudflaredAssetName('aix' as NodeJS.Platform, 'ppc64')).toBeNull()
  })

  it("reads Cloudflare's checksum list from the release notes", () => {
    const sums = publishedChecksums(release().body)
    expect(sums.get('cloudflared-linux-amd64')).toBe(sha(binary))
    expect(sums.size).toBe(2)
  })

  it('takes the GitHub digest, and refuses without one or when the two disagree', () => {
    expect(verifiedAsset(release(), 'cloudflared-linux-amd64').sha256).toBe(sha(binary))
    const noDigest = release()
    noDigest.assets![0]!.digest = null
    expect(() => verifiedAsset(noDigest, 'cloudflared-linux-amd64')).toThrow(/no checksum/)
    const disagree = release({ body: `cloudflared-linux-amd64: ${'a'.repeat(64)}` })
    expect(() => verifiedAsset(disagree, 'cloudflared-linux-amd64')).toThrow(/disagree/)
    const elsewhere = release()
    elsewhere.assets![0]!.browser_download_url = 'https://evil.example/cloudflared'
    expect(() => verifiedAsset(elsewhere, 'cloudflared-linux-amd64')).toThrow(/somewhere other/)
    expect(() => verifiedAsset(release(), 'cloudflared-linux-arm')).toThrow(/has no/)
  })

  it('extracts the binary from a macOS archive', () => {
    expect(extractFromTarGz(tgz('cloudflared', binary), 'cloudflared')).toEqual(binary)
    expect(extractFromTarGz(tgz('other', binary), 'cloudflared')).toBeNull()
  })

  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsq-cloudflared-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const fakeFetch = (info: ReleaseInfo, served: Buffer): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('api.github.com')) return new Response(JSON.stringify(info))
      return new Response(new Uint8Array(served))
    }) as typeof fetch

  it('downloads into the bin folder only after the checksum matched', async () => {
    const progress: number[] = []
    const got = await ensureCloudflared({
      binDir: dir,
      platform: 'linux',
      arch: 'x64',
      findOnPath: async () => null,
      fetch: fakeFetch(release(), binary),
      onProgress: (fraction) => progress.push(fraction)
    })
    expect(got.source).toBe('fresh-download')
    expect(got.path).toBe(join(dir, 'cloudflared'))
    expect(readFileSync(got.path)).toEqual(binary)
    expect(progress.at(-1)).toBe(1)
    // Next time: the downloaded copy, no network.
    const again = await ensureCloudflared({
      binDir: dir,
      platform: 'linux',
      findOnPath: async () => null,
      fetch: (() => {
        throw new Error('no network expected')
      }) as typeof fetch
    })
    expect(again.source).toBe('downloaded')
  })

  it('throws a tampered download away', async () => {
    const tampered = Buffer.from('fake cloudflared binarX')
    await expect(
      ensureCloudflared({
        binDir: dir,
        platform: 'linux',
        arch: 'x64',
        findOnPath: async () => null,
        fetch: fakeFetch(release(), tampered)
      })
    ).rejects.toThrow(/did not match/)
    expect(existsSync(join(dir, 'cloudflared'))).toBe(false)
  })

  it('unpacks the verified macOS archive', async () => {
    const archive = tgz('cloudflared', binary)
    const info: ReleaseInfo = {
      // The notes list another archive's checksum for the .tgz — not used.
      body: `cloudflared-darwin-arm64.tgz: ${'0'.repeat(64)}`,
      assets: [
        {
          name: 'cloudflared-darwin-arm64.tgz',
          size: archive.length,
          browser_download_url: `${DL}cloudflared-darwin-arm64.tgz`,
          digest: `sha256:${sha(archive)}`
        }
      ]
    }
    const got = await ensureCloudflared({
      binDir: dir,
      platform: 'darwin',
      arch: 'arm64',
      findOnPath: async () => null,
      fetch: fakeFetch(info, archive)
    })
    expect(readFileSync(got.path)).toEqual(binary)
  })

  it('finds cloudflared only in absolute PATH entries, never the current directory', async () => {
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    const bin = join(dir, 'tools')
    mkdirSync(bin)
    writeFileSync(join(dir, name), 'planted')
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const sep = process.platform === 'win32' ? ';' : ':'
      expect(await cloudflaredOnPath({ PATH: `.${sep}tools`, Path: `.${sep}tools` })).toBeNull()
      writeFileSync(join(bin, name), 'installed')
      expect(await cloudflaredOnPath({ PATH: `.${sep}${bin}`, Path: `.${sep}${bin}` })).toBe(
        join(bin, name)
      )
    } finally {
      process.chdir(cwd)
    }
  })

  it('skips a cloudflared on PATH that is not executable', async () => {
    if (process.platform === 'win32') return
    const bin = join(dir, 'noexec')
    mkdirSync(bin)
    writeFileSync(join(bin, 'cloudflared'), 'not runnable', { mode: 0o644 })
    expect(await cloudflaredOnPath({ PATH: bin })).toBeNull()
  })

  it('checks the downloaded copy against the latest release now and then', async () => {
    let now = 1_000
    let lookups = 0
    let downloads = 0
    const newer = Buffer.from('cloudflared 2026.11.0')
    const counting = (info: ReleaseInfo, served: Buffer): typeof fetch =>
      (async (input: string | URL | Request) => {
        if (String(input).includes('api.github.com')) {
          lookups += 1
          return new Response(JSON.stringify(info))
        }
        downloads += 1
        return new Response(new Uint8Array(served))
      }) as typeof fetch
    const base = {
      binDir: dir,
      platform: 'linux' as const,
      arch: 'x64',
      findOnPath: async () => null,
      checkEveryMs: 10_000,
      now: () => now
    }
    await ensureCloudflared({ ...base, fetch: counting(release(), binary) })
    expect([lookups, downloads]).toEqual([1, 1])
    // Within the period: no network at all.
    now = 5_000
    expect((await ensureCloudflared({ ...base, fetch: counting(release(), binary) })).source).toBe(
      'downloaded'
    )
    expect([lookups, downloads]).toEqual([1, 1])
    // Period over, same release: looked up, not downloaded.
    now = 20_000
    await ensureCloudflared({ ...base, fetch: counting(release(), binary) })
    expect([lookups, downloads]).toEqual([2, 1])
    // A newer release: downloaded and verified, replaces the copy.
    now = 40_000
    const next: ReleaseInfo = {
      tag_name: '2026.11.0',
      assets: [
        {
          name: 'cloudflared-linux-amd64',
          size: newer.length,
          browser_download_url: `${DL.replace('2026.10.0', '2026.11.0')}cloudflared-linux-amd64`,
          digest: `sha256:${sha(newer)}`
        }
      ]
    }
    const updated = await ensureCloudflared({ ...base, fetch: counting(next, newer) })
    expect(updated).toMatchObject({ source: 'fresh-download', version: '2026.11.0' })
    expect(readFileSync(updated.path)).toEqual(newer)
    // A failed periodic check keeps the copy that works; an asked-for refresh says why.
    now = 80_000
    const offline = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    expect((await ensureCloudflared({ ...base, fetch: offline })).source).toBe('downloaded')
    await expect(ensureCloudflared({ ...base, fetch: offline, refresh: true })).rejects.toThrow(
      'offline'
    )
  })

  it('a cancelled download is not installed', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      ensureCloudflared({
        binDir: dir,
        platform: 'linux',
        arch: 'x64',
        findOnPath: async () => null,
        signal: controller.signal,
        // Never the network: like fetch, this rejects on an aborted signal.
        fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
          throw new Error('fetch called without an aborted signal')
        }) as typeof fetch
      })
    ).rejects.toThrow('aborted')
    expect(existsSync(join(dir, 'cloudflared'))).toBe(false)
  })

  it('prefers a cloudflared the user installed', async () => {
    const got = await ensureCloudflared({
      binDir: dir,
      findOnPath: async () => '/usr/local/bin/cloudflared',
      fetch: (() => {
        throw new Error('no network expected')
      }) as typeof fetch
    })
    expect(got).toEqual({ path: '/usr/local/bin/cloudflared', source: 'path' })
  })
})

describe('lockout', () => {
  it('locks an address after N wrong tokens for M minutes, others unaffected', () => {
    let now = 0
    const lockout = new Lockout({ attempts: 3, windowMs: 60_000, lockMs: 120_000 }, () => now)
    expect(lockout.fail('a')).toBe(false)
    expect(lockout.fail('a')).toBe(false)
    expect(lockout.fail('a')).toBe(true)
    expect(lockout.remaining('a')).toBe(120_000)
    expect(lockout.remaining('b')).toBe(0)
    now = 119_999
    expect(lockout.remaining('a')).toBe(1)
    now = 120_000
    expect(lockout.remaining('a')).toBe(0)
    // A fresh window after the lock.
    expect(lockout.fail('a')).toBe(false)
  })

  it('forgets failures outside the window and on success', () => {
    let now = 0
    const lockout = new Lockout({ attempts: 2, windowMs: 1000, lockMs: 5000 }, () => now)
    lockout.fail('a')
    now = 2000
    expect(lockout.fail('a')).toBe(false)
    lockout.succeed('a')
    expect(lockout.fail('a')).toBe(false)
  })

  it('stays bounded', () => {
    const lockout = new Lockout({ maxEntries: 3 })
    for (const key of ['a', 'b', 'c', 'd', 'e']) lockout.fail(key)
    expect(lockout.size).toBe(3)
  })
})

describe('CloudflareTunnel', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsq-tunnel-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const fake = (body: string): string => {
    const file = join(dir, 'fake-cloudflared.mjs')
    writeFileSync(file, body)
    return file
  }

  it('reports the address, passes the empty config and the origin, and stops', async () => {
    const binary = fake(`
      import { writeFileSync } from 'node:fs'
      writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))
      console.error('INF Requesting new quick Tunnel on https://api.trycloudflare.com...')
      setTimeout(() => console.error('INF |  https://unit-test-tunnel.trycloudflare.com  |'), 50)
      setInterval(() => {}, 1000)
    `)
    const seen: string[] = []
    const tunnel = new CloudflareTunnel((status) => seen.push(status.state))
    const status = await tunnel.start({
      binary,
      origin: 'http://127.0.0.1:4567',
      mode: 'quick',
      stateDir: dir
    })
    expect(status).toEqual({
      state: 'running',
      mode: 'quick',
      url: 'https://unit-test-tunnel.trycloudflare.com'
    })
    const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[]
    expect(argv).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--config',
      join(dir, 'quick-tunnel.yml'),
      '--url',
      'http://127.0.0.1:4567'
    ])
    const pid = tunnel.pid()!
    tunnel.stop()
    expect(tunnel.status().state).toBe('off')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(seen).toEqual(['starting', 'running', 'off'])
  })

  it('says so when cloudflared exits or hands out no address', async () => {
    const tunnel = new CloudflareTunnel()
    const exited = await tunnel.start({
      binary: fake(`console.error('ERR failed to request quick Tunnel'); process.exit(3)`),
      origin: 'http://127.0.0.1:1',
      mode: 'quick',
      stateDir: dir
    })
    expect(exited.state).toBe('error')
    expect(exited.error).toMatch(/exit code 3.*failed to request/)

    const silent = await tunnel.start({
      binary: fake('setInterval(() => {}, 1000)'),
      origin: 'http://127.0.0.1:1',
      mode: 'quick',
      stateDir: dir,
      timeoutMs: 300
    })
    expect(silent.state).toBe('error')
    expect(silent.error).toMatch(/no address/)
  })

  it('a named tunnel gets its token in the environment and is up once registered', async () => {
    const binary = fake(`
      import { writeFileSync } from 'node:fs'
      writeFileSync(${JSON.stringify(join(dir, 'named.json'))}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.TUNNEL_TOKEN }))
      console.error('INF Registered tunnel connection connIndex=0')
      setInterval(() => {}, 1000)
    `)
    const tunnel = new CloudflareTunnel()
    const status = await tunnel.start({
      binary,
      origin: 'http://127.0.0.1:8767',
      mode: 'named',
      token: 'tunnel-secret',
      hostname: 'nsq.example.com',
      stateDir: dir
    })
    tunnel.stop()
    expect(status).toEqual({ state: 'running', mode: 'named', url: 'https://nsq.example.com' })
    const seen = JSON.parse(readFileSync(join(dir, 'named.json'), 'utf8')) as {
      argv: string[]
      token: string
    }
    expect(seen.token).toBe('tunnel-secret')
    expect(seen.argv.join(' ')).not.toContain('tunnel-secret')
  })

  it('a stop wins over a start still waiting for its address', async () => {
    const tunnel = new CloudflareTunnel()
    const pending = tunnel.start({
      binary: fake('setInterval(() => {}, 1000)'),
      origin: 'http://127.0.0.1:1',
      mode: 'quick',
      stateDir: dir
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    tunnel.stop()
    expect((await pending).state).toBe('off')
  })
})
