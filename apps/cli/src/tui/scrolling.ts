// Scrolling back through an agent's output in the dashboard: which keys and
// wheel notches scroll, and the line that says how far back the view is.
// The scroll state itself is term-view's `createScrollback`.
import { WHEEL_LINES, type Scrollback } from '@neurosquad/term-view'
import type { KeyEvent, MouseEvent } from './keys.js'

/**
 * A key that scrolls instead of going to the agent, or null. Shift+PgUp /
 * Shift+PgDn page, Shift+Home / Shift+End go to the oldest line / the live
 * screen; while scrolled back PgUp, PgDn, Home and End do the same without
 * Shift. On the alternate screen (a full-screen TUI) nothing scrolls here:
 * those keys belong to the agent.
 */
export function scrollKey(
  key: KeyEvent,
  state: { scrolled: boolean; alternate: boolean }
): 'page-up' | 'page-down' | 'top' | 'bottom' | null {
  if (state.alternate || key.ctrl || key.alt) return null
  if (!key.shift && !state.scrolled) return null
  switch (key.name) {
    case 'pageup':
      return 'page-up'
    case 'pagedown':
      return 'page-down'
    case 'home':
      return 'top'
    case 'end':
      return 'bottom'
    default:
      return null
  }
}

/** Applies a scroll key; returns whether the view moved. */
export function applyScrollKey(scroll: Scrollback, action: ReturnType<typeof scrollKey>): boolean {
  switch (action) {
    case 'page-up':
      return scroll.page(-1)
    case 'page-down':
      return scroll.page(1)
    case 'top':
      return scroll.toTop()
    case 'bottom':
      return scroll.toBottom()
    default:
      return false
  }
}

/** A wheel notch on the scrollback: 3 lines, a page with Shift. Returns whether the view moved. */
export function applyWheel(scroll: Scrollback, event: MouseEvent): boolean {
  const up = event.button === 'wheelup'
  if (event.shift) return scroll.page(up ? -1 : 1)
  return scroll.scrollBy(up ? WHEEL_LINES : -WHEEL_LINES)
}

/** The tile's footer while scrolled back: "↑ 120 lines · End or any key to return". */
export function scrolledLabel(offset: number, keysGoToAgent: boolean): string {
  const lines = `↑ ${offset} line${offset === 1 ? '' : 's'}`
  return keysGoToAgent
    ? `${lines} · End or any key to return`
    : `${lines} · wheel down or Shift+End to return`
}
