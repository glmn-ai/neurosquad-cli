// Finding — or fetching — Cloudflare's tunnel connector, `cloudflared`, for online phone access.
//
// It is not shipped with nsq (tens of MB, most people never go online). On first use the official
// release binary is downloaded from Cloudflare's GitHub releases into a folder the host chooses
// (nsq: `NSQ_HOME/bin`) and nowhere else: nothing is installed system-wide, nothing touches PATH,
// no installer script is run.
//
// **The download is verified, and refused when it cannot be.** It is an executable that will run
// with the user's rights and carry every byte between the phone and the agents:
//   - GitHub publishes a `sha256:` digest for every release asset; the file is hashed while it
//     downloads and thrown away on any mismatch (or a size mismatch). No digest → no download.
//   - Cloudflare also lists SHA256 checksums in the release notes. For a plain binary that line,
//     when present, must agree with GitHub's digest too. (The macOS `.tgz` archives are repacked
//     after the notes are written, so their line describes a different archive and is not used.)
//   - Only `https://github.com/cloudflare/cloudflared/releases/download/…` is fetched.
// A `cloudflared` the user installed themselves (on PATH) is used as is: that one is their choice.
//
// Kept current: cloudflared runs with --no-autoupdate, and Cloudflare stops supporting connectors
// older than about a year. The downloaded copy's version is recorded next to it
// (`cloudflared.json`); every 30 days (or on `refresh`) the latest release is looked up and, when
// it is newer, downloaded and verified the same way. A failed check keeps the copy that works.
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const CLOUDFLARED_RELEASE_API =
  'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'
const DOWNLOAD_PREFIX = 'https://github.com/cloudflare/cloudflared/releases/download/'
/** No cloudflared build is anywhere near this; a bigger answer is not one. */
const MAX_ASSET_BYTES = 200 * 1024 * 1024

export function cloudflaredBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

/**
 * The release asset for a platform, or null when Cloudflare builds none. Windows on ARM takes the
 * x64 build (there is no native one; Windows 11 emulates x64).
 */
export function cloudflaredAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  if (platform === 'win32')
    return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe'
  if (platform === 'darwin')
    return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'
  if (platform === 'linux') {
    if (arch === 'x64') return 'cloudflared-linux-amd64'
    if (arch === 'arm64') return 'cloudflared-linux-arm64'
    if (arch === 'arm') return 'cloudflared-linux-arm'
    if (arch === 'ia32') return 'cloudflared-linux-386'
  }
  return null
}

/** `name: <64 hex>` lines from the release notes ("SHA256 Checksums:"), by asset name. */
export function publishedChecksums(notes: string | null | undefined): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of (notes ?? '').split(/\r?\n/)) {
    const match = /^\s*([\w.+-]+)\s*:\s*([0-9a-f]{64})\s*$/i.exec(line)
    if (match) found.set(match[1], match[2].toLowerCase())
  }
  return found
}

export interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
}

export interface ReleaseInfo {
  tag_name?: string
  body?: string | null
  assets?: ReleaseAsset[]
}

export interface VerifiedAsset {
  name: string
  url: string
  size: number
  sha256: string
  version?: string
}

/** Picks the asset and the checksum it must have; throws a sentence the user can act on. */
export function verifiedAsset(release: ReleaseInfo, name: string): VerifiedAsset {
  const asset = release.assets?.find((candidate) => candidate.name === name)
  if (!asset) throw new Error(`The latest cloudflared release has no ${name}.`)
  if (!asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) {
    throw new Error('The cloudflared release points somewhere other than its GitHub releases.')
  }
  if (!Number.isInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) {
    throw new Error('The cloudflared release lists an implausible size for its download.')
  }
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase()
  if (!digest) {
    throw new Error(
      'GitHub published no checksum for cloudflared, so it was not downloaded. Install cloudflared yourself (it is used from PATH) and try again.'
    )
  }
  const listed = publishedChecksums(release.body).get(name)
  if (listed && !name.endsWith('.tgz') && listed !== digest) {
    throw new Error(
      "cloudflared's published checksum and GitHub's digest disagree, so it was not downloaded."
    )
  }
  return {
    name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: digest,
    ...(release.tag_name ? { version: release.tag_name } : {})
  }
}

