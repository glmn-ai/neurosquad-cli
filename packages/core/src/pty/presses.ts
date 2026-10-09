// Key presses sent one write at a time. A TUI reads one write as one key: two Escapes in one
// write arrive as Alt+Escape (or an escape sequence), not as two presses.

/** The pause between presses: OpenCode's "esc again to interrupt" (the desktop app uses the same). */
export const KEY_PRESS_GAP_MS = 250

/**
 * Writes the first press now and each next one `gapMs` later, while `live()` still holds (the
 * agent may have exited or restarted meanwhile). The first write's error reaches the caller (no
 * key was delivered); a later one that throws (a closing pty) just ends the sequence.
 */
export function sendPresses(
  presses: readonly string[],
  write: (data: string) => void,
  live: () => boolean,
  gapMs: number = KEY_PRESS_GAP_MS
): void {
  const next = (index: number): void => {
    if (index >= presses.length || (index > 0 && !live())) return
    if (index === 0) write(presses[0])
    else {
      try {
        write(presses[index])
      } catch {
        return
      }
    }
    if (index + 1 < presses.length) {
      const timer = setTimeout(() => next(index + 1), gapMs)
      timer.unref?.()
    }
  }
  next(0)
}
