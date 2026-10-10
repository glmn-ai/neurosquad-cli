// The one place that decides which status facts about an agent are real.
//
// Every harness integration turns its hooks, plugin reports or terminal scans
// into facts, and they pass through this pure state machine first, which
// closes three holes a stream of raw facts has:
//
//   1. "Needs you" that never goes away. Most harnesses report the moment
//      they *ask* (a permission dialog, a question) but nothing at the moment
//      the person *answers* — Claude Code's next hook after "Yes" is the
//      tool's PostToolUse (after a 10-minute build, that is 10 minutes of a
//      wrong status), and after "No"/Escape there is no hook at all.
//   2. The same state announced twice (a repeated needs-input = a second
//      sound; a Stop after the person already dismissed the dialog).
//   3. A stale state surviving a restart of the process that reported it.
//
// Its rules, in order:
//
//   - A hook is the truth when it *changes* the state; a repeat is dropped
//     (a needs-input repeat with new wording is passed on `quiet` — the
//     record updates, nothing rings again).
//   - The person's own keystrokes into the agent's terminal (never the host's
//     programmatic writes, never the terminal's automatic replies) move a
//     waiting agent on at once: an answer key (Enter, a digit, y/n/a) →
//     working, Escape / Ctrl+C → idle. Both are *optimistic*: until a hook
//     confirms, output going quiet for QUIET_MS means the agent is really
//     sitting at its prompt → idle. A working TUI is never quiet that long.
//   - For DISMISS_GRACE_MS after the person dismissed a question, the
//     harness's echo of it (OpenCode: "answered" + session idle; a Stop) is
//     dropped — unless they submitted something new meanwhile.
//   - Escape / Ctrl+C while working is an interrupt only if the output then
//     stops (harnesses differ: OpenCode needs Escape twice, Claude Code sends
//     no hook on an interrupt at all).
//   - A turn end reported before the current state was established (a
//     Claude Code Stop decided late, after a new prompt was submitted) is
//     about an older turn and is dropped.
//   - Between a process exit and the next spawn, facts are stale and dropped;
//     a spawn clears whatever the dead process last said (published as
//     `idle`, origin `reset`).
//   - For Claude Code the transcript is the ground truth behind the hooks
//     (./claudeTranscript.ts, ./claudeReconciler.ts): a turn end, an
//     interrupt or an API error written *after* the current state was
//     established ends a working (or waiting) agent; a turn started after a
//     finished one (a dequeued prompt, which sends no UserPromptSubmit)
//     makes it working again. Only entries newer than the state count.
//   - Subagents (Claude Code's Agent tool, OpenCode's `task` child sessions)
//     run inside the parent agent. While any of them runs the agent stays
//     working: the parent's own turn end is held, and the agent finishes
//     SUBAGENT_SETTLE_MS after the last one stopped if no turn of the
//     parent's own started meanwhile. A subagent's stop is never the parent's.
//
// Pure: no timers, no I/O. ./hub.ts owns the wiring and the clock.
import type { AgentHookKind, AgentStatusKind, SubagentInfo } from './types.js'
import type { TranscriptView } from './claudeTranscript.js'

/** How long a TUI has to stay silent for an unconfirmed guess to settle as idle. */
export const QUIET_MS = 3000

/** A Stop/"finished" this soon after the person dismissed a question adds nothing — they are looking. */
export const DISMISS_GRACE_MS = 5000

/**
 * The model answered (end_turn) but neither the Stop hook nor the
 * transcript's turn end followed for this long: the turn is over (a lost
 * hook, a build that writes no turn_duration). Normally both follow within
 * ~150 ms (measured).
 */
export const ANSWERED_SETTLE_MS = 10_000

/**
 * A turn end with a prompt still queued behind it: Claude takes that prompt
 * the moment the turn ends (no UserPromptSubmit for it), so "finished" there
 * rings for a agent that is about to work on. Wait this long for the dequeued
 * turn to show; a queue count the tail got wrong (an absorbed prompt) still
 * ends the turn after it.
 */
