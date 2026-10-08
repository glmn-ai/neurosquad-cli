// createNotifier: the "an agent needs you / finished" signal for nsq, with the
// rules of the NeuroSquad desktop app (agentNotifications.ts):
//   - one notification per id (agent): a newer one replaces it in place;
//   - needs-input stays until answered (no timeout); finished is ordinary;
//   - withdraw(id) the moment the agent works again: a toast asking for an
//     answer that was already given is a lie;
//   - the toast itself is silent, the sound is played separately, so muting
//     means no noise at all rather than "a different noise";
//   - nothing here throws or blocks the caller: failures are logged and the
//     terminal (BEL / OSC) takes over.
import { bundledSound } from './assets.js'
import { selectBackends, type Selection } from './backends/select.js'
import type { PreparedNotification } from './backends/types.js'
import { createSystem, type System } from './system.js'
import { defaultTerminalWriter, detectTerminalProtocol, formatTerminalSignal } from './terminal.js'
import { cleanText, isValidAppId, notificationKey } from './text.js'
import type { Notifier, NotifierOptions, NotifierStatus, ShowRequest, ShowResult } from './types.js'

/** Test seams; not part of the public options. */
export interface NotifierInternals {
  system?: System
  /** Replaces backend selection (tests pass fakes). */
  selection?: Selection
}

const NONE: ShowResult = { via: 'none', sound: false }

