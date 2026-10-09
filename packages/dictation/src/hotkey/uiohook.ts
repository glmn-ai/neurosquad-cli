// Loads uiohook-napi (MIT) on demand. It is an optional dependency: on a
// headless Linux box, over SSH or under Wayland there is no global key hook,
// and dictation still works through start()/stop() from the app.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { KeyHook } from './listener.js'

let cached: KeyHook | undefined

type Env = Record<string, string | undefined>

/**
 * Why the global key hook cannot run here, or `undefined` when it can try. On Linux libuiohook
 * needs an X display: without one its hook thread fails (`XOpenDisplay failure!`), prints straight
 * onto the terminal and takes the whole process down — no error ever reaches JavaScript. So the
 * display is checked before the native module is even loaded.
 */
export function keyHookUnavailable(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  if (platform !== 'linux') return undefined
  const display = env.DISPLAY?.trim()
  if (!display) {
    return env.WAYLAND_DISPLAY
      ? 'no X display (Wayland-only session)'
      : 'no X display (SSH, server or container)'
  }
  // A local display (":0", ":1.0", "unix:0") has a socket; a stale one would still crash the hook.
  const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display)
  if (local && !exists(`/tmp/.X11-unix/X${local[1]}`))
    return `the X display ${display} is not running`
  return undefined
}

export function loadUiohook(): KeyHook {
  if (!cached) {
    const reason = keyHookUnavailable()
    if (reason) throw new Error(reason)
    const require = createRequire(import.meta.url)
    const { uIOhook } = require('uiohook-napi') as { uIOhook: KeyHook }
    cached = uIOhook
  }
  return cached
}
