// Looking back through an agent's scrollback without disturbing it.
//
// The view's snapshot takes `scrollOffset`: how many lines above the live
// screen to start. A fixed offset would slide with every new line of output,
// so while scrolled back the top line is pinned with an xterm marker instead —
// markers move with the buffer (and are dropped when their line is trimmed off
// the top), so new output never moves what the person is reading. At offset 0
// the view follows the live screen again.
//
// Only the normal screen has scrollback. On the alternate screen (full-screen
// TUIs) the offset is always 0 and the scroll position is forgotten; a program
// that wants the wheel there scrolls itself.

import type { IMarker } from '@xterm/headless'
import type { TermModes, TermView } from './termView.js'

/** Lines per wheel notch. */
export const WHEEL_LINES = 3

export interface Scrollback {
  /** Lines scrolled up from the live screen; 0 = following the live screen. */
  readonly offset: number
  /** Whether the view is scrolled back (offset > 0). */
  readonly scrolled: boolean
  /** How far back the scrollback reaches now (0 on the alternate screen). */
  readonly available: number
  /** Whether there is scrollback to look at: the normal screen, with lines above it. */
  canScroll(): boolean
  /** Scrolls `lines` back (positive) or forward (negative); returns whether the offset changed. */
  scrollBy(lines: number): boolean
  /** A page (the screen's height less one line) back (`-1`) or forward (`1`). */
  page(direction: -1 | 1): boolean
  /** To the oldest line kept. */
  toTop(): boolean
  /** Back to the live screen (follow mode). */
  toBottom(): boolean
  dispose(): void
}

export function createScrollback(view: TermView): Scrollback {
  const term = view.terminal
  let marker: IMarker | undefined

  const release = (): void => {
    marker?.dispose()
    marker = undefined
  }

  const normal = (): boolean => term.buffer.active.type === 'normal'

  const offset = (): number => {
    if (!marker) return 0
    if (!normal()) {
      release()
      return 0
    }
    const baseY = term.buffer.active.baseY
    // Trimmed off the top (the scrollback is full, or was cleared): the oldest line left.
    const top = marker.isDisposed || marker.line < 0 ? 0 : marker.line
    const value = Math.min(baseY, baseY - top)
    if (value <= 0) {
      release()
      return 0
    }
    return value
  }

  const scrollTo = (next: number): boolean => {
    const before = offset()
    if (!normal()) return false
    const buffer = term.buffer.active
    const target = Math.max(0, Math.min(buffer.baseY, Math.round(next)))
    if (target === before) return false
    release()
    if (target > 0) {
      // registerMarker counts from the cursor's line.
      marker = term.registerMarker(buffer.baseY - target - (buffer.baseY + buffer.cursorY))
    }
    return true
  }

  return {
    get offset() {
      return offset()
    },
    get scrolled() {
      return offset() > 0
    },
    get available() {
      return normal() ? term.buffer.active.baseY : 0
    },
    canScroll() {
      return normal() && term.buffer.active.baseY > 0
    },
    scrollBy(lines) {
      return scrollTo(offset() + lines)
    },
    page(direction) {
      return scrollTo(offset() - direction * Math.max(1, term.rows - 1))
    },
    toTop() {
      return scrollTo(Number.MAX_SAFE_INTEGER)
    },
    toBottom() {
      if (!marker) return false
      const was = offset()
      release()
      return was > 0
    },
    dispose: release
  }
}

/**
 * Where a mouse wheel notch over an agent goes: the agent's own mouse
 * reports when it asked for the mouse (`mouse`); cursor keys on the
 * alternate screen without the mouse, as terminals do (`keys` — a pager or a
 * TUI scrolls itself); otherwise the view's scrollback (`scrollback`).
 */
export type WheelTarget = 'mouse' | 'keys' | 'scrollback'

export function wheelTarget(
  modes: Pick<TermModes, 'mouseTracking' | 'alternateScreen'>
): WheelTarget {
  if (modes.mouseTracking !== 'none') return 'mouse'
  if (modes.alternateScreen) return 'keys'
  return 'scrollback'
}

/** The cursor keys for a wheel notch on the alternate screen (`up` = wheel up). */
export function wheelKeys(
  direction: 'up' | 'down',
  modes: Pick<TermModes, 'applicationCursorKeys'>,
  lines = WHEEL_LINES
): string {
  const final = direction === 'up' ? 'A' : 'B'
  return (modes.applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`).repeat(lines)
}
