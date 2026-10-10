// The live status of every agent: hook payloads in, published status out.
//
// Facts come from each harness's own hooks (Claude Code's command/http hooks,
// Codex's command hooks, OpenCode's plugin), from the person's keystrokes into
// the agent's terminal, from the pty's lifecycle and — for Claude Code — from
// the session transcript, the ground truth behind the hooks. They all pass
// through the pure state machine (./machine.ts), which decides what is real;
// this module owns the clock (quiet checks, transcript polls, held turns)
// and the per-harness interpretation of hook payloads.
//
// The host plugs in through `configureStatusHub`: which harness an agent runs,
// its dangerous mode, where to record a harness session id, and the sink for
// published changes. Pty lifecycle arrives through ../pty/events.ts.
import type { AgentHookEvent, AgentHookKind, AgentStatusSnapshot } from './types.js'
import {
  QUIET_MS,
  classifyUserKey,
  settleDue,
  step,
  type MachineState,
  type Publish,
  type StatusSignal
} from './machine.js'
import {
  clearSubagents,
  setSubagentSink,
  subagentStarted,
  subagentStopped,
  subagentsOf,
  type SubagentRun
} from './subagents.js'
import {
  forgetTranscript,
  hasTranscript,
  noteTranscriptPath,
  refreshTranscript
} from './claudeReconciler.js'
import { observePtys } from '../pty/events.js'
import {
  BACKGROUND_TASK_DONE,
  CLAUDE_PERMISSION_HOOK_EVENT,
  CLAUDE_TRANSCRIPT_EVENTS,
  claudePermissionReply,
  claudeSubagentPrefix,
  classifyClaudeHook,
  describeClaudePermission
} from '../harnesses/claude/hooks.js'
import { CODEX_HOOK_EVENT, CODEX_TURN_FAILED, classifyCodexHook } from '../harnesses/codex/hooks.js'
import { classifyOpenCodeHook } from '../harnesses/opencode/hooks.js'
import { OPENCODE_PERMISSION_HOOK_EVENT } from '../harnesses/opencode/pluginV2.js'
import { openCodePermissionReply } from '../harnesses/opencode/launch.js'
import { stripAnsi } from '../pty/plainText.js'
import type { HarnessId } from '../harnesses/types.js'

export interface StatusHubHost {
  /** The agent's harness, or undefined for an unknown agent. */
  harnessOf(agentId: string): HarnessId | undefined
  /** The agent's current dangerous mode (read on every permission request). */
  dangerousModeOf(agentId: string): boolean
  /** A harness picked (or switched to) a session id — record it for resume. */
  onSessionId?(agentId: string, sessionId: string, transcriptPath?: string): void
  /** Codex approvals go to its automatic reviewer: a PermissionRequest is nobody's question. */
  codexAutoReview?(agentId: string): boolean
  /** Published status changes. */
  onStatus(event: AgentHookEvent): void
  /** The running subagents of an agent changed. */
  onSubagents?(agentId: string, running: SubagentRun[]): void
  /** A retry OpenCode reported (rate limit…). */
  onRetry?(agentId: string, message: string): void
  /** Diagnostics, never the payloads themselves. */
  trace?(agentId: string, line: string): void
}

let host: StatusHubHost | null = null

export function configureStatusHub(next: StatusHubHost): void {
  host = next
}

function trace(agentId: string, line: string): void {
  try {
    host?.trace?.(agentId, line)
  } catch {
    // diagnostics only
  }
}

const machines = new Map<string, MachineState>()
const lastOutputAt = new Map<string, number>()
const quietTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>()
const settleTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; due: number }>()
const pollTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; due: number }>()
const lives = new Map<string, number>()
const liveGeneration = new Map<string, number>()
let lifeCounter = 0

/** The agent's current process life: a new number on every spawn and exit. */
export function statusLife(agentId: string): number {
  return lives.get(agentId) ?? 0
}

function feed(agentId: string, signal: StatusSignal, label?: string): void {
  const now = Date.now()
  const before = machines.get(agentId) ?? {}
  const { state, publish } = step(before, signal, now)
  machines.set(agentId, state)
  armQuietCheck(agentId, state)
  armSettle(agentId, state)
  if (label)
    trace(agentId, `${label} → ${publish ? `${publish.kind} (${publish.origin})` : 'no change'}`)
  if (publish) publishStatus(agentId, publish)
  armTranscriptPoll(agentId)
}

