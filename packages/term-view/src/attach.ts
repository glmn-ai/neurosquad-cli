// Raw attach (`nsq attach <name>`): the host terminal becomes the agent's
// terminal — its output is written through untouched and the person's keys
// go straight to the pty. These build the bytes around that stream.

import { NO_INPUT_MODES, hostModeChanges } from './input.js'
import type { TermView } from './termView.js'

/**
 * What to write to the host on attach, before streaming the pty's output:
 * a cleared screen, then the agent's screen as it is now (scrollback
 * included up to `scrollback` lines) with its modes — bracketed paste,
 * focus events, mouse, the alternate screen of a full-screen TUI.
 *
 * The host should be the same size as the agent's pty; the caller resizes
 * the pty to the host first (the most recently attached client wins).
 */
export function attachReplay(view: TermView, options: { scrollback?: number } = {}): string {
  // The serializer restores most modes; the input modes are set explicitly as well.
  return (
    '\x1b[0m\x1b[H\x1b[2J' +
    view.serialize({ scrollback: options.scrollback ?? 200 }) +
    hostModeChanges(NO_INPUT_MODES, view.modes(), true)
  )
}

/**
 * What to write on detach: input modes off, the alternate screen left, pen
 * reset, cursor shown — the host as the TUI around it expects to find it.
 */
export function detachReset(view: TermView): string {
  const modes = view.modes()
  let out = '\x1b[?2026l' + hostModeChanges(modes, NO_INPUT_MODES, true)
  if (modes.alternateScreen) out += '\x1b[?1049l'
  return out + '\x1b[0m\x1b[?25h'
}