export const QUEUED_SETTLE_MS = 3000

/**
 * The last subagent stopped after the parent's own turn had ended: a harness
 * that hands a background subagent's result back to the parent (Claude Code's
 * `<task-notification>` turn) starts that turn within this; otherwise the
 * agent finishes.
 */
export const SUBAGENT_SETTLE_MS = 3000

/**
 * A parent turn held for subagents that never report a stop (a lost hook, a
 * harness that died under them) still finishes after this.
 */
export const SUBAGENT_MAX_HOLD_MS = 60 * 60_000

/** One subagent the harness reported running inside the agent. */
export type SubagentRun = SubagentInfo

export interface MachineState {
  /** What was last published. `undefined` = nothing yet (a hookless or fresh agent). */
  kind?: AgentStatusKind
  detail?: string
  /** When `kind` was established (epoch ms) — the transcript only counts what happened after it. */
  since?: number
  /**
   * An unconfirmed guess from the person's keystrokes (or an interrupt key):
   * if the output stays quiet for QUIET_MS from `since` without a hook, the
   * agent is idle. Any hook clears it.
   */
  pending?: { since: number }
  /** When the person dismissed a question (Escape) — see DISMISS_GRACE_MS. */
  dismissedAt?: number
  /** The process is gone: facts until the next spawn are stale. */
  dead?: boolean
  /** Subagents running inside the agent right now (see SubagentRun). Absent = none. */
  subagents?: SubagentRun[]
  /**
   * The parent's own turn ended while subagents still ran: `finished` is held
   * until they are done. `at`: when it ended; `detail`: its wording;
   * `settleFrom`: when the last of them stopped (SUBAGENT_SETTLE_MS from there).
   */
  held?: { at: number; detail?: string; settleFrom?: number }
}

export type StatusSignal =
  | {
      type: 'hook'
      kind: AgentHookKind
      detail?: string
      /**
       * A working fact that only *resumes* a waiting agent (Claude Code's
       * PostToolUse): it must not turn a finished agent back into a working
       * one — a background subagent's tool call after Stop would, and nothing
       * would ever finish it again.
       */
      resumeOnly?: boolean
      /**
       * For a turn end that is decided a while after the harness reported it
       * (Claude Code's Stop waits for a transcript read, or is held 1.5 s for
       * a queued prompt): when it was reported. A state established after that
       * belongs to a newer turn (a prompt submitted meanwhile, a question it
       * asked, the person's interrupt) — the late turn end is not about it.
       */
      reportedAt?: number
    }
  | { type: 'input'; data: string }
  | { type: 'quiet' }
  | { type: 'spawn' }
  | { type: 'exit' }
  /** What the harness's own transcript tail says (Claude Code). */
  | { type: 'transcript'; view: TranscriptView }
  /**
   * The subagents running inside the agent now — the whole set, replacing the
   * previous one (./subagents.ts keeps it per agent).
   */
  | { type: 'subagents'; running: SubagentRun[] }
  /** The clock, for a held turn (SUBAGENT_SETTLE_MS / SUBAGENT_MAX_HOLD_MS). */
  | { type: 'settle' }

export type StatusOrigin = 'hook' | 'user' | 'reset' | 'transcript'

export interface Publish {
  kind: AgentStatusKind
  detail?: string
  /**
   * `hook`: the harness said so. `user`: the person's keystrokes (or the quiet
   * after them). `reset`: a fresh process. `transcript`: the harness's own
   * transcript showed it (a turn end, an interrupt, an API error, a new turn
   * no hook announced).
   */
  origin: StatusOrigin
  /** Updates the record only: no sound, toast or attention flag. */
  quiet?: boolean
  /** A turn end an error caused (an API error): announced, but the prompt queue is not drained into it. */
  error?: boolean
}

export interface StepResult {
  state: MachineState
  publish: Publish | null
}

export type UserKey = 'answer' | 'dismiss' | null

// eslint-disable-next-line no-control-regex
const BRACKETED_PASTE = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g
/** Keys that pick an option in the harnesses' approval / question dialogs. */
const ANSWER_KEY = /^[1-9yYnNaA]$/