/** A fact established for an agent (a hook, or the host itself). */
export function emitHookFact(
  agentId: string,
  kind: AgentHookKind,
  detail?: string,
  options: { resumeOnly?: boolean; label?: string; life?: number; reportedAt?: number } = {}
): void {
  if (options.life !== undefined && options.life !== statusLife(agentId)) return
  feed(
    agentId,
    {
      type: 'hook',
      kind,
      ...(detail ? { detail } : {}),
      ...(options.resumeOnly ? { resumeOnly: true } : {}),
      ...(options.reportedAt !== undefined ? { reportedAt: options.reportedAt } : {})
    },
    options.label ?? kind
  )
}

function publishStatus(agentId: string, publish: Publish): void {
  const { kind, detail, origin, quiet, error } = publish
  const change: AgentHookEvent = {
    agentId,
    kind,
    at: Date.now(),
    ...(detail ? { detail } : {}),
    ...(origin !== 'hook' ? { origin } : {}),
    ...(quiet ? { quiet: true } : {}),
    ...(error ? { error: true } : {})
  }
  try {
    host?.onStatus(change)
  } catch (err) {
    console.error('status: sink threw (non-fatal)', err)
  }
}

// ---- held turns (subagents) -----------------------------------------------------

function armSettle(agentId: string, state: MachineState): void {
  const due = settleDue(state)
  const existing = settleTimers.get(agentId)
  if (existing && existing.due === due) return
  if (existing) clearTimeout(existing.timer)
  settleTimers.delete(agentId)
  if (due === null) return
  const timer = setTimeout(
    () => {
      settleTimers.delete(agentId)
      if (machines.has(agentId)) feed(agentId, { type: 'settle' })
    },
    Math.max(0, due - Date.now())
  )
  timer.unref?.()
  settleTimers.set(agentId, { due, timer })
}

setSubagentSink((agentId, running) => {
  if (machines.has(agentId))
    feed(agentId, { type: 'subagents', running }, `subagents: ${running.length}`)
  try {
    host?.onSubagents?.(agentId, running)
  } catch {
    // non-fatal
  }
})

// ---- the Claude Code transcript reconciliation ---------------------------------

const POLL_MS = 1000
const POLL_PENDING_MS = 300
const POST_TURN_WATCH_MS = 15_000

function pollDelay(agentId: string): number | null {
  const state = machines.get(agentId)
  if (!state?.kind || state.dead || !hasTranscript(agentId)) return null
  const active = state.kind === 'working' || state.kind === 'needs-input'
  const settling = state.since !== undefined && Date.now() - state.since < POST_TURN_WATCH_MS
  if (!active && !settling) return null
  return state.pending ? POLL_PENDING_MS : POLL_MS
}

function armTranscriptPoll(agentId: string): void {
  const delay = pollDelay(agentId)
  const existing = pollTimers.get(agentId)
  if (delay === null) {
    if (existing) clearTimeout(existing.timer)
    pollTimers.delete(agentId)
    return
  }
  const due = Date.now() + delay
  if (existing && existing.due <= due) return
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pollTimers.delete(agentId)
    void reconcileWithTranscript(agentId).finally(() => armTranscriptPoll(agentId))
  }, delay)
  timer.unref?.()
  pollTimers.set(agentId, { due, timer })
}

async function reconcileWithTranscript(agentId: string): Promise<void> {
  const view = await refreshTranscript(agentId)
  if (!machines.has(agentId)) return
  if (!view || view.phase === 'unknown') return
  feed(agentId, { type: 'transcript', view })
}

// ---- the quiet check after an unconfirmed guess -------------------------------

function armQuietCheck(agentId: string, state: MachineState): void {
  const existing = quietTimers.get(agentId)
  if (!state.pending) {
    if (existing) clearTimeout(existing.timer)
    quietTimers.delete(agentId)
    return
  }
  const since = state.pending.since
  if (existing?.since === since) return
  if (existing) clearTimeout(existing.timer)
  const check = (): void => {
    quietTimers.delete(agentId)
    const current = machines.get(agentId)
    if (current?.pending?.since !== since) return
    const quietFrom = Math.max(since, lastOutputAt.get(agentId) ?? 0)
    const left = quietFrom + QUIET_MS - Date.now()
    if (left > 0) {
      quietTimers.set(agentId, { timer: setTimeout(check, left), since })
      return
    }
    feed(agentId, { type: 'quiet' }, 'output quiet')
  }
  quietTimers.set(agentId, { timer: setTimeout(check, QUIET_MS), since })
}

/**
 * The person typed into this agent's terminal (an attached client, an inline
 * answer from the dashboard). Never the host's programmatic writes.
 */