function dedupedWarn(): (message: string) => void {
  const seen = new Set<string>()
  return (message) => {
    if (seen.has(message) || seen.size > 200) return
    seen.add(message)
    console.warn(`[nsq notify] ${message}`)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createNotifier(
  options: NotifierOptions,
  internals: NotifierInternals = {}
): Notifier {
  const sys = internals.system ?? createSystem()
  const userLog = options.log ?? dedupedWarn()
  const log = (message: string) => {
    try {
      userLog(message)
    } catch {}
  }

  let native = options.native !== false
  if (!isValidAppId(options.appId)) {
    log(`invalid appId "${options.appId}" (letters, digits, . - _); native notifications off`)
    native = false
  }

  let muted = options.muted === true
  const terminalMode = options.terminal?.mode ?? 'auto'
  const writeTerminal =
    terminalMode === 'never' ? undefined : (options.terminal?.write ?? defaultTerminalWriter())
  const protocol = options.terminal?.protocol ?? detectTerminalProtocol(sys.env)

  let selection: Selection | undefined = internals.selection
  const backends = (): Selection => {
    if (selection) return selection
    try {
      selection = selectBackends(sys, {
        appName: options.appName,
        appId: options.appId,
        ...(options.iconPath ? { iconPath: options.iconPath } : {}),
        native,
        nativeOverSsh: options.nativeOverSsh === true,
        registerAppId: options.registerAppId !== false
      })
    } catch (error) {
      log(`backend selection failed: ${errorText(error)}`)
      selection = { reason: 'selection-failed' }
    }
    if (selection.reason && selection.reason !== 'disabled') {
      log(`no native notifications (${selection.reason}); using the terminal`)
    }
    return selection
  }

  // Per id: a counter bumped by every show and withdraw (a queued show that
  // is no longer the latest word on that id is skipped), and a promise chain
  // so a withdraw never overtakes the show it is meant to take down.
  const epochs = new Map<string, number>()
  const chains = new Map<string, Promise<unknown>>()
  const onScreen = new Set<string>()
  let disposed = false

  const bump = (key: string) => {
    const next = (epochs.get(key) ?? 0) + 1
    epochs.set(key, next)
    return next
  }

  function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    chains.set(key, tail)
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
    return run
  }

  function soundFile(request: ShowRequest): string | undefined {
    if (muted || request.sound === false) return undefined
    if (typeof request.sound === 'string' && request.sound) return request.sound
    return options.sounds?.[request.kind] ?? bundledSound(request.kind)
  }

  async function deliver(
    key: string,
    epoch: number,
    notification: PreparedNotification,
    wantsSound: boolean,
    soundStarted: boolean
  ): Promise<ShowResult> {
    if (disposed || epochs.get(key) !== epoch) return { via: 'none', sound: soundStarted }
    let via: ShowResult['via'] = 'none'
    const toast = backends().toast
    if (toast) {
      const unavailable = await toast.probe().catch((error: unknown) => errorText(error))
      if (unavailable) {
        log(`native notifications unavailable (${unavailable}); using the terminal`)
      } else {
        try {
          await toast.show(notification)
          onScreen.add(key)
          via = 'os'
        } catch (error) {
          log(`${toast.name}: ${errorText(error)}`)
        }
      }
    }
    if (writeTerminal && (terminalMode === 'always' || via !== 'os')) {
      // The bell stands in for the sound when no file could be played.
      const bell = wantsSound && !soundStarted
      const data = formatTerminalSignal(
        protocol,
        { key, title: notification.title, body: notification.body, bell },
        sys.env
      )
      if (data) {
        try {
          writeTerminal(data)
          if (via === 'none') via = 'terminal'
          if (bell) soundStarted = true
        } catch (error) {
          log(`terminal write failed: ${errorText(error)}`)
        }
      }
    }
    return { via, sound: soundStarted }
  }

  return {
    show(request) {
      try {
        if (disposed) return Promise.resolve(NONE)
        const key = notificationKey(String(request.id))
        const epoch = bump(key)
        const notification: PreparedNotification = {
          key,
          title: cleanText(request.title, 200) || options.appName,
          body: cleanText(request.body),
          kind: request.kind
        }
        const wantsSound = !muted && request.sound !== false
        // The sound starts now, outside the per-id queue: it should not wait
        // for a toast that may take a moment (or never come).
        let soundStarted = false
        const file = soundFile(request)
        const player = backends().sound
        if (file && player) {
          soundStarted = true
          void player.play(file).catch((error: unknown) => {
            log(`sound (${player.name}): ${errorText(error)}`)
          })
        }
        return enqueue(key, () =>
          deliver(key, epoch, notification, wantsSound, soundStarted)
        ).catch((error: unknown) => {
          log(`show failed: ${errorText(error)}`)
          return NONE
        })
      } catch (error) {
        log(`show failed: ${errorText(error)}`)
        return Promise.resolve(NONE)
      }
    },

    withdraw(id) {
      try {
        const key = notificationKey(String(id))
        bump(key)
        return enqueue(key, async () => {
          if (!onScreen.delete(key)) return
          const toast = backends().toast
          if (!toast) return
          try {
            await toast.withdraw(key)
          } catch (error) {
            log(`${toast.name} withdraw: ${errorText(error)}`)
          }
        }).catch(() => undefined)
      } catch (error) {
        log(`withdraw failed: ${errorText(error)}`)
        return Promise.resolve()
      }
    },

    setMuted(value) {
      muted = value
    },

    async status(): Promise<NotifierStatus> {
      const base = {
        soundPlayer: null as string | null,
        terminal: writeTerminal ? protocol : null,
        muted
      }
      try {
        const selected = backends()
        base.soundPlayer = selected.sound?.name ?? null
        const toast = selected.toast
        if (!toast) {
          return {
            ...base,
            backend: null,
            replaceable: false,
            ...(selected.reason ? { reason: selected.reason } : {})
          }
        }
        const unavailable = await toast.probe().catch((error: unknown) => errorText(error))
        if (unavailable) return { ...base, backend: null, replaceable: false, reason: unavailable }
        return { ...base, backend: toast.name, replaceable: toast.replaceable }
      } catch (error) {
        return { ...base, backend: null, replaceable: false, reason: errorText(error) }
      }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      await Promise.allSettled([...chains.values()])
      const selected = selection
      if (!selected) return
      await Promise.allSettled([selected.toast?.dispose(), selected.sound?.dispose()])
    }
  }
}
