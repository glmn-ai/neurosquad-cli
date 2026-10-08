// Input in attach mode: what the host terminal must be told so that the
// keys, pastes, focus changes and mouse it sends are in the form the agent's
// program asked for.
//
// Attach passes the person's input through untouched. That works only if
// the host terminal is in the same input modes as the agent's program: a
// paste is bracketed (`ESC[200~ … ESC[201~`) only when the host has
// bracketed paste on, focus in/out (`ESC[I`/`ESC[O`) is reported only when
// the host has focus events on, arrow keys come as `ESC O A` only in
// application cursor mode. So while a tile is expanded, the host mirrors the
// program's modes (`hostModeChanges`), and on detach they are switched off.

import type { TermModes } from './termView.js'

const MOUSE_TRACKING_MODE: Record<TermModes['mouseTracking'], number> = {
  none: 0,
  x10: 9,
  vt200: 1000,
  drag: 1002,
  any: 1003
}

const MOUSE_ENCODING_MODE: Record<TermModes['mouseEncoding'], number> = {
  default: 0,
  utf8: 1005,
  sgr: 1006,
  urxvt: 1015
}

function dec(mode: number, on: boolean): string {
  return `\x1b[?${mode}${on ? 'h' : 'l'}`
}

/**
 * The sequences that switch the host terminal from input modes `from` to
 * `to` (only what differs; everything when `force`). Cursor visibility,
 * alternate screen and synchronized output are output state, not input
 * modes, and are left alone.
 */
export function hostModeChanges(from: TermModes, to: TermModes, force = false): string {
  let out = ''
  if (force || from.bracketedPaste !== to.bracketedPaste) out += dec(2004, to.bracketedPaste)
  if (force || from.sendFocus !== to.sendFocus) out += dec(1004, to.sendFocus)
  if (force || from.applicationCursorKeys !== to.applicationCursorKeys) {
    out += dec(1, to.applicationCursorKeys)
  }
  if (force || from.applicationKeypad !== to.applicationKeypad) {
    out += to.applicationKeypad ? '\x1b=' : '\x1b>'
  }
  if (force || from.mouseEncoding !== to.mouseEncoding) {
    const off = MOUSE_ENCODING_MODE[from.mouseEncoding]
    if (off) out += dec(off, false)
    else if (force) out += dec(1006, false)
    const on = MOUSE_ENCODING_MODE[to.mouseEncoding]
    if (on) out += dec(on, true)
  }
  if (force || from.mouseTracking !== to.mouseTracking) {
    const off = MOUSE_TRACKING_MODE[from.mouseTracking]
    if (off) out += dec(off, false)
    else if (force) out += dec(1000, false) + dec(1002, false) + dec(1003, false)
    const on = MOUSE_TRACKING_MODE[to.mouseTracking]
    if (on) out += dec(on, true)
  }
  return out
}

/** Input modes all off — the host's state outside attach mode. */
export const NO_INPUT_MODES: TermModes = Object.freeze({
  bracketedPaste: false,
  sendFocus: false,
  applicationCursorKeys: false,
  applicationKeypad: false,
  mouseTracking: 'none',
  mouseEncoding: 'default',
  cursorVisible: true,
  alternateScreen: false,
  synchronizedOutput: false
})

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Text pasted into the agent the way a terminal would send it: line breaks
 * as CR, and bracketed when the program enabled bracketed paste. Bracket
 * markers inside the text are removed, so a paste cannot end the bracket
 * early and have the rest run as typed keys.
 */
export function encodePaste(text: string, modes: Pick<TermModes, 'bracketedPaste'>): string {
  const normalized = text.replace(/\r?\n/g, '\r')
  if (!modes.bracketedPaste) return normalized
  // eslint-disable-next-line no-control-regex -- the bracket markers are real ESC sequences
  return PASTE_START + normalized.replace(/\x1b\[20[01]~/g, '') + PASTE_END
}

/** Focus in/out for the agent, or '' when its program did not ask for focus events. */
export function encodeFocus(focused: boolean, modes: Pick<TermModes, 'sendFocus'>): string {
  if (!modes.sendFocus) return ''
  return focused ? '\x1b[I' : '\x1b[O'
}