/**
 * What a chunk the person typed into the terminal means for a waiting agent.
 * Pasted text is content, never a key (a paste with a newline in it is not an
 * Enter). Terminal auto-replies (CPR, DA, focus, OSC) are none of these: they
 * start with ESC and are longer than a bare Escape, and carry no `\r`.
 */
export function classifyUserKey(data: string): UserKey {
  const keys = data.replace(BRACKETED_PASTE, '')
  if (keys === '\x1b' || keys === '\x1b\x1b' || keys === '\x03') return 'dismiss'
  if (keys.includes('\r')) return 'answer'
  if (ANSWER_KEY.test(keys)) return 'answer'
  return null
}

const drop = (state: MachineState): StepResult => ({ state, publish: null })

/** A new state of `kind`, established now, and its publication. */
function become(
  kind: AgentStatusKind,
  now: number,
  origin: StatusOrigin,
  extra: {
    detail?: string
    pending?: { since: number }
    dismissedAt?: number
    error?: boolean
  } = {}
): StepResult {
  const { detail, pending, dismissedAt, error } = extra
  return {
    state: {
      kind,
      since: now,
      ...(detail ? { detail } : {}),
      ...(pending ? { pending } : {}),
      ...(dismissedAt !== undefined ? { dismissedAt } : {})
    },
    publish: { kind, ...(detail ? { detail } : {}), origin, ...(error ? { error: true } : {}) }
  }
}

/** The person dismissed a question a moment ago: the harness's echo of that is not news. */
function withinDismissGrace(state: MachineState, now: number): boolean {
  return (
    state.kind === 'idle' &&
    state.dismissedAt !== undefined &&
    now - state.dismissedAt < DISMISS_GRACE_MS
  )
}

/** The wording a agent shows for a turn an API error ended. English, like the harnesses' own. */
export function apiErrorDetail(errorKind?: string): string {
  return errorKind ? `Claude stopped: API error (${errorKind})` : 'Claude stopped: API error'
}

/** The transcript shows the turn over, after `since`: what that means, or null. */
function transcriptEnd(
  view: TranscriptView,
  since: number,
  now: number
): { kind: 'finished' | 'idle'; detail?: string; error?: boolean } | null {
  if (view.at <= since) return null
  switch (view.phase) {
    case 'ended':
      if (view.queued > 0 && now - view.at < QUEUED_SETTLE_MS) return null
      return { kind: 'finished' }
    case 'answered':
      return now - view.at >= ANSWERED_SETTLE_MS ? { kind: 'finished' } : null
    case 'interrupted':
      return { kind: 'idle' }
    case 'error':
      return { kind: 'finished', detail: apiErrorDetail(view.errorKind), error: true }
    default:
      return null
  }
}

function stepTranscript(state: MachineState, view: TranscriptView, now: number): StepResult {
  if (state.dead || state.kind === undefined || state.since === undefined) return drop(state)
  const since = state.since
  if (state.kind === 'working' || state.kind === 'needs-input') {
    const end = transcriptEnd(view, since, now)
    if (end) return become(end.kind, now, 'transcript', end)
    // The model wrote again after the question was put: it was answered
    // (a mouse click, a reply the keys did not show).
    if (
      state.kind === 'needs-input' &&
      view.assistantAt !== undefined &&
      view.assistantAt > since
    ) {
      return become('working', now, 'transcript')
    }
    return drop(state)
  }
  // finished / idle: a turn that started after it (a dequeued prompt — no
  // UserPromptSubmit for it — or one whose hook was lost) is running.
  if (
    view.turnStartedAt !== undefined &&
    view.turnStartedAt > since &&
    (view.phase === 'busy' || view.phase === 'answered')
  ) {
    return become('working', now, 'transcript')
  }
  return drop(state)
}

const sameRuns = (a: readonly SubagentRun[], b: readonly SubagentRun[]): boolean =>
  a.length === b.length &&
  a.every((run, i) => run.id === b[i].id && run.name === b[i].name && run.since === b[i].since)

