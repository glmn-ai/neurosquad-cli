// Global dictation hotkey on a raw OS key hook (uiohook-napi): it sees key
// down *and* up, so it can tell a tap from a hold, and it works while the
// terminal is not focused. Modifier state is tracked from the raw events
// rather than trusted from the event's ctrlKey/shiftKey flags, which do not
// reliably reflect modifiers that were already held.
import { KEY_BY_NAME, MODIFIER_SLOT_BY_KEYCODE, type ModifierSlot } from './keycodes.js'

export interface ParsedAccelerator {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  keycode: number
}

/**
 * Parses an Electron-style accelerator such as `CommandOrControl+Shift+Space`
 * or `F9`. Returns `null` when it names an unknown key or no main key.
 */
export function parseAccelerator(
  accelerator: string,
  platform: NodeJS.Platform = process.platform
): ParsedAccelerator | null {
  const result: ParsedAccelerator = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    keycode: -1
  }
  const parts = accelerator.split('+').map((part) => part.trim())
  for (let part of parts) {
    if (part === '') return null
    const lower = part.toLowerCase()
    if (lower === 'commandorcontrol' || lower === 'cmdorctrl') {
      if (platform === 'darwin') result.meta = true
      else result.ctrl = true
    } else if (lower === 'control' || lower === 'ctrl') {
      result.ctrl = true
    } else if (lower === 'alt' || lower === 'option') {
      result.alt = true
    } else if (lower === 'shift') {
      result.shift = true
    } else if (lower === 'super' || lower === 'meta' || lower === 'command' || lower === 'cmd') {
      result.meta = true
    } else {
      if (result.keycode !== -1) return null
      if (part.length === 1) part = part.toUpperCase()
      const code =
        KEY_BY_NAME[part] ??
        Object.entries(KEY_BY_NAME).find(([name]) => name.toLowerCase() === lower)?.[1]
      if (code === undefined) return null
      result.keycode = code
    }
  }
  return result.keycode === -1 ? null : result
}

/**
 * - `auto`: a quick tap toggles recording; holding past the threshold records
 *   until release (push-to-talk).
 * - `toggle`: every press starts or stops.
 * - `push-to-talk`: records only while the key is held.
 */
export type HotkeyMode = 'auto' | 'toggle' | 'push-to-talk'

export interface KeyEvent {
  keycode: number
}

/** The part of uiohook-napi's `uIOhook` this needs; injectable for tests. */
export interface KeyHook {
  on(event: 'keydown' | 'keyup', listener: (event: KeyEvent) => void): unknown
  off(event: 'keydown' | 'keyup', listener: (event: KeyEvent) => void): unknown
  start(): void
  stop(): void
}

/** Holding at least this long counts as push-to-talk in `auto` mode. */
export const HOLD_THRESHOLD_MS = 350

export interface HotkeyListenerOptions {
  accelerator: string
  mode?: HotkeyMode
  hook: KeyHook
  onStart: () => void
  onStop: () => void
  now?: () => number
  platform?: NodeJS.Platform
}

export class HotkeyListener {
  private readonly accelerator: ParsedAccelerator
  private readonly mode: HotkeyMode
  private readonly held: Record<ModifierSlot, boolean> = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false
  }
  private recording = false
  private keyDown = false
  private pressedAt = 0
  private started = false

  constructor(private readonly options: HotkeyListenerOptions) {
    const parsed = parseAccelerator(options.accelerator, options.platform)
    if (!parsed) throw new Error(`unsupported hotkey "${options.accelerator}"`)
    this.accelerator = parsed
    this.mode = options.mode ?? 'auto'
  }

  start(): void {
    if (this.started) return
    this.options.hook.on('keydown', this.handleKeyDown)
    this.options.hook.on('keyup', this.handleKeyUp)
    this.started = true
    try {
      this.options.hook.start()
    } catch (error) {
      this.detach()
      throw error
    }
  }

  stop(): void {
    if (!this.started) return
    this.detach()
    this.options.hook.stop()
  }

  /** Recording was started or stopped elsewhere (CLI key, API): stay in sync. */
  syncRecording(recording: boolean): void {
    this.recording = recording
  }

  private detach(): void {
    this.started = false
    this.options.hook.off('keydown', this.handleKeyDown)
    this.options.hook.off('keyup', this.handleKeyUp)
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private modifiersMatch(): boolean {
    const accel = this.accelerator
    return (
      this.held.ctrl === accel.ctrl &&
      this.held.alt === accel.alt &&
      this.held.shift === accel.shift &&
      this.held.meta === accel.meta
    )
  }

  private readonly handleKeyDown = (event: KeyEvent): void => {
    const slot = MODIFIER_SLOT_BY_KEYCODE[event.keycode]
    if (slot) {
      this.held[slot] = true
      return
    }
    if (event.keycode !== this.accelerator.keycode) return
    if (this.keyDown) return // OS key repeat while held
    if (!this.modifiersMatch()) return
    this.keyDown = true
    this.pressedAt = this.now()
    if (!this.recording) {
      this.recording = true
      this.options.onStart()
    } else if (this.mode !== 'push-to-talk') {
      // Second press while recording (toggle, or a tap-armed auto): stop now.
      this.recording = false
      this.options.onStop()
    }
  }

  private readonly handleKeyUp = (event: KeyEvent): void => {
    const slot = MODIFIER_SLOT_BY_KEYCODE[event.keycode]
    if (slot) {
      this.held[slot] = false
      return
    }
    if (event.keycode !== this.accelerator.keycode || !this.keyDown) return
    this.keyDown = false
    if (!this.recording) return
    const heldLongEnough = this.now() - this.pressedAt >= HOLD_THRESHOLD_MS
    if (this.mode === 'push-to-talk' || (this.mode === 'auto' && heldLongEnough)) {
      this.recording = false
      this.options.onStop()
    }
  }
}
