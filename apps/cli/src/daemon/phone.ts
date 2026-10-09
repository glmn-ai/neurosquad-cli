// Phone access (`nsq phone on`): the daemon serves @neurosquad/remote's phone
// API. The phone can read agents and their screens, send a prompt, answer a
// permission prompt and interrupt — the same paths the daemon's own clients
// use. Off by default; loopback unless the person asks for the LAN.
//
// The pairing token is a credential: it lives in a 0600 file in the nsq home
// (as the daemon's own token does), is shown only by `nsq phone pair`, and
// `nsq phone rotate` replaces it, cutting off every paired phone.
//
// Online (`nsq phone on --online`): a Cloudflare tunnel (cloudflared, downloaded on first use
// into NSQ_HOME/bin with its sha256 verified) forwards an https address to a separate loopback
// listener of the phone server, where wrong tokens lock an address out. Explicit each time: a
// quick tunnel is never restored when the daemon starts (its address would be new anyway); a
// named tunnel (the person's own Cloudflare hostname, its token in the keyring) is.
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@neurosquad/core'
import {
  CloudflareTunnel,
  DEFAULT_PHONE_PORT,
  PhoneServer,
  ensureCloudflared,
  generatePairingToken,
  isPairingToken,
  lanAddresses,
  normalizeTunnelHostname,
  pairingUrl,
  type PhoneConnection,
  type PhoneHost,
  type PhoneHostEvent,
  type TunnelMode,
  type TunnelStatus
} from '@neurosquad/remote'
import { paths } from '../paths.js'
import { getSecret } from './secrets.js'

export interface PhoneSettings {
  enabled?: boolean
  /** Listen on every interface so a phone on the same network can connect. */
  lan?: boolean
  port?: number
  /** Reachable from the internet through a Cloudflare tunnel. */
  online?: boolean
  /** `named`: the person's own tunnel (token in the keyring, hostname below). Default quick. */
  tunnel?: TunnelMode
  /** The named tunnel's public hostname, as set up in the Cloudflare dashboard. */
  tunnelHostname?: string
  /** The local port a named tunnel forwards to (its service URL). Default 8767. */
  tunnelPort?: number
  /** The pairing token is replaced (every phone signed out) once it is this many hours old. */
  expireHours?: number
  /** Look up the latest cloudflared now and replace the downloaded copy when it is newer. */
  refreshCloudflared?: boolean
}

/**
 * Why an automatic update must not restart the daemon now, as far as phone access goes: a quick
 * tunnel does not come back after a restart (a new address nobody has), so someone away from home
 * would silently lose the phone. A named tunnel comes back at the same address.
 */
export function quickTunnelBlocker(status: Pick<PhoneStatus, 'online'>): string | undefined {
  const online = status.online
  if (!online || online.mode === 'named' || online.state === 'error' || online.state === 'off') {
    return undefined
  }
  return 'phone access is online through a quick tunnel (its address would be lost)'
}

/** A later phone request (or `off`) took over while this one was still going online. */
export class PhoneSuperseded extends Error {
  constructor() {
    super('phone access was changed by a later request while this one was in progress')
  }
}

export interface PhoneStatus {
  running: boolean
  lan: boolean
  port?: number
  address?: string
  connections: number
  /** Who is connected (address, device, since). Always shown by the dashboard. */
  phones: PhoneConnection[]
  /** The tunnel, while online (or trying to be). */
  online?: TunnelStatus
  expireHours?: number
}

/** The keyring entry (secrets.ts) that holds a named tunnel's token. */
export const TUNNEL_TOKEN_SECRET = 'cloudflare-tunnel-token'
export const DEFAULT_NAMED_TUNNEL_PORT = 8767

/** A named tunnel's token: the keyring first, then NSQ_TUNNEL_TOKEN in the daemon's environment. */
export async function namedTunnelToken(): Promise<string | undefined> {
  const stored = await getSecret(TUNNEL_TOKEN_SECRET)
  if (stored) return stored
  const fromEnv = process.env['NSQ_TUNNEL_TOKEN']
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined
}

function tokenFile(): string {
  return join(paths.home(), 'phone-token')
}

export function readPhoneToken(): string | undefined {
  try {
    const value = readFileSync(tokenFile(), 'utf8').trim()
    return isPairingToken(value) ? value : undefined
  } catch {
    return undefined
  }
}

