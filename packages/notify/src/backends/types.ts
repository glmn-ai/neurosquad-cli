import type { BackendName, NotificationKind } from '../types.js'

/** A notification after normalization: the key is a safe tag, the text is clean. */
export interface PreparedNotification {
  key: string
  title: string
  body: string
  kind: NotificationKind
}

export interface ToastBackend {
  readonly name: BackendName
  /** Whether `show` with the same key replaces, and `withdraw` removes. */
  readonly replaceable: boolean
  /** `null` when usable, else why not. Cached by the backend; never rejects. */
  probe(): Promise<string | null>
  /** Rejects on failure (the notifier catches, logs and falls back). */
  show(notification: PreparedNotification): Promise<void>
  /** Rejects on failure. A no-op on backends that cannot withdraw. */
  withdraw(key: string): Promise<void>
  dispose(): Promise<void>
}

export interface SoundBackend {
  readonly name: string
  /** Starts playback; resolves when started (or finished). Rejects on failure. */
  play(file: string): Promise<void>
  dispose(): Promise<void>
}
