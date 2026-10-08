// Which native backend and which sound player this machine gets.
import { pathToFileURL } from 'node:url'
import { windowsBridgeScript } from '../assets.js'
import type { System } from '../system.js'
import {
  AFPLAY,
  AfplaySoundBackend,
  MAC_EXTRA_DIRS,
  OSASCRIPT,
  OsascriptBackend,
  TerminalNotifierBackend
} from './macos.js'
import {
  GdbusBackend,
  hasSessionBus,
  LINUX_PLAYERS,
  LinuxSoundBackend,
  NotifySendBackend
} from './linux.js'
import type { SoundBackend, ToastBackend } from './types.js'
import { WindowsBridge, WindowsSoundBackend, WindowsToastBackend } from './windows.js'

export interface SelectOptions {
  appName: string
  appId: string
  iconPath?: string
  native: boolean
  nativeOverSsh: boolean
  registerAppId: boolean
}

export interface Selection {
  toast?: ToastBackend
  /** Why there is no native backend. */
  reason?: string
  sound?: SoundBackend
}

export function isSshSession(env: Record<string, string | undefined>): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)
}

export function selectBackends(sys: System, options: SelectOptions): Selection {
  // Why native toasts are off before even looking (null = go ahead).
  const blocked = !options.native
    ? 'disabled'
    : !options.nativeOverSsh && isSshSession(sys.env)
      ? 'ssh'
      : null
  // Over SSH the speakers, like the screen, belong to the remote machine:
  // the terminal bell is the sound there.
  if (blocked === 'ssh') return { reason: 'ssh' }
  return selectForPlatform(sys, options, blocked)
}

function selectForPlatform(sys: System, options: SelectOptions, blocked: string | null): Selection {
  const selection: Selection = {}

  switch (sys.platform) {
    case 'win32': {
      const bridge = new WindowsBridge(sys, {
        appId: options.appId,
        appName: options.appName,
        ...(options.iconPath ? { iconPath: options.iconPath } : {}),
        // Only when toasts will be used: a sound-only helper has no business
        // writing the AppUserModelID (and the appId may have failed validation).
        register: options.registerAppId && !blocked,
        script: windowsBridgeScript()
      })
      if (!bridge.powershellPath()) {
        selection.reason = 'powershell-not-found'
        return selection
      }
      // Toasts and sound share one helper process.
      selection.sound = new WindowsSoundBackend(bridge)
      if (blocked) selection.reason = blocked
      else {
        const icon = options.iconPath ? pathToFileURL(options.iconPath).href : undefined
        selection.toast = new WindowsToastBackend(bridge, icon)
      }
      return selection
    }
    case 'darwin': {
      const afplay = sys.exists(AFPLAY) ? AFPLAY : sys.which('afplay')
      if (afplay) selection.sound = new AfplaySoundBackend(sys, afplay)
      if (blocked) {
        selection.reason = blocked
        return selection
      }
      const notifier = sys.which('terminal-notifier', MAC_EXTRA_DIRS)
      if (notifier) {
        selection.toast = new TerminalNotifierBackend(
          sys,
          notifier,
          options.appId,
          options.iconPath
        )
      } else if (sys.exists(OSASCRIPT) || sys.which('osascript')) {
        selection.toast = new OsascriptBackend(sys)
      } else selection.reason = 'osascript-not-found'
      return selection
    }
    default: {
      for (const player of LINUX_PLAYERS) {
        const exe = sys.which(player.name)
        if (exe) {
          selection.sound = new LinuxSoundBackend(sys, player.name, exe, player.args)
          break
        }
      }
      if (blocked) {
        selection.reason = blocked
        return selection
      }
      if (!hasSessionBus(sys.env)) {
        selection.reason = 'no-session-bus'
        return selection
      }
      const gdbus = sys.which('gdbus')
      const notifySend = sys.which('notify-send')
      if (gdbus) {
        selection.toast = new GdbusBackend(sys, gdbus, options.appName, options.iconPath)
      } else if (notifySend) {
        selection.toast = new NotifySendBackend(sys, notifySend, options.appName, options.iconPath)
      } else selection.reason = 'no-gdbus-or-notify-send'
      return selection
    }
  }
}
