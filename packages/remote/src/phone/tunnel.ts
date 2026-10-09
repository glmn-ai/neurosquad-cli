// The tunnel: phone access from anywhere, not only the same Wi-Fi.
//
// `cloudflared` (cloudflared.ts) opens an outbound connection to Cloudflare, and Cloudflare
// forwards `https://<address>` down it to a loopback-only listener of the phone server
// (PhoneServer.openTunnelOrigin). Nothing is opened on the router and the phone gets real HTTPS.
//
// What it costs (hosts say so in words):
//   - The address is public: anyone on the internet can reach the server. The pairing token is
//     still what lets them in (and wrong tokens through the tunnel lock an address out fast).
//   - TLS ends at Cloudflare: their edge sees the traffic, the token included.
//   - A quick tunnel's address is random and changes on every start — a phone has to pair again.
//     A named tunnel (the person's own Cloudflare account and hostname) keeps its address.
//   - Quick tunnels do not carry Server-Sent Events; the phone page long-polls (/api/poll).
//
// One connector process per instance. `generation` lets a stop win over a start that is still
// waiting for its address.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type TunnelMode = 'quick' | 'named'
export type TunnelState = 'off' | 'installing' | 'starting' | 'running' | 'error'

export interface TunnelStatus {
  state: TunnelState
  mode?: TunnelMode
  /** The public https address (no token in it). */
  url?: string
  error?: string
  /** 0…1 while cloudflared downloads. */
  progress?: number
}

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?![\w.-])/gi
/** What a named tunnel prints once Cloudflare accepted a connection. */
const NAMED_READY = /Registered tunnel connection/i
const START_TIMEOUT_MS = 60_000

/**
 * The quick tunnel's address in a line of cloudflared's output, or undefined. cloudflared also
 * prints `api.trycloudflare.com` (where it asks for an address) — that one is not ours.
 */
export function parseQuickTunnelUrl(line: string): string | undefined {
  for (const match of line.matchAll(QUICK_URL)) {
    const url = match[0].toLowerCase()
    if (url === 'https://api.trycloudflare.com') continue
    return url
  }
  return undefined
}

/** `nsq.example.com`, `https://nsq.example.com/` → `https://nsq.example.com`; else undefined. */
export function normalizeTunnelHostname(value: string): string | undefined {
  const host = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/s, '')
    .toLowerCase()
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))
    return undefined
  return `https://${host}`
}

/**
 * The environment cloudflared gets: what it needs to run and reach the internet (proxy settings,
 * certificates), not the daemon's own (API keys of agents, a stray TUNNEL_* that would change
 * what it does).
 */
export function tunnelEnvironment(
  source: NodeJS.ProcessEnv,
  token?: string
): Record<string, string> {
  const keep =
    /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|XDG_CONFIG_HOME)$/i
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && keep.test(key)) env[key] = value
  }
  if (token) env['TUNNEL_TOKEN'] = token
  return env
}

export interface TunnelStartOptions {
  /** cloudflared, or a `.js`/`.mjs` stand-in run with this Node (tests). */
  binary: string
  /** The local origin, `http://127.0.0.1:<port>`. */
  origin: string
  mode: TunnelMode
  /** Named tunnel: its token (passed in the environment, never argv). */
  token?: string
  /** Named tunnel: its public hostname as set up in the Cloudflare dashboard. */
  hostname?: string
  /** A folder for the empty quick-tunnel config. */
  stateDir: string
  timeoutMs?: number
}

export class CloudflareTunnel {
  private child: ChildProcess | null = null
  private generation = 0
  private current: TunnelStatus = { state: 'off' }
  /** Resolves a start() still waiting for its address (a stop wins over it). */
  private settlePending: (() => void) | null = null
  private readonly killOnExit = (): void => {
    try {
      this.child?.kill()
    } catch {
      // Gone.
    }
  }

  constructor(
    private readonly onChange: (status: TunnelStatus) => void = () => {},
    private readonly log: (line: string) => void = () => {}
  ) {}

  status(): TunnelStatus {
    return { ...this.current }
  }

  /** The connector's pid while one runs (tests, diagnostics). */
  pid(): number | undefined {
    return this.child?.pid
  }

  /** Shown while the binary downloads, before start(). */
  installing(mode: TunnelMode, progress: number): void {
    this.set({ state: 'installing', mode, progress })
  }

  /** Marks a failure that happened before a process existed (download refused...). */
  fail(mode: TunnelMode, error: string): void {
    this.set({ state: 'error', mode, error })
  }

