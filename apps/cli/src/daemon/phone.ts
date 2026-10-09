// Phone access (`nsq phone on`): the daemon serves @neurosquad/remote's phone
// API. The phone can read agents and their screens, send a prompt, answer a
// permission prompt and interrupt — the same paths the daemon's own clients
// use. Off by default; loopback unless the person asks for the LAN.
//
// The pairing token is a credential: it lives in a 0600 file in the nsq home
// (as the daemon's own token does), is shown only by `nsq phone pair`, and
// `nsq phone rotate` replaces it, cutting off every paired phone.
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@neurosquad/core'
import {
  DEFAULT_PHONE_PORT,
  PhoneServer,
  generatePairingToken,
  isPairingToken,
  lanAddresses,
  pairingUrl,
  type PhoneConnection,
  type PhoneHost,
  type PhoneHostEvent
} from '@neurosquad/remote'
import { paths } from '../paths.js'

export interface PhoneSettings {
  enabled?: boolean
  /** Listen on every interface so a phone on the same network can connect. */
  lan?: boolean
  port?: number
}

export interface PhoneStatus {
  running: boolean
  lan: boolean
  port?: number
  address?: string
  connections: number
  /** Who is connected (address, device, since). Always shown by the dashboard. */
  phones: PhoneConnection[]
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

/** Runs the phone server for a host; at most one at a time. */
export class PhoneAccess {
  private server: PhoneServer | null = null
  private lan = false
  private sweep: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<(event: PhoneHostEvent) => void>()

  constructor(
    private readonly host: Omit<PhoneHost, 'subscribe'>,
    private readonly log: (line: string) => void,
    /** Called when the phone access or who is connected may have changed. */
    private readonly changed: () => void = () => {}
  ) {}

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

  async start(settings: PhoneSettings): Promise<PhoneStatus> {
    await this.stop()
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
      bindAddress: settings.lan ? '0.0.0.0' : '127.0.0.1',
      port: settings.port ?? DEFAULT_PHONE_PORT,
      log: (line) => this.log(line),
      onConnectionsChange: () => this.changed()
    })
    await server.start()
    this.server = server
    this.lan = settings.lan === true
    // A phone that only goes quiet drops out after a minute; nothing else reports that.
    this.sweep = setInterval(() => this.changed(), 15_000)
    this.sweep.unref()
    this.changed()
    return this.status()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
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
    return {
      running: true,
      lan: this.lan,
      address,
      port,
      connections: this.server.connectionCount(),
      phones: this.server.connections()
    }
  }

  /** The links a phone opens (each carries the token). Only for `nsq phone pair`. */
  pairingLinks(): string[] {
    const token = readPhoneToken()
    if (!this.server || !token) return []
    const { port } = this.server.address()
    const hosts = this.lan ? lanAddresses() : ['127.0.0.1']
    return hosts.map((address) => pairingUrl({ address, port }, token))
  }
}
