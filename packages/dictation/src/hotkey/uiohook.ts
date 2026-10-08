// Loads uiohook-napi (MIT) on demand. It is an optional dependency: on a
// headless Linux box, over SSH or under Wayland there is no global key hook,
// and dictation still works through start()/stop() from the app.
import { createRequire } from 'node:module'
import type { KeyHook } from './listener.js'

let cached: KeyHook | undefined

export function loadUiohook(): KeyHook {
  if (!cached) {
    const require = createRequire(import.meta.url)
    const { uIOhook } = require('uiohook-napi') as { uIOhook: KeyHook }
    cached = uIOhook
  }
  return cached
}