/** The subagent set changed: a held turn starts or stops settling; a new one after a turn end is work. */
function stepSubagents(state: MachineState, running: SubagentRun[], now: number): StepResult {
  const before = state.subagents ?? []
  if (sameRuns(before, running)) return drop(state)
  const next: MachineState = { ...state }
  if (running.length > 0) next.subagents = running
  else delete next.subagents
  if (state.dead || state.kind === undefined) return drop(next)
  if (next.held) {
    next.held =
      running.length === 0
        ? { ...next.held, settleFrom: next.held.settleFrom ?? now }
        : { at: next.held.at, ...(next.held.detail ? { detail: next.held.detail } : {}) }
  }
  // One that started after the agent finished or went idle (a background
  // subagent the parent launched, reported late): the agent is at work again.
  const known = new Set(before.map((run) => run.id))
  const fresh = running.some(
    (run) => !known.has(run.id) && state.since !== undefined && run.since > state.since
  )
  if (fresh && (state.kind === 'finished' || state.kind === 'idle')) {
    const result = become('working', now, 'hook')
    return { state: { ...result.state, subagents: running }, publish: result.publish }
  }
  return drop(next)
}

/** The clock for a held turn: the subagents are done (and settled), or the hold ran out. */
function stepSettle(state: MachineState, now: number): StepResult {
  const held = state.held
  if (!held || state.dead) return drop(state)
  const settled =
    !state.subagents?.length &&
    held.settleFrom !== undefined &&
    now - held.settleFrom >= SUBAGENT_SETTLE_MS
  const expired = now - held.at >= SUBAGENT_MAX_HOLD_MS
  if (!settled && !expired) return drop(state)
  const result = become('finished', now, 'hook', held.detail ? { detail: held.detail } : {})
  // An expired hold: the subagents still listed are presumed lost.
  return expired ? result : { ...result, state: carrySubagents(result.state, state) }
}

function carrySubagents(target: MachineState, from: MachineState): MachineState {
  return from.subagents?.length ? { ...target, subagents: from.subagents } : target
}

/**
 * When the next tick is due for a held turn (agentHooks.ts arms a timer for
 * it), or null when nothing is held.
 */
export function settleDue(state: MachineState): number | null {
  const held = state.held
  if (!held || state.dead) return null
  const expiry = held.at + SUBAGENT_MAX_HOLD_MS
  if (held.settleFrom !== undefined && !state.subagents?.length) {
    return Math.min(held.settleFrom + SUBAGENT_SETTLE_MS, expiry)
  }
  return expiry
}

/** A signal that starts a new turn of the parent's own (not a subagent's tool call). */
function startsParentTurn(state: MachineState, signal: StatusSignal): boolean {
  if (signal.type === 'hook') return signal.kind === 'working' && !signal.resumeOnly
  if (signal.type === 'input') {
    // A prompt submitted at the parent's own prompt (Enter), not an option key.
    const enter = signal.data.replace(BRACKETED_PASTE, '').includes('\r')
    return enter && state.kind !== 'needs-input'
  }
  if (signal.type === 'transcript') {
    const started = signal.view.turnStartedAt
    return started !== undefined && state.held !== undefined && started > state.held.at
  }
  return false
}

export function step(state: MachineState, signal: StatusSignal, now: number): StepResult {
  if (signal.type === 'subagents') return stepSubagents(state, signal.running, now)
  if (signal.type === 'settle') return stepSettle(state, now)
  const result = stepCore(state, signal, now)
  // A new process: whatever ran inside the old one is gone with it.
  if (signal.type === 'spawn' || signal.type === 'exit') return result
  const running = state.subagents ?? []
  const publish = result.publish
  // The parent's own turn ended while subagents still run: held, not finished
  // (an error ending is announced at once — nothing will continue it).
  if (publish?.kind === 'finished' && !publish.error && running.length > 0 && !state.dead) {
    const base: MachineState =
      state.kind === undefined ? { kind: 'working', since: now } : { ...state }
    const held = state.held ?? {
      at: now,
      ...(publish.detail ? { detail: publish.detail } : {})
    }
    return {
      state: { ...base, held },
      publish: state.kind === undefined ? { kind: 'working', origin: publish.origin } : null
    }
  }
  let next = carrySubagents(result.state, state)
  const keepHeld =
    state.held !== undefined &&
    !startsParentTurn(state, signal) &&
    publish?.kind !== 'idle' &&
    publish?.kind !== 'finished' &&
    next.kind !== 'idle'
  if (keepHeld) next = { ...next, held: state.held }
  else if (next.held) {
    next = { ...next }
    delete next.held
  }
  return { state: next, publish }
}

