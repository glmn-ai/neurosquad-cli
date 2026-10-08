// macOS. The modern API (UNUserNotificationCenter) only serves a signed app
// bundle with a bundle identifier; a Node process is neither, and there is no
// maintained npm module that gets around that without shipping its own .app.
// So, in order of preference:
//   1. terminal-notifier (Homebrew), when installed: its own app identity,
//      `-group` replaces a notification in place, `-remove` withdraws it.
//   2. osascript `display notification`: always there, but shows as "Script
//      Editor", needs notifications allowed for Script Editor in System
//      Settings > Notifications (macOS may have it off or ask once), cannot be
//      replaced or withdrawn, and Focus modes silence it.
// Sound: /usr/bin/afplay with our own file (toasts themselves are silent).
import type { System } from '../system.js'
import type { PreparedNotification, SoundBackend, ToastBackend } from './types.js'

export const MAC_EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

/** A leading dash would be read as an option by both tools. */
function safeArg(text: string): string {
  return text.startsWith('-') ? `\u200b${text}` : text
}

export class TerminalNotifierBackend implements ToastBackend {
  readonly name = 'macos-terminal-notifier' as const
  readonly replaceable = true

  constructor(
    private readonly sys: System,
    private readonly exe: string,
    private readonly appId: string,
    private readonly iconPath?: string
  ) {}

  async probe(): Promise<string | null> {
    return null
  }

  private group(key: string): string {
    return `${this.appId}.${key}`
  }

  async show(n: PreparedNotification): Promise<void> {
    const args = [
      '-title',
      safeArg(n.title),
      // An empty -message makes terminal-notifier read the message from stdin.
      '-message',
      safeArg(n.body || n.title),
      '-group',
      this.group(n.key),
      ...(this.iconPath ? ['-appIcon', this.iconPath] : [])
    ]
    const result = await this.sys.run(this.exe, args, { timeoutMs: 10_000 })
    if (result.code !== 0) {
      throw new Error(`terminal-notifier failed: ${result.error ?? result.stderr.trim()}`)
    }
  }

  async withdraw(key: string): Promise<void> {
    const result = await this.sys.run(this.exe, ['-remove', this.group(key)], {
      timeoutMs: 10_000
    })
    if (result.code !== 0) {
      throw new Error(`terminal-notifier -remove failed: ${result.error ?? result.stderr.trim()}`)
    }
  }

  async dispose(): Promise<void> {}
}

export const OSASCRIPT = '/usr/bin/osascript'

export class OsascriptBackend implements ToastBackend {
  readonly name = 'macos-osascript' as const
  readonly replaceable = false

  constructor(private readonly sys: System) {}

  async probe(): Promise<string | null> {
    return null
  }

  async show(n: PreparedNotification): Promise<void> {
    // The text travels as run-handler arguments, never spliced into the script.
    const args = [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e',
      'end run',
      safeArg(n.title),
      safeArg(n.body)
    ]
    const result = await this.sys.run(OSASCRIPT, args, { timeoutMs: 10_000 })
    if (result.code !== 0) {
      throw new Error(`osascript failed: ${result.error ?? result.stderr.trim()}`)
    }
  }

  /** Not possible: an osascript notification has no handle. */
  async withdraw(): Promise<void> {}

  async dispose(): Promise<void> {}
}

export const AFPLAY = '/usr/bin/afplay'

export class AfplaySoundBackend implements SoundBackend {
  readonly name = 'afplay'

  constructor(
    private readonly sys: System,
    private readonly exe: string
  ) {}

  async play(file: string): Promise<void> {
    const result = await this.sys.run(this.exe, [file], { timeoutMs: 15_000 })
    if (result.code !== 0) throw new Error(`afplay failed: ${result.error ?? result.stderr.trim()}`)
  }

  async dispose(): Promise<void> {}
}
