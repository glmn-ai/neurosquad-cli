// "Quiet while working": an agent that is working but whose screen has not changed for minutes.
//
// Hooks cover what a harness itself asks. They miss what a *tool* asks inside a command the agent
// runs — git wanting a password or a passphrase, an installer's "Continue? [y/N]", sudo, ssh's
// host-key question, a dev server waiting — and a command or a CLI that simply hangs. None of
// them fires a hook: the agent stays "working", and nothing calls the person.
//
// The fallback is the screen itself: when a working agent's screen has not changed in a
// meaningful way for the quiet threshold (minutes), it is flagged *quiet*. "Meaningful" is the
// hard part, because a waiting TUI is not still: Claude Code's spinner turns, its verb changes,
// its timer counts. So screens are compared as text with the animation taken out:
//
//   - spinner glyphs (braille, the star and circle families, a lone | / - \) are one placeholder;
//   - elapsed times (`12s`, `4m 05s`, `1:02:03`) are one placeholder;
//   - against the last meaningful screen (the baseline, not the previous sample — a slow progress
//     bar adds up), a change confined to at most SMALL_LINES non-empty lines of at most SMALL_CELLS cells
//     each, with no digit in it, is animation (a rotating verb, a growing row of dots).
//
// Anything else is real output: new lines (the screen scrolls, every row changes), a counter that
// moves (tokens streaming, a percentage), a redraw of a different screen. Pure: the host owns the
// clock and the screens (nsq's daemon: apps/cli/src/daemon/quiet.ts).

/** The default threshold, in minutes (nsq's `quietAfter`). */
export const DEFAULT_QUIET_AFTER_MIN = 5

/** A change of at most this many cells in a line can be animation. */
export const QUIET_SMALL_CELLS = 12
/** …in at most this many lines. */
export const QUIET_SMALL_LINES = 2
/** The screen line kept as context (the push, the dashboard). */
export const QUIET_LINE_MAX = 300

const SPINNER =
  // braille, quadrants, geometric shapes (circles, triangles), stars, middle dots and bullets,
  // Claude Code's blinking ⏺ — not the full and shaded blocks a progress bar is made of
  /[\u2800-\u28ff\u2596-\u259f\u25a0-\u25ff\u2722-\u274b\u00b7\u2022\u2219\u22c5\u2981\u23fa]/gu