/** The one regular file called `name` in a .tar.gz (ustar), or null. */
export function extractFromTarGz(archive: Buffer, name: string): Buffer | null {
  const tar = gunzipSync(archive)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start: number, length: number): string =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const prefix = field(345, 155)
    const entry = (prefix ? `${prefix}/` : '') + field(0, 100)
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    if (!Number.isFinite(size) || size < 0) return null
    const start = offset + 512
    if ((type === '0' || type === '') && entry.replace(/^\.\//, '') === name) {
      if (start + size > tar.length) return null
      return Buffer.from(tar.subarray(start, start + size))
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  return null
}

export interface EnsureCloudflaredOptions {
  /** Where a downloaded copy lives (nsq: `NSQ_HOME/bin`). */
  binDir: string
  /** 0…1 while downloading; never called when nothing is downloaded. */
  onProgress?: (fraction: number) => void
  /** Injected for tests. */
  fetch?: typeof fetch
  findOnPath?: () => Promise<string | null>
  platform?: NodeJS.Platform
  arch?: string
  releaseApi?: string
  /** Look up the latest release now and replace the downloaded copy if it is newer. */
  refresh?: boolean
  /** How often the downloaded copy is checked against the latest release. Default 30 days. */
  checkEveryMs?: number
  /** Cancels the lookup and the download. */
  signal?: AbortSignal
  now?: () => number
}

export const CLOUDFLARED_CHECK_EVERY_MS = 30 * 24 * 3_600_000

interface Stamp {
  version?: string
  checkedAt: number
}

function stampFile(binDir: string): string {
  return join(binDir, 'cloudflared.json')
}

function readStamp(binDir: string): Stamp | undefined {
  try {
    const value = JSON.parse(readFileSync(stampFile(binDir), 'utf8')) as Partial<Stamp>
    return typeof value.checkedAt === 'number'
      ? {
          checkedAt: value.checkedAt,
          ...(typeof value.version === 'string' ? { version: value.version } : {})
        }
      : undefined
  } catch {
    return undefined
  }
}

function writeStamp(binDir: string, stamp: Stamp): void {
  try {
    writeFileSync(stampFile(binDir), `${JSON.stringify(stamp)}\n`, { mode: 0o600 })
  } catch {
    // Only means another check next time.
  }
}

/** Runnable by this user: a regular file, and (off Windows) with execute permission. */
function runnable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface CloudflaredBinary {
  path: string
  source: 'downloaded' | 'path' | 'fresh-download'
  version?: string
}

/**
 * A `cloudflared` the user installed themselves, if one is on PATH. Only absolute PATH entries are
 * searched — never the current directory (Windows `where` would look there first), so a
 * `cloudflared.exe` lying in some folder is never picked up unverified.
 */
export function cloudflaredOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const pathValue = (platform === 'win32' ? (env['Path'] ?? env['PATH']) : env['PATH']) ?? ''
  const extensions =
    platform === 'win32'
      ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((ext) => ext.trim().toLowerCase())
          .filter((ext) => ext === '.exe' || ext === '.com')
      : ['']
  const separator = platform === 'win32' ? ';' : delimiter
  for (const dir of pathValue.split(separator)) {
    const folder = dir.trim().replace(/^"(.*)"$/, '$1')
    if (!folder || !isAbsolute(folder)) continue
    for (const ext of extensions) {
      const candidate = join(folder, `cloudflared${ext}`)
      // Not executable (off Windows): skipped, a later entry or the download is used instead.
      if (runnable(candidate, platform)) return Promise.resolve(candidate)
    }
  }
  return Promise.resolve(null)
}