export function noteUserInput(agentId: string, data: string): void {
  if (!machines.has(agentId)) return
  const key = classifyUserKey(data)
  feed(agentId, { type: 'input', data }, key ? `key:${key}` : undefined)
  if (key === 'answer') codexAnswered(agentId)
}

// ---- generic agents: status from the terminal alone -----------------------------

/** Output quiet this long after activity = the command is waiting (generic agents). */
export const GENERIC_QUIET_MS = 2500
const genericTimers = new Map<string, ReturnType<typeof setTimeout>>()
const genericBusy = new Set<string>()

function genericOutput(agentId: string): void {
  if (!genericBusy.has(agentId)) {
    genericBusy.add(agentId)
    emitHookFact(agentId, 'working', undefined, { label: 'output' })
  }
  const existing = genericTimers.get(agentId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    genericTimers.delete(agentId)
    if (!genericBusy.delete(agentId)) return
    // A command never claims needs-input: quiet output only means "done for now".
    emitHookFact(agentId, 'finished', undefined, { label: 'output quiet' })
  }, GENERIC_QUIET_MS)
  timer.unref?.()
  genericTimers.set(agentId, timer)
}

// ---- Codex: open turns and the failed-turn line --------------------------------

const codexOpenTurns = new Set<string>()
const codexWaiting = new Set<string>()
const codexFailureTails = new Map<string, string>()

function codexAnswered(agentId: string): void {
  if (!codexWaiting.has(agentId) || !codexOpenTurns.has(agentId)) return
  codexWaiting.delete(agentId)
  emitHookFact(agentId, 'working', undefined, { label: 'codex answered' })
}

function codexOutput(agentId: string, chunk: string): void {
  if (!codexOpenTurns.has(agentId)) {
    codexFailureTails.delete(agentId)
    return
  }
  const tail = ((codexFailureTails.get(agentId) ?? '') + chunk).slice(-1500)
  codexFailureTails.set(agentId, tail)
  if (!tail.includes('■')) return
  if (!CODEX_TURN_FAILED.test(stripAnsi(tail).replace(/\s+/g, ' '))) return
  codexFailureTails.delete(agentId)
  codexOpenTurns.delete(agentId)
  codexWaiting.delete(agentId)
  emitHookFact(agentId, 'finished', undefined, { label: 'codex turn failed' })
}

// ---- pty lifecycle --------------------------------------------------------------

observePtys({
  onSpawn(agentId, generation) {
    lives.set(agentId, ++lifeCounter)
    liveGeneration.set(agentId, generation)
    lastOutputAt.delete(agentId)
    clearSubagents(agentId)
    codexOpenTurns.delete(agentId)
    codexWaiting.delete(agentId)
    genericBusy.delete(agentId)
    feed(agentId, { type: 'spawn' }, machines.has(agentId) ? 'spawn' : undefined)
  },
  onData(agentId, _generation, chunk) {
    if (machines.get(agentId)?.pending) lastOutputAt.set(agentId, Date.now())
    const harness = host?.harnessOf(agentId)
    if (harness === 'codex-cli') codexOutput(agentId, chunk)
    else if (harness === 'command') genericOutput(agentId)
  },
  onExit(agentId, generation) {
    if (liveGeneration.get(agentId) !== generation) return
    lives.set(agentId, ++lifeCounter)
    const timer = genericTimers.get(agentId)
    if (timer) clearTimeout(timer)
    genericTimers.delete(agentId)
    genericBusy.delete(agentId)
    codexOpenTurns.delete(agentId)
    codexWaiting.delete(agentId)
    feed(agentId, { type: 'exit' }, 'exit')
    clearSubagents(agentId)
  },
  onInterrupt(agentId) {
    if (machines.has(agentId)) feed(agentId, { type: 'input', data: '\x1b' }, 'interrupt')
  }
})

// ---- hook payloads ----------------------------------------------------------------

const claudePermissions = new Map<string, { at: number; allowed: boolean; detail: string }>()
const PERMISSION_NOTIFICATION_WINDOW_MS = 120_000
const STOP_HOLD_MS = 1500
const STOP_NEW_TURN_SLACK_MS = 300

function parsePayload(body: string): Record<string, unknown> {
  try {
    // A BOM: Windows PowerShell pipes stdin into curl as UTF-8 with one.
    const parsed = JSON.parse(body.replace(/^\uFEFF/, ''))
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    // Not JSON: an empty payload.
  }
  return {}
}

/**
 * A hook request for `agentId` (its token already checked by the route).
 * `arrivedIn` is the process life when the request arrived: a hook a previous
 * process sent is not about the new one. Returns the body to answer with
 * (`{}` when the hook expects no decision).
 */
