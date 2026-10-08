// Linux (and the BSDs): the freedesktop notification service over the D-Bus
// session bus.
//   1. gdbus (GLib, on virtually every desktop): calls Notify directly, so
//      the returned id can be passed back as `replaces_id` (replace in place)
//      and to CloseNotification (withdraw).
//   2. notify-send (libnotify) when gdbus is missing: `--print-id` /
//      `--replace-id` where supported (libnotify >= 0.7.9); cannot withdraw.
// needs-input goes out with critical urgency and no expiry, so it stays until
// answered; the toast is silent (`suppress-sound`), our own sound plays instead.
// Sound: paplay (PulseAudio / PipeWire-pulse), pw-play, aplay — first found.
import type { System } from '../system.js'
import type { PreparedNotification, SoundBackend, ToastBackend } from './types.js'

const DEST = 'org.freedesktop.Notifications'
const OBJECT = '/org/freedesktop/Notifications'

/** A GVariant text-format string literal (what gdbus parses each argument as). */
export function gvariantString(text: string): string {
  return (
    "'" +
    text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '') +
    "'"
  )
}

export function hasSessionBus(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.DBUS_SESSION_BUS_ADDRESS || env.DISPLAY || env.WAYLAND_DISPLAY || env.XDG_RUNTIME_DIR
  )
}

function urgency(n: PreparedNotification): number {
  return n.kind === 'needs-input' ? 2 : 1
}

export class GdbusBackend implements ToastBackend {
  readonly name = 'linux-gdbus' as const
  readonly replaceable = true
  private readonly ids = new Map<string, number>()
  private probed: Promise<string | null> | undefined
  /** When the last "no" came back (a "yes" is never asked again). */
  private probedAt: number | undefined

  constructor(
    private readonly sys: System,
    private readonly exe: string,
    private readonly appName: string,
    private readonly iconPath?: string
  ) {}

  private call(method: string, args: string[]) {
    return this.sys.run(
      this.exe,
      [
        'call',
        '--session',
        '--dest',
        DEST,
        '--object-path',
        OBJECT,
        '--method',
        `${DEST}.${method}`,
        ...args
      ],
      { timeoutMs: 5_000 }
    )
  }

  /**
   * Is a notification server actually on the bus? A yes is kept; a no is
   * asked again after a minute (the desktop session may still be starting).
   */
  probe(): Promise<string | null> {
    const now = Date.now()
    if (!this.probed || (this.probedAt !== undefined && now - this.probedAt > 60_000)) {
      this.probedAt = undefined
      this.probed = this.call('GetServerInformation', []).then((result) => {
        if (result.code === 0) return null
        this.probedAt = Date.now()
        return 'no-notification-server'
      })
    }
    return this.probed
  }

  async show(n: PreparedNotification): Promise<void> {
    const replaces = this.ids.get(n.key) ?? 0
    const critical = urgency(n) === 2
    const result = await this.call('Notify', [
      gvariantString(this.appName),
      `uint32 ${replaces}`,
      gvariantString(this.iconPath ?? ''),
      gvariantString(n.title),
      gvariantString(n.body),
      '@as []',
      `{'urgency': <byte ${urgency(n)}>, 'suppress-sound': <true>}`,
      `int32 ${critical ? 0 : -1}`
    ])
    if (result.code !== 0) {
      throw new Error(`gdbus Notify failed: ${result.error ?? result.stderr.trim()}`)
    }
    const id = /uint32\s+(\d+)/.exec(result.stdout)
    if (id) this.ids.set(n.key, Number(id[1]))
  }

  async withdraw(key: string): Promise<void> {
    const id = this.ids.get(key)
    if (id === undefined) return
    this.ids.delete(key)
    const result = await this.call('CloseNotification', [`uint32 ${id}`])
    if (result.code !== 0) {
      throw new Error(`gdbus CloseNotification failed: ${result.error ?? result.stderr.trim()}`)
    }
  }

  async dispose(): Promise<void> {}
}

export class NotifySendBackend implements ToastBackend {
  readonly name = 'linux-notify-send' as const
  readonly replaceable = false
  private readonly ids = new Map<string, number>()
  private printId: Promise<boolean> | undefined

  constructor(
    private readonly sys: System,
    private readonly exe: string,
    private readonly appName: string,
    private readonly iconPath?: string
  ) {}

  async probe(): Promise<string | null> {
    return null
  }

  private supportsPrintId(): Promise<boolean> {
    this.printId ??= this.sys
      .run(this.exe, ['--help'], { timeoutMs: 5_000 })
      .then((result) => /--print-id/.test(result.stdout + result.stderr))
    return this.printId
  }

  async show(n: PreparedNotification): Promise<void> {
    const printId = await this.supportsPrintId()
    const replaces = this.ids.get(n.key)
    const critical = urgency(n) === 2
    const args = [
      '-a',
      this.appName,
      '-u',
      critical ? 'critical' : 'normal',
      ...(critical ? ['-t', '0'] : []),
      ...(this.iconPath ? ['-i', this.iconPath] : []),
      '-h',
      'boolean:suppress-sound:true',
      ...(printId ? ['-p'] : []),
      ...(printId && replaces !== undefined ? ['-r', String(replaces)] : []),
      '--',
      n.title,
      n.body
    ]
    const result = await this.sys.run(this.exe, args, { timeoutMs: 10_000 })
    if (result.code !== 0) {
      throw new Error(`notify-send failed: ${result.error ?? result.stderr.trim()}`)
    }
    const id = /^\s*(\d+)\s*$/m.exec(result.stdout)
    if (printId && id) this.ids.set(n.key, Number(id[1]))
  }

  /** notify-send cannot close a notification. */
  async withdraw(key: string): Promise<void> {
    this.ids.delete(key)
  }

  async dispose(): Promise<void> {}
}

export const LINUX_PLAYERS: { name: string; args: (file: string) => string[] }[] = [
  { name: 'paplay', args: (file) => [file] },
  { name: 'pw-play', args: (file) => [file] },
  { name: 'aplay', args: (file) => ['-q', file] }
]

export class LinuxSoundBackend implements SoundBackend {
  constructor(
    private readonly sys: System,
    readonly name: string,
    private readonly exe: string,
    private readonly argsFor: (file: string) => string[]
  ) {}

  async play(file: string): Promise<void> {
    const result = await this.sys.run(this.exe, this.argsFor(file), { timeoutMs: 15_000 })
    if (result.code !== 0) {
      throw new Error(`${this.name} failed: ${result.error ?? result.stderr.trim()}`)
    }
  }

  async dispose(): Promise<void> {}
}