/**
 * A runnable `cloudflared`: the copy downloaded earlier (re-checked against the latest release
 * every `checkEveryMs`), else one on PATH, else a verified download of the latest release.
 */
export async function ensureCloudflared(
  options: EnsureCloudflaredOptions
): Promise<CloudflaredBinary> {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const target = join(options.binDir, cloudflaredBinaryName(platform))
  if (existsSync(target)) {
    const stamp = readStamp(options.binDir)
    const due =
      options.refresh ||
      !stamp ||
      now() - stamp.checkedAt >= (options.checkEveryMs ?? CLOUDFLARED_CHECK_EVERY_MS)
    const current: CloudflaredBinary = {
      path: target,
      source: 'downloaded',
      ...(stamp?.version ? { version: stamp.version } : {})
    }
    if (!due) return current
    try {
      const release = await latestRelease(options)
      if (!options.refresh && stamp?.version && release.tag_name === stamp.version) {
        writeStamp(options.binDir, { version: stamp.version, checkedAt: now() })
        return current
      }
      return await download(options, release, target, platform, now)
    } catch (error) {
      // Asked for: say why. On the periodic check: the copy that works is kept.
      if (options.refresh || options.signal?.aborted) throw error
      return current
    }
  }
  const installed = await (options.findOnPath ?? cloudflaredOnPath)()
  if (installed) return { path: installed, source: 'path' }
  return download(options, await latestRelease(options), target, platform, now)
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

async function latestRelease(options: EnsureCloudflaredOptions): Promise<ReleaseInfo> {
  const doFetch = options.fetch ?? fetch
  const response = await doFetch(options.releaseApi ?? CLOUDFLARED_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nsq' },
    signal: withTimeout(options.signal, 30_000)
  })
  if (!response.ok) {
    throw new Error(`Could not look up the latest cloudflared (HTTP ${response.status}).`)
  }
  return (await response.json()) as ReleaseInfo
}

async function download(
  options: EnsureCloudflaredOptions,
  release: ReleaseInfo,
  target: string,
  platform: NodeJS.Platform,
  now: () => number
): Promise<CloudflaredBinary> {
  const name = cloudflaredAssetName(platform, options.arch ?? process.arch)
  if (!name) {
    throw new Error(
      `Cloudflare builds no cloudflared for ${platform}/${options.arch ?? process.arch}. Install it yourself (it is used from PATH).`
    )
  }
  const asset = verifiedAsset(release, name)
  const doFetch = options.fetch ?? fetch
  mkdirSync(options.binDir, { recursive: true, mode: 0o700 })
  const response = await doFetch(asset.url, {
    headers: { 'User-Agent': 'nsq' },
    signal: withTimeout(options.signal, 10 * 60_000)
  })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download cloudflared (HTTP ${response.status}).`)
  }
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let received = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > asset.size) {
      await reader.cancel().catch(() => {})
      throw new Error('The cloudflared download is larger than its release says; discarded.')
    }
    hash.update(value)
    chunks.push(Buffer.from(value))
    options.onProgress?.(received / asset.size)
  }
  if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
    throw new Error(
      'The downloaded cloudflared did not match its published checksum and was discarded.'
    )
  }
  const bytes = Buffer.concat(chunks)
  const binary = asset.name.endsWith('.tgz') ? extractFromTarGz(bytes, 'cloudflared') : bytes
  if (!binary) throw new Error('The cloudflared archive holds no cloudflared.')

  // Written next to its final name, then renamed in: a half-written file is never run.
  const staging = `${target}.${process.pid}.download`
  try {
    writeFileSync(staging, binary, { mode: 0o700 })
    if (platform !== 'win32') chmodSync(staging, 0o700)
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { force: true })
    throw error
  }
  writeStamp(options.binDir, {
    ...(asset.version ? { version: asset.version } : {}),
    checkedAt: now()
  })
  return {
    path: target,
    source: 'fresh-download',
    ...(asset.version ? { version: asset.version } : {})
  }
}