export function receiveHook(
  agentId: string,
  event: string,
  body: string,
  arrivedIn: number = statusLife(agentId)
): string {
  const harness = host?.harnessOf(agentId)
  if (!harness) return '{}'
  const payload = parsePayload(body)
  // Permission decisions are answered whatever life they arrived in.
  if (event === CLAUDE_PERMISSION_HOOK_EVENT && harness === 'claude-code') {
    const reply = claudePermissionReply(host?.dangerousModeOf(agentId))
    if (arrivedIn === statusLife(agentId)) {
      if (typeof payload.transcript_path === 'string')
        noteTranscriptPath(agentId, payload.transcript_path)
      claudePermissions.set(agentId, {
        at: Date.now(),
        allowed: reply !== '{}',
        detail: `${claudeSubagentPrefix(payload)}${describeClaudePermission(payload)}`
      })
      trace(
        agentId,
        `PermissionRequest ${reply !== '{}' ? 'allowed (dangerous mode)' : 'recorded'}`
      )
    }
    return reply
  }
  if (event === OPENCODE_PERMISSION_HOOK_EVENT && harness === 'opencode') {
    return openCodePermissionReply(host?.dangerousModeOf(agentId))
  }
  if (arrivedIn !== statusLife(agentId)) {
    trace(agentId, `${event} dropped: sent by a previous process`)
    return '{}'
  }
  if (harness === 'codex-cli' && event === CODEX_HOOK_EVENT) {
    receiveCodex(agentId, payload)
    return '{}'
  }
  if (harness === 'opencode' && event === 'OpenCode') {
    receiveOpenCode(agentId, payload)
    return '{}'
  }
  if (harness === 'claude-code' && CLAUDE_TRANSCRIPT_EVENTS.has(event)) {
    receiveClaude(agentId, event, payload, arrivedIn)
  }
  return '{}'
}

function receiveCodex(agentId: string, payload: Record<string, unknown>): void {
  const { fact, effects } = classifyCodexHook(payload, {
    autoReview: host?.codexAutoReview?.(agentId) === true
  })
  if (effects.sessionId) host?.onSessionId?.(agentId, effects.sessionId, effects.transcriptPath)
  if (effects.turnOpen === true) codexOpenTurns.add(agentId)
  if (effects.turnOpen === false) codexOpenTurns.delete(agentId)
  if (fact?.kind === 'needs-input') codexWaiting.add(agentId)
  else if (fact) codexWaiting.delete(agentId)
  if (fact)
    emitHookFact(agentId, fact.kind, fact.detail, {
      label: `Codex ${String(payload.hook_event_name ?? '')}`
    })
}

function receiveOpenCode(agentId: string, payload: Record<string, unknown>): void {
  const { fact, effects } = classifyOpenCodeHook(payload)
  if (effects.sessionId) host?.onSessionId?.(agentId, effects.sessionId)
  if (effects.subagent) {
    const { event, id, name } = effects.subagent
    if (event === 'start') subagentStarted(agentId, id, name)
    else subagentStopped(agentId, id)
  }
  if (effects.retry) host?.onRetry?.(agentId, effects.retry.message)
  if (fact)
    emitHookFact(agentId, fact.kind, fact.detail, {
      label: `OpenCode ${String(payload.event ?? '')}`
    })
}

function syncClaudeBackgroundSubagents(agentId: string, payload: Record<string, unknown>): void {
  const tasks = payload.background_tasks
  if (!Array.isArray(tasks)) return
  const live = new Map<string, unknown>()
  for (const task of tasks as Record<string, unknown>[]) {
    if (!task || typeof task !== 'object' || task.type !== 'subagent') continue
    if (typeof task.id !== 'string' || !task.id) continue
    if (typeof task.status === 'string' && BACKGROUND_TASK_DONE.has(task.status)) continue
    live.set(task.id, task.agent_type)
  }
  for (const run of subagentsOf(agentId)) {
    if (!live.has(run.id)) subagentStopped(agentId, run.id)
  }
  for (const [id, name] of live) subagentStarted(agentId, id, name)
}