  private set(next: TunnelStatus): void {
    this.current = next
    try {
      this.onChange(this.status())
    } catch {
      // The listener's problem.
    }
  }

  /**
   * Starts the connector and resolves once it has its address (state `running`) or failed (state
   * `error`, with a sentence). Never throws.
   */
  start(options: TunnelStartOptions): Promise<TunnelStatus> {
    this.stop()
    const attempt = ++this.generation
    const live = (): boolean => attempt === this.generation
    const mode = options.mode
    if (mode === 'named' && (!options.token || !options.hostname)) {
      this.fail(mode, 'A named tunnel needs its token and its public hostname.')
      return Promise.resolve(this.status())
    }
    this.set({ state: 'starting', mode })

    const args =
      mode === 'quick'
        ? [
            'tunnel',
            '--no-autoupdate',
            '--config',
            emptyConfig(options.stateDir),
            '--url',
            options.origin
          ]
        : ['tunnel', '--no-autoupdate', 'run']
    const script = /\.(c|m)?js$/i.test(options.binary)
    let child: ChildProcess
    try {
      child = spawn(
        script ? process.execPath : options.binary,
        script ? [options.binary, ...args] : args,
        {
          env: tunnelEnvironment(process.env, mode === 'named' ? options.token : undefined),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
    } catch (error) {
      this.fail(
        mode,
        `Could not start cloudflared: ${error instanceof Error ? error.message : String(error)}`
      )
      return Promise.resolve(this.status())
    }
    this.child = child
    process.once('exit', this.killOnExit)

    return new Promise((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.settlePending === settle) this.settlePending = null
        resolve(this.status())
      }
      this.settlePending = settle
      const recent: string[] = []
      const timer = setTimeout(() => {
        if (!live() || this.current.state === 'running') return
        this.fail(
          mode,
          `Cloudflare handed out no address within ${Math.round((options.timeoutMs ?? START_TIMEOUT_MS) / 1000)} s. ${recent.at(-1) ?? ''}`.trim()
        )
        this.kill()
        settle()
      }, options.timeoutMs ?? START_TIMEOUT_MS)

      const onOutput = (chunk: Buffer): void => {
        if (!live()) return
        for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
          const line = raw.trim()
          if (!line) continue
          recent.push(line.slice(0, 300))
          if (recent.length > 8) recent.shift()
          if (this.current.state === 'running') continue
          if (mode === 'quick') {
            const url = parseQuickTunnelUrl(line)
            if (url) {
              this.set({ state: 'running', mode, url })
              this.log(`phone: online through a Cloudflare quick tunnel`)
              settle()
            }
          } else if (NAMED_READY.test(line)) {
            this.set({ state: 'running', mode, url: normalizeTunnelHostname(options.hostname!)! })
            this.log(`phone: online through a named Cloudflare tunnel`)
            settle()
          }
        }
      }
      child.stdout?.on('data', onOutput)
      child.stderr?.on('data', onOutput)
      child.on('error', (error) => {
        if (!live()) return
        this.child = null
        this.fail(mode, `cloudflared failed: ${error.message}`)
        settle()
      })
      child.on('exit', (code) => {
        process.off('exit', this.killOnExit)
        if (!live()) return
        this.child = null
        // Not restarted on its own: a quick tunnel would come back at a new address, i.e. a phone
        // that silently stops working. Better to say so.
        this.fail(
          mode,
          `cloudflared stopped (exit code ${code ?? 'unknown'}). ${recent.at(-1) ?? ''}`.trim()
        )
        settle()
      })
    })
  }

  private kill(): void {
    const running = this.child
    const pending = this.settlePending
    this.child = null
    this.settlePending = null
    this.generation += 1
    pending?.()
    if (!running) return
    process.off('exit', this.killOnExit)
    try {
      running.kill()
    } catch {
      // Already gone.
    }
  }

  stop(): void {
    if (this.current.state !== 'off') this.set({ state: 'off' })
    this.kill()
  }
}

/**
 * An empty config file for quick tunnels: Cloudflare documents that a quick tunnel refuses to start
 * while `~/.cloudflared/config.yaml` exists (anyone who ever set up a tunnel has one).
 */
function emptyConfig(dir: string): string {
  const file = join(dir, 'quick-tunnel.yml')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      file,
      '# Intentionally empty: keeps ~/.cloudflared/config.yaml out of a quick tunnel.\n'
    )
  }
  return file
}