function stepCore(state: MachineState, signal: StatusSignal, now: number): StepResult {
  switch (signal.type) {
    case 'subagents':
    case 'settle':
      return drop(state)
    case 'spawn': {
      // Whatever the previous process last said is not true of this one.
      const stale = state.kind !== undefined && state.kind !== 'idle'
      if (stale) return become('idle', now, 'reset')
      return { state: state.kind ? { kind: 'idle', since: now } : {}, publish: null }
    }
    case 'exit':
      return drop({ ...(state.kind ? { kind: state.kind, since: state.since } : {}), dead: true })
    case 'quiet': {
      if (!state.pending || state.dead) return drop(state)
      if (state.kind === 'idle') return drop({ kind: 'idle', since: state.since })
      return become('idle', now, 'user')
    }
    case 'transcript':
      return stepTranscript(state, signal.view, now)
    case 'input': {
      if (state.dead || state.kind === undefined) return drop(state)
      const key = classifyUserKey(signal.data)
      if (!key) return drop(state)
      if (state.kind === 'needs-input') {
        if (key === 'dismiss') return become('idle', now, 'user', { dismissedAt: now })
        return become('working', now, 'user', { pending: { since: now } })
      }
      if (state.kind === 'working') {
        // An answer while an earlier answer is unconfirmed (a second question,
        // a free-text reply): keep the guess alive from now.
        if (key === 'answer') {
          return drop(state.pending ? { ...state, pending: { since: now } } : state)
        }
        // Escape / Ctrl+C mid-turn: an interrupt, if the output now stops
        // (or the transcript shows it — Claude Code writes the marker at once).
        return drop({ ...state, pending: { since: now } })
      }
      // After a dismissal the person submits something new: what the harness
      // says next is about that, not an echo of the dismissal.
      if (state.kind === 'idle' && state.dismissedAt !== undefined && key === 'answer') {
        return drop({ kind: 'idle', since: state.since })
      }
      return drop(state)
    }
    case 'hook': {
      if (state.dead) return drop(state)
      const { kind, detail } = signal
      if (kind === 'working') {
        if (state.kind === 'working') {
          // Confirmed: the guess (if any) was right.
          return drop(state.pending ? { kind: 'working', since: state.since } : state)
        }
        if (signal.resumeOnly && state.kind !== 'needs-input') return drop(state)
        // The harness acknowledging the dismissal the person just typed
        // (OpenCode's plugin posts "answered" for a rejected permission, then
        // its session goes idle — measured): nothing new has started.
        if (withinDismissGrace(state, now)) return drop(state)
        return become('working', now, 'hook')
      }
      if (kind === 'needs-input') {
        if (state.kind === 'needs-input') {
          if (!detail || detail === state.detail) return drop(state)
          return {
            state: { ...state, detail },
            publish: { kind, detail, origin: 'hook', quiet: true }
          }
        }
        return become(kind, now, 'hook', detail ? { detail } : {})
      }
      // finished
      if (state.kind === 'finished') return drop(state)
      if (
        signal.reportedAt !== undefined &&
        state.since !== undefined &&
        state.since > signal.reportedAt
      ) {
        return drop(state)
      }
      if (withinDismissGrace(state, now)) return drop(state)
      return become(kind, now, 'hook', detail ? { detail } : {})
    }
  }
}
