import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { KEY_BY_NAME, MODIFIER_SLOT_BY_KEYCODE } from './keycodes.js'
import {
  HOLD_THRESHOLD_MS,
  HotkeyListener,
  parseAccelerator,
  type HotkeyMode,
  type KeyEvent,
  type KeyHook
} from './listener.js'

class FakeHook extends EventEmitter implements KeyHook {
  started = 0
  stopped = 0
  start(): void {
    this.started++
  }
  stop(): void {
    this.stopped++
  }
  down(keycode: number): void {
    this.emit('keydown', { keycode } satisfies KeyEvent)
  }
  up(keycode: number): void {
    this.emit('keyup', { keycode } satisfies KeyEvent)
  }
}

const CTRL = 0x001d
const SHIFT = 0x002a
const SPACE = KEY_BY_NAME.Space

function setup(mode: HotkeyMode, accelerator = 'Ctrl+Shift+Space') {
  const hook = new FakeHook()
  let clock = 0
  const events: string[] = []
  const listener = new HotkeyListener({
    accelerator,
    mode,
    hook,
    now: () => clock,
    onStart: () => events.push('start'),
    onStop: () => events.push('stop')
  })
  listener.start()
  const press = (holdMs: number): void => {
    hook.down(CTRL)
    hook.down(SHIFT)
    hook.down(SPACE)
    clock += holdMs
    hook.up(SPACE)
    hook.up(SHIFT)
    hook.up(CTRL)
    clock += 50
  }
  return { hook, listener, events, press, advance: (ms: number) => (clock += ms) }
}

describe('parseAccelerator', () => {
  it('maps CommandOrControl per platform', () => {
    expect(parseAccelerator('CommandOrControl+Shift+Space', 'darwin')).toEqual({
      ctrl: false,
      alt: false,
      shift: true,
      meta: true,
      keycode: SPACE
    })
    expect(parseAccelerator('CmdOrCtrl+Shift+Space', 'linux')).toMatchObject({
      ctrl: true,
      meta: false
    })
  })

  it('accepts lone keys, letters in any case and function keys', () => {
    expect(parseAccelerator('F9')).toMatchObject({ keycode: 0x43, ctrl: false })
    expect(parseAccelerator('alt+d')).toMatchObject({ alt: true, keycode: KEY_BY_NAME.D })
    expect(parseAccelerator('num5')).toMatchObject({ keycode: 0x4c })
  })

  it('rejects unknown keys, two main keys and modifier-only combos', () => {
    expect(parseAccelerator('Ctrl+Nope')).toBeNull()
    expect(parseAccelerator('A+B')).toBeNull()
    expect(parseAccelerator('Ctrl+Shift')).toBeNull()
    expect(parseAccelerator('Ctrl++')).toBeNull()
  })

  it('throws for an unusable accelerator at construction', () => {
    expect(
      () =>
        new HotkeyListener({
          accelerator: 'Ctrl+Nope',
          hook: new FakeHook(),
          onStart: () => undefined,
          onStop: () => undefined
        })
    ).toThrow(/unsupported hotkey/)
  })
})

describe('HotkeyListener', () => {
  it('auto: a tap toggles, a hold is push-to-talk', () => {
    const { events, press } = setup('auto')
    press(100) // tap: start, stays armed
    expect(events).toEqual(['start'])
    press(100) // second tap: stop
    expect(events).toEqual(['start', 'stop'])
    press(HOLD_THRESHOLD_MS + 100) // hold: start on down, stop on release
    expect(events).toEqual(['start', 'stop', 'start', 'stop'])
  })

  it('toggle: every press flips, regardless of hold time', () => {
    const { events, press } = setup('toggle')
    press(1000)
    expect(events).toEqual(['start'])
    press(10)
    expect(events).toEqual(['start', 'stop'])
  })

  it('push-to-talk: records only while held', () => {
    const { events, press } = setup('push-to-talk')
    press(20)
    expect(events).toEqual(['start', 'stop'])
  })

  it('ignores key repeat and wrong modifiers', () => {
    const { hook, events } = setup('auto')
    hook.down(SPACE) // no modifiers
    hook.up(SPACE)
    hook.down(CTRL)
    hook.down(SPACE) // Ctrl only
    hook.up(SPACE)
    hook.up(CTRL)
    expect(events).toEqual([])
    hook.down(CTRL)
    hook.down(SHIFT)
    hook.down(SPACE)
    hook.down(SPACE) // OS auto-repeat
    hook.down(SPACE)
    expect(events).toEqual(['start'])
  })

  it('stays in sync when recording is stopped elsewhere', () => {
    const { listener, events, press } = setup('auto')
    press(100)
    listener.syncRecording(false)
    press(100)
    expect(events).toEqual(['start', 'start'])
  })

  it('detaches from the hook on stop', () => {
    const { hook, listener, events, press } = setup('toggle')
    listener.stop()
    expect(hook.stopped).toBe(1)
    expect(hook.listenerCount('keydown')).toBe(0)
    press(10)
    expect(events).toEqual([])
  })
})

describe('keycodes', () => {
  it('match uiohook-napi when it can be loaded', (context) => {
    let UiohookKey: Record<string, number>
    try {
      UiohookKey = (
        createRequire(import.meta.url)('uiohook-napi') as { UiohookKey: Record<string, number> }
      ).UiohookKey
    } catch {
      context.skip()
      return
    }
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      expect(KEY_BY_NAME[letter]).toBe(UiohookKey[letter])
    }
    for (let i = 1; i <= 24; i++) expect(KEY_BY_NAME[`F${i}`]).toBe(UiohookKey[`F${i}`])
    for (let i = 0; i <= 9; i++) expect(KEY_BY_NAME[`num${i}`]).toBe(UiohookKey[`Numpad${i}`])
    expect(KEY_BY_NAME.Space).toBe(UiohookKey.Space)
    expect(KEY_BY_NAME.Delete).toBe(UiohookKey.Delete)
    expect(KEY_BY_NAME.Down).toBe(UiohookKey.ArrowDown)
    expect(KEY_BY_NAME['`']).toBe(UiohookKey.Backquote)
    expect(KEY_BY_NAME.numdiv).toBe(UiohookKey.NumpadDivide)
    for (const name of [
      'Ctrl',
      'CtrlRight',
      'Alt',
      'AltRight',
      'Shift',
      'ShiftRight',
      'Meta',
      'MetaRight'
    ]) {
      expect(MODIFIER_SLOT_BY_KEYCODE[UiohookKey[name]]).toBe(
        name.replace('Right', '').toLowerCase()
      )
    }
  })
})