function writePhoneToken(token: string): void {
  const file = tokenFile()
  if (process.platform === 'win32') {
    writeFileAtomic(file, token)
    return
  }
  // Created 0600 from the first byte (never readable by others, even briefly), then renamed in.
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, token, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function forgetPhoneToken(): void {
  rmSync(tokenFile(), { force: true })
}

/** How old the pairing token is (its file's age), or undefined. */
function tokenAgeMs(now = Date.now()): number | undefined {
  try {
    return now - statSync(tokenFile()).mtimeMs
  } catch {
    return undefined
  }
}

/** Runs the phone server for a host; at most one at a time. */
export class PhoneAccess {
  private server: PhoneServer | null = null
  private lan = false
  private port: number | undefined
  private expireHours: number | undefined
  private sweep: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<(event: PhoneHostEvent) => void>()
  private readonly tunnel: CloudflareTunnel
  /** Bumped by every start/stop/cancel: an older start that wakes up after an await gives way. */
  private generation = 0
  private download: AbortController | null = null

  constructor(
    private readonly host: Omit<PhoneHost, 'subscribe'>,
    private readonly log: (line: string) => void,
    /** Called when the phone access or who is connected may have changed. */
    private readonly changed: () => void = () => {}
  ) {
    this.tunnel = new CloudflareTunnel(
      (status) => {
        // The connector died (or never got an address): its listener closes too.
        if (status.state === 'error') void this.server?.closeTunnelOrigin()
        this.changed()
      },
      (line) => this.log(line)
    )
  }

  /** Host events (status, attention, the agent list changed), for whoever listens. */
  emit(event: PhoneHostEvent): void {
    if (!this.server) return
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /**
   * Brings phone access in line with the settings. The local server is restarted only when its
   * address or port changed (phones on the Wi-Fi stay connected when only `online` changes), and
   * resolves once the tunnel has its address or failed (status().online says which).
   */
  async start(settings: PhoneSettings): Promise<PhoneStatus> {
    this.cancelPending()
    const generation = this.generation
    const live = (): boolean => generation === this.generation
    const lan = settings.lan === true
    const port = settings.port ?? DEFAULT_PHONE_PORT
    const reuse = this.server && this.lan === lan && this.port === port && port !== 0
    if (!reuse) {
      await this.startServer(lan, port)
      if (!live()) throw new PhoneSuperseded()
    }
    this.expireHours =
      settings.expireHours && settings.expireHours > 0 ? settings.expireHours : undefined
    this.expireIfDue()
    if (settings.online) await this.goOnline(settings, live)
    else await this.goOffline()
    if (!live()) throw new PhoneSuperseded()
    this.changed()
    return this.status()
  }

  /**
   * A newer request is coming: a start still downloading cloudflared or waiting for its address
   * gives way (the download is aborted, a starting connector stopped). A running tunnel is left
   * alone — the newer request keeps or stops it.
   */
  cancelPending(): void {
    this.generation += 1
    this.download?.abort()
    this.download = null
    const state = this.tunnel.status().state
    if (state === 'installing' || state === 'starting') this.tunnel.stop()
  }

  private async startServer(lan: boolean, port: number): Promise<void> {
    await this.closeServer()
    let token = readPhoneToken()
    if (!token) {
      token = generatePairingToken()
      writePhoneToken(token)
    }
    const server = new PhoneServer({
      host: {
        ...this.host,
        subscribe: (listener) => {
          this.listeners.add(listener)
          return () => this.listeners.delete(listener)
        }
      },
      token,
      bindAddress: lan ? '0.0.0.0' : '127.0.0.1',
      port,
      log: (line) => this.log(line),
      onConnectionsChange: () => this.changed()
    })
    await server.start()
    this.server = server
    this.lan = lan
    this.port = port
    // A phone that only goes quiet drops out after a minute; nothing else reports that. The
    // same beat replaces a pairing token that outlived `expireHours`.
    this.sweep = setInterval(() => {
      this.expireIfDue()
      this.changed()
    }, 15_000)
    this.sweep.unref()
  }

  /** `expireHours` reached: a new token, every phone signed out (they pair again). */
  private expireIfDue(): void {
    if (!this.server || !this.expireHours) return
    const age = tokenAgeMs()
    if (age === undefined || age < this.expireHours * 3_600_000) return
    this.log(`phone: the pairing token is ${this.expireHours} h old; replaced, phones pair again`)
    this.rotate()
  }

  /** Starts the tunnel (downloading cloudflared on first use), or keeps the one that runs. */
  private async goOnline(settings: PhoneSettings, live: () => boolean): Promise<void> {
    const server = this.server
    if (!server) return
    const mode: TunnelMode = settings.tunnel === 'named' ? 'named' : 'quick'
    // A named tunnel's service URL (set in the Cloudflare dashboard) is a fixed local port.
    const wantedPort = mode === 'named' ? (settings.tunnelPort ?? DEFAULT_NAMED_TUNNEL_PORT) : 0
    const current = this.tunnel.status()
    if (current.mode === mode && (current.state === 'running' || current.state === 'starting')) {
      if (mode === 'quick') return
      if (
        current.url === normalizeTunnelHostname(settings.tunnelHostname ?? '') &&
        server.tunnelOriginPort() === wantedPort
      )
        return
    }
    this.tunnel.stop()
    let token: string | undefined
    let hostname: string | undefined
    if (mode === 'named') {
      token = await namedTunnelToken()
      if (!live()) return
      hostname = settings.tunnelHostname
      if (!token || !hostname) {
        this.tunnel.fail(
          mode,
          !token
            ? 'No tunnel token saved: nsq phone tunnel-token set (or NSQ_TUNNEL_TOKEN in the environment).'
            : 'No hostname for the named tunnel: nsq phone on --online --tunnel-token --hostname <host>.'
        )
        return
      }
    }
    let binary: string
    let downloaded = false
    const controller = new AbortController()
    this.download = controller
    try {
      const override = process.env['NSQ_CLOUDFLARED']
      if (override?.trim()) {
        binary = override.trim()
      } else {
        const found = await ensureCloudflared({
          binDir: join(paths.home(), 'bin'),
          onProgress: (fraction) => {
            if (live()) this.tunnel.installing(mode, fraction)
          },
          signal: controller.signal,
          ...(settings.refreshCloudflared ? { refresh: true } : {})
        })
        binary = found.path
        downloaded = found.source !== 'path'
        if (found.source === 'fresh-download') {
          this.log(`phone: cloudflared ${found.version ?? ''} downloaded and verified`.trim())
        }
      }
    } catch (error) {
      if (live()) this.tunnel.fail(mode, error instanceof Error ? error.message : String(error))
      return
    } finally {
      if (this.download === controller) this.download = null
    }
    if (!live() || this.server !== server) return
    // A listener left from another mode or port is not the one this tunnel forwards to.
    const open = server.tunnelOriginPort()
    if (open !== undefined && wantedPort !== 0 && open !== wantedPort) {
      await server.closeTunnelOrigin()
    }
    const originPort = await server.openTunnelOrigin(wantedPort)
    if (!live()) return
    const status = await this.tunnel.start({
      binary,
      origin: `http://127.0.0.1:${originPort}`,
      mode,
      ...(token ? { token } : {}),
      ...(hostname ? { hostname } : {}),
      stateDir: join(paths.home(), 'cloudflared')
    })
    if (!live()) return
    if (status.state === 'error' && downloaded) {
      // Cloudflare stops serving connectors older than about a year; ours runs --no-autoupdate.
      this.tunnel.fail(
        mode,
        `${status.error ?? 'cloudflared failed'} If this keeps happening, cloudflared may be too old: nsq phone on --online --refresh`
      )
    }
    if (status.state !== 'running' && this.server === server) await server.closeTunnelOrigin()
  }

  private async goOffline(): Promise<void> {
    this.tunnel.stop()
    await this.server?.closeTunnelOrigin()
  }

  async stop(): Promise<void> {
    this.cancelPending()
    await this.closeServer()
  }

  private async closeServer(): Promise<void> {
    this.tunnel.stop()
    const server = this.server
    this.server = null
    this.port = undefined
    this.listeners.clear()
    if (this.sweep) clearInterval(this.sweep)
    this.sweep = null
    await server?.stop()
    if (server) this.changed()
  }

  rotate(): void {
    const token = generatePairingToken()
    writePhoneToken(token)
    this.server?.rotateToken(token)
  }

  status(): PhoneStatus {
    if (!this.server) return { running: false, lan: false, connections: 0, phones: [] }
    const { address, port } = this.server.address()
    const online = this.tunnel.status()
    return {
      running: true,
      lan: this.lan,
      address,
      port,
      connections: this.server.connectionCount(),
      phones: this.server.connections(),
      ...(online.state !== 'off' ? { online } : {}),
      ...(this.expireHours ? { expireHours: this.expireHours } : {})
    }
  }

  /** The public https address while online (no token in it). */
  onlineUrl(): string | undefined {
    const online = this.tunnel.status()
    return this.server && online.state === 'running' ? online.url : undefined
  }

  /**
   * The links a phone opens (each carries the token). Only for `nsq phone pair` (and
   * `nsq phone on --online`, which is pairing). The online one first.
   */
  pairingLinks(): string[] {
    const token = readPhoneToken()
    if (!this.server || !token) return []
    const { port } = this.server.address()
    const hosts = this.lan ? lanAddresses() : ['127.0.0.1']
    const online = this.onlineUrl()
    return [
      ...(online ? [pairingUrl(online, token)] : []),
      ...hosts.map((address) => pairingUrl({ address, port }, token))
    ]
  }
}