const LONE_ASCII_SPINNER = /(^|\s)[|/\\-](?=\s|$)/g
const ELAPSED =
  /\b\d+(?:[.,]\d+)?\s?(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/gi

/** A screen line with its animation taken out (see the top of this file). */
export function normalizeScreenLine(line: string): string {
  return (
    line
      .replace(ELAPSED, '\u0001')
      // `1h 2m 3s` and `58s` are both one elapsed time
      // eslint-disable-next-line no-control-regex -- the placeholder
      .replace(/\u0001(?:\s*\u0001)+/g, '\u0001')
      .replace(SPINNER, '\u0002')
      .replace(LONE_ASCII_SPINNER, '$1\u0002')
      .trimEnd()
  )
}

/** The changed middle of two lines (common prefix and suffix removed), in code points. */
function changedRegion(a: string, b: string): { cells: number; text: string } {
  const x = [...a]
  const y = [...b]
  let prefix = 0
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++
  let suffix = 0
  while (
    suffix < x.length - prefix &&
    suffix < y.length - prefix &&
    x[x.length - 1 - suffix] === y[y.length - 1 - suffix]
  )
    suffix++
  return {
    cells: Math.max(x.length, y.length) - prefix - suffix,
    text: x.slice(prefix, x.length - suffix).join('') + y.slice(prefix, y.length - suffix).join('')
  }
}

/**
 * Whether `next` differs from `base` in a way that is real output, not animation. Both are the
 * visible rows of the screen as plain text; a different row count (a resize) is a change.
 */
export function screenChanged(base: readonly string[], next: readonly string[]): boolean {
  if (base.length !== next.length) return true
  let small = 0
  for (let row = 0; row < base.length; row++) {
    if (base[row] === next[row]) continue
    const a = normalizeScreenLine(base[row]!)
    const b = normalizeScreenLine(next[row]!)
    if (a === b) continue
    // Text on a row that was empty (or a row cleared) is never an animation frame.
    if (!a.trim() || !b.trim()) return true
    const region = changedRegion(a, b)
    if (region.cells > QUIET_SMALL_CELLS || /\d/.test(region.text)) return true
    small += 1
    if (small > QUIET_SMALL_LINES) return true
  }
  return false
}

/** One line of plain words: control characters out, spaces collapsed. */
function plainLine(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- control characters
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** The last non-empty line of the screen, as plain words (cut to QUIET_LINE_MAX). */
export function lastScreenLine(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = plainLine(lines[i] ?? '')
    if (line) return line.length > QUIET_LINE_MAX ? `${line.slice(0, QUIET_LINE_MAX - 1)}…` : line
  }
  return undefined
}

/** What tools ask on a terminal when they wait for a person. */
const PROMPT_PATTERNS: readonly RegExp[] = [
  /\[(?:y\/n|y\/N|Y\/n|Y\/N|yes\/no)\]/,
  /\((?:y\/n|yes\/no)(?:\/\[fingerprint\])?\)/i,
  /are you sure you want to continue connecting/i,
  /\b(?:password|passphrase|passcode|pin|otp|token|verification code)\b.{0,100}[:?]\s*$/i,
  /\busername for\b.*:\s*$/i,
  /\[sudo\]/i,
  /\b(?:continue|proceed|overwrite|replace|retry)\b[^?]{0,60}\?\s*(?:\(.*\))?\s*$/i,
  /\bpress (?:enter|return|any key)\b/i,
  /\b(?:enter|type) (?:a |the |your )?(?:password|passphrase|pin|code|name|value|selection|choice)\b/i
]

/**
 * When one of the last non-empty lines looks like a tool asking for something (a password, a
 * yes/no), that line as plain words — the newest such line. Only a hint: nsq never answers it.
 */
export function quietPromptHint(lines: readonly string[], lookBack = 3): string | undefined {
  let seen = 0
  for (let i = lines.length - 1; i >= 0 && seen < lookBack; i--) {
    const line = plainLine(lines[i] ?? '')
    if (!line) continue
    seen += 1
    if (PROMPT_PATTERNS.some((pattern) => pattern.test(line)))
      return line.length > 120 ? `…${line.slice(-119)}` : line
  }
  return undefined
}

/** A quiet episode: since when the screen has not changed, and what it showed when flagged. */
export interface QuietFlag {
  /** When the screen last changed meaningfully (or the agent started working). Epoch ms. */
  since: number
  /** When it was flagged (`since` + the threshold, or later). */
  at: number
  /** The last non-empty screen line (plain words; the host masks secrets before showing it). */
  line?: string
  /** That line, or one just above it, looks like a prompt: the line. */
  asking?: string
}

interface Watched {
  /** The last meaningful screen (null: the next sample becomes it). */
  baseline: readonly string[] | null
  since: number
  flag?: QuietFlag
}

/**
 * The per-agent bookkeeping. The host calls `watch` when an agent starts working, `unwatch` when
 * it stops (another status, an exit), `touch` on activity that is not on the screen (the person
 * typed, a hook arrived), `observe` with screen samples, and `due` to flag it.
 */
export class QuietWatch {
  private readonly agents = new Map<string, Watched>()

  /** The agent is working: its clock starts now (an agent already watched keeps its clock). */
  watch(agentId: string, now: number): void {
    if (!this.agents.has(agentId)) this.agents.set(agentId, { baseline: null, since: now })
  }

  watching(agentId: string): boolean {
    return this.agents.has(agentId)
  }

  watched(): string[] {
    return [...this.agents.keys()]
  }

  /** The agent stopped working (or is gone): returns the quiet episode it was in, if any. */
  unwatch(agentId: string): QuietFlag | undefined {
    const watched = this.agents.get(agentId)
    this.agents.delete(agentId)
    return watched?.flag
  }

  /** Progress the screen does not show (input, a hook): the clock restarts; returns an ended episode. */
  touch(agentId: string, now: number): QuietFlag | undefined {
    const watched = this.agents.get(agentId)
    if (!watched) return undefined
    const ended = watched.flag
    watched.since = now
    watched.baseline = null
    delete watched.flag
    return ended
  }

  /**
   * A sample of the visible screen. A meaningful change restarts the clock (and returns the
   * episode it ends); animation does not.
   */
  observe(
    agentId: string,
    lines: readonly string[],
    now: number
  ): { changed: boolean; ended?: QuietFlag } {
    const watched = this.agents.get(agentId)
    if (!watched) return { changed: false }
    if (!watched.baseline) {
      watched.baseline = [...lines]
      return { changed: false }
    }
    if (!screenChanged(watched.baseline, lines)) return { changed: false }
    const ended = watched.flag
    watched.baseline = [...lines]
    watched.since = now
    delete watched.flag
    return { changed: true, ...(ended ? { ended } : {}) }
  }

  /**
   * Flags the agent once it has been quiet for `afterMs` (0: never); returns the flag only when
   * it is new. `lines` is the screen now (for the context line and the prompt hint).
   */
  due(
    agentId: string,
    now: number,
    afterMs: number,
    lines: readonly string[]
  ): QuietFlag | undefined {
    const watched = this.agents.get(agentId)
    if (!watched || watched.flag || !(afterMs > 0) || now - watched.since < afterMs)
      return undefined
    const line = lastScreenLine(lines)
    const asking = quietPromptHint(lines)
    watched.flag = {
      since: watched.since,
      at: now,
      ...(line ? { line } : {}),
      ...(asking ? { asking } : {})
    }
    return watched.flag
  }

  /**
   * The threshold changed under an open episode (`0` = off, or raised past how long it has been
   * quiet): the flag goes, the clock keeps running. Returns the ended episode, if any.
   */
  recheck(agentId: string, now: number, afterMs: number): QuietFlag | undefined {
    const watched = this.agents.get(agentId)
    const flag = watched?.flag
    if (!watched || !flag || (afterMs > 0 && now - watched.since >= afterMs)) return undefined
    delete watched.flag
    return flag
  }

  flag(agentId: string): QuietFlag | undefined {
    return this.agents.get(agentId)?.flag
  }
}