function receiveClaude(
  agentId: string,
  event: string,
  payload: Record<string, unknown>,
  life: number
): void {
  noteTranscriptPath(agentId, payload.transcript_path)
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    const id = typeof payload.agent_id === 'string' ? payload.agent_id : ''
    if (event === 'SubagentStart') subagentStarted(agentId, id, payload.agent_type)
    else subagentStopped(agentId, id)
    return
  }
  if (event === 'Stop') syncClaudeBackgroundSubagents(agentId, payload)
  const fact = classifyClaudeHook(event, payload)
  if (!fact) return
  if (fact.kind === 'needs-input') {
    const type = typeof payload.notification_type === 'string' ? payload.notification_type : ''
    const prefix = claudeSubagentPrefix(payload)
    const fallback = fact.detail && prefix ? `${prefix}${fact.detail}` : fact.detail
    const request = claudePermissions.get(agentId)
    const recent = request && Date.now() - request.at <= PERMISSION_NOTIFICATION_WINDOW_MS
    if ((!type || type === 'permission_prompt') && recent) {
      if (request.allowed) return
      emitHookFact(agentId, 'needs-input', request.detail, { label: 'Notification' })
      return
    }
    if (type === 'permission_prompt') {
      // No PermissionRequest on record: real only while the turn still runs.
      void refreshTranscript(agentId).then((view) => {
        if (view && ['ended', 'answered', 'interrupted', 'error'].includes(view.phase)) return
        emitHookFact(agentId, 'needs-input', fallback, { label: 'Notification', life })
      })
      return
    }
    emitHookFact(agentId, 'needs-input', fallback, { label: 'Notification' })
    return
  }
  claudePermissions.delete(agentId)
  if (event === 'Stop') {
    void claudeStop(agentId, life)
    return
  }
  emitHookFact(agentId, fact.kind, undefined, { resumeOnly: fact.resumeOnly, label: event })
}

/**
 * Claude Code's Stop. A prompt typed while the turn ran is queued and starts
 * the moment the turn ends, with no UserPromptSubmit of its own; "finished"
 * there would ring for an agent that is about to work on. With a queued
 * prompt (or the next turn already running) the Stop waits and is dropped if
 * a new turn shows. Either way the "finished" is decided after the Stop
 * arrived; it carries that moment, so a prompt submitted (or a question
 * asked) in between is not ended by it (machine.ts `reportedAt`).
 */
async function claudeStop(agentId: string, life: number): Promise<void> {
  const stopAt = Date.now()
  const view = await refreshTranscript(agentId)
  const running = view?.phase === 'busy' && view.turnStartedAt !== undefined
  if (!view || (view.queued === 0 && !running)) {
    emitHookFact(agentId, 'finished', undefined, { label: 'Stop', life, reportedAt: stopAt })
    return
  }
  const nextTurnFrom =
    running && view.turnStartedAt !== undefined
      ? Math.min(view.turnStartedAt, stopAt - STOP_NEW_TURN_SLACK_MS)
      : stopAt - STOP_NEW_TURN_SLACK_MS
  setTimeout(() => {
    if (statusLife(agentId) !== life) return
    void refreshTranscript(agentId).then((later) => {
      if (statusLife(agentId) !== life) return
      const continued =
        later?.turnStartedAt !== undefined &&
        later.turnStartedAt >= nextTurnFrom &&
        (later.phase === 'busy' || later.phase === 'answered')
      if (continued) return
      emitHookFact(agentId, 'finished', undefined, {
        label: 'Stop (held)',
        life,
        reportedAt: stopAt
      })
    })
  }, STOP_HOLD_MS)
}

// ---- queries and cleanup ---------------------------------------------------------

export function agentStatusSnapshot(agentId: string): AgentStatusSnapshot | null {
  const state = machines.get(agentId)
  if (!state?.kind || state.dead) return null
  const subagents = subagentsOf(agentId)
  return {
    kind: state.kind,
    at: state.since ?? 0,
    ...(state.detail ? { detail: state.detail } : {}),
    ...(subagents.length > 0 ? { subagents } : {})
  }
}

export function statusMachineState(agentId: string): MachineState | undefined {
  return machines.get(agentId)
}

/** A removed agent: its state, timers and transcript tail go. */
export function forgetAgentStatus(agentId: string): void {
  machines.delete(agentId)
  lastOutputAt.delete(agentId)
  claudePermissions.delete(agentId)
  liveGeneration.delete(agentId)
  lives.delete(agentId)
  for (const timers of [quietTimers, pollTimers, settleTimers]) {
    const entry = timers.get(agentId)
    if (entry) clearTimeout(entry.timer)
    timers.delete(agentId)
  }
  const generic = genericTimers.get(agentId)
  if (generic) clearTimeout(generic)
  genericTimers.delete(agentId)
  genericBusy.delete(agentId)
  codexOpenTurns.delete(agentId)
  codexWaiting.delete(agentId)
  codexFailureTails.delete(agentId)
  clearSubagents(agentId)
  forgetTranscript(agentId)
}
