/** What happened to the agent. Decides how insistent the notification is. */
export type NotificationKind = 'needs-input' | 'finished' | 'error'

export interface ShowRequest {
  /**
   * One notification per id (an agent id): showing again replaces it, and
   * `withdraw(id)` takes it down. Any string; it is normalized per OS.
   */
  id: string
  title: string
  body: string
  /**
   * `needs-input` stays on screen until answered or dismissed (Windows
   * "reminder", Linux critical urgency); the others are ordinary toasts.
   */
  kind: NotificationKind
  /**
   * `true` (default) plays the kind's bundled sound, `false` shows silently
   * (an update of what is already on screen), a string plays that file
   * (WAV is the one format every platform player understands).
   */
  sound?: boolean | string
}

/** Where a notification went. */
export interface ShowResult {
  /** `os` = a native toast, `terminal` = BEL/OSC to the terminal, `none` = nowhere. */
  via: 'os' | 'terminal' | 'none'
  /** Whether a sound (a file or the terminal bell) was started. */
  sound: boolean
}

export type BackendName =
  | 'windows-toast'
  | 'macos-terminal-notifier'
  | 'macos-osascript'
  | 'linux-gdbus'
  | 'linux-notify-send'

export type TerminalProtocol = 'osc9' | 'osc777' | 'osc99' | 'bell'

export interface NotifierStatus {
  /** The native backend in use, or `null` when notifications go to the terminal only. */
  backend: BackendName | null
  /** Why there is no native backend (`ssh`, `no-display`, `toasts-disabled:DisabledForUser`, …). */
  reason?: string
  /** Whether a toast can be replaced and withdrawn by id on this backend. */
  replaceable: boolean
  /** The player for sound files, or `null` (then the terminal bell is the sound). */
  soundPlayer: string | null
  /** How the terminal fallback signals, or `null` when it is off or has nowhere to write. */
  terminal: TerminalProtocol | null
  muted: boolean
}

export interface TerminalOptions {
  /**
   * `auto` (default): only when no native toast could be shown (no backend,
   * over SSH, the toast failed). `always`: in addition to the native toast.
   * `never`: off.
   */
  mode?: 'auto' | 'always' | 'never'
  /**
   * Where the escape sequences go. Default: `process.stderr` when it is a
   * TTY, else `process.stdout` when that is, else nowhere. A daemon passes a
   * writer that reaches the attached client's terminal.
   */
  write?: (data: string) => void
  /** Overrides the detected protocol. */
  protocol?: TerminalProtocol
}

export interface NotifierOptions {
  /** Shown as the sender ("NeuroSquad CLI"). */
  appName: string
  /**
   * A stable reverse-DNS id ("ai.neurosquad.cli"): the Windows
   * AppUserModelID, the macOS terminal-notifier group prefix, the Linux
   * desktop-entry hint. Letters, digits, `.`, `-`, `_`.
   */
  appId: string
  /** Absolute path to a PNG (Windows/Linux icon; terminal-notifier `-appIcon`). */
  iconPath?: string
  /** Start muted: notifications still show, no sound plays. */
  muted?: boolean
  /** Overrides the bundled sound per kind (absolute paths, WAV recommended). */
  sounds?: Partial<Record<NotificationKind, string>>
  /** Terminal fallback (BEL, OSC 9 / OSC 777 / OSC 99). */
  terminal?: TerminalOptions
  /**
   * Native toasts even over SSH (they would appear on the remote machine's
   * screen, so by default an SSH session uses the terminal only).
   */
  nativeOverSsh?: boolean
  /** `false` disables native toasts entirely (terminal + sound only). */
  native?: boolean
  /**
   * Windows: register `appId` as an AppUserModelID under
   * HKCU\Software\Classes\AppUserModelId (default `true`); without it
   * Windows drops toasts from an unpackaged app.
   */
  registerAppId?: boolean
  /** Failures and fallbacks; never thrown. Default: a deduplicated `console.warn`. */
  log?: (message: string) => void
}

export interface Notifier {
  /** Shows or replaces notification `id`. Never rejects; the OS work runs in the background. */
  show(request: ShowRequest): Promise<ShowResult>
  /** Takes notification `id` down (and cancels one still on its way). Never rejects. */
  withdraw(id: string): Promise<void>
  setMuted(muted: boolean): void
  /** What is available on this machine (for `nsq doctor`). Never rejects. */
  status(): Promise<NotifierStatus>
  /** Stops helper processes. Notifications already on screen stay. */
  dispose(): Promise<void>
}
