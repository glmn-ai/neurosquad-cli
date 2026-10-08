// What one report from the OpenCode plugin (./opencodePlugin.ts) means.
// Pure — no stores, no I/O — so the mapping is tested directly
// (opencodeHooks.test.ts).
import type { AgentHookKind } from '../../status/types.js'

export interface OpenCodeHookFact {
  kind: AgentHookKind
  detail?: string
}

export interface OpenCodeRetry {
  message: string
  /** When OpenCode will try again itself (epoch ms), if it said. */
  next?: number
  /** OpenCode's own classification, e.g. `account_rate_limit`, `free_tier_limit`. */
  reason?: string
}

export interface OpenCodeHookEffects {
  /** The main session the agent is working in — becomes `Agent.harnessSessionId`. */
  sessionId?: string
  retry?: OpenCodeRetry
  /**
   * A child session (the `task` tool's subagent) went busy or idle — the
   * agent is working while any runs (../../status/subagents.ts).
   */
  subagent?: { event: 'start' | 'stop'; id: string; name?: string }
}

/** OpenCode session ids: `ses_` + an ascending/descending id (schema/src/session-id.ts). */
const SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/

export function isOpenCodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

const MAX_DETAIL = 300

export function classifyOpenCodeHook(payload: Record<string, unknown>): {
  fact: OpenCodeHookFact | null
  effects: OpenCodeHookEffects
} {
  const event = typeof payload.event === 'string' ? payload.event : ''
  const sessionId = isOpenCodeSessionId(payload.sessionID) ? payload.sessionID : undefined
  switch (event) {
    case 'working':
      // Only the main session goes busy/idle here (the plugin drops child
      // sessions), so this id is the one to resume.
      return { fact: { kind: 'working' }, effects: sessionId ? { sessionId } : {} }
    case 'finished':
      return { fact: { kind: 'finished' }, effects: sessionId ? { sessionId } : {} }
    case 'needs-input': {
      const detail =
        typeof payload.detail === 'string' && payload.detail.trim()
          ? payload.detail.trim().slice(0, MAX_DETAIL)
          : undefined
      // A subagent's session can ask too — its id is not the agent's session.
      return { fact: { kind: 'needs-input', ...(detail ? { detail } : {}) }, effects: {} }
    }
    case 'answered':
      // The prompt was answered, so the turn is moving again.
      return { fact: { kind: 'working' }, effects: {} }
    case 'subagent-start':
    case 'subagent-stop': {
      if (!sessionId) return { fact: null, effects: {} }
      // MiMo Code's in-session subagents ("actors") share the session: the
      // actor id tells them apart (opencodePlugin.ts).
      const actorId =
        typeof payload.actorID === 'string' && /^[\w.-]{1,64}$/.test(payload.actorID)
          ? payload.actorID
          : undefined
      const name =
        typeof payload.agent === 'string' && payload.agent.trim()
          ? payload.agent.trim().slice(0, 64)
          : undefined
      return {
        fact: null,
        effects: {
          subagent: {
            event: event === 'subagent-start' ? 'start' : 'stop',
            id: actorId ? `${sessionId}:${actorId}` : sessionId,
            ...(name ? { name } : {})
          }
        }
      }
    }
    case 'retry': {
      const message = typeof payload.message === 'string' ? payload.message.trim() : ''
      if (!message) return { fact: null, effects: {} }
      const next =
        typeof payload.next === 'number' && Number.isFinite(payload.next) ? payload.next : undefined
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined
      return {
        fact: null,
        effects: {
          ...(sessionId ? { sessionId } : {}),
          retry: {
            message: message.slice(0, MAX_DETAIL),
            ...(next ? { next } : {}),
            ...(reason ? { reason } : {})
          }
        }
      }
    }
    default:
      return { fact: null, effects: {} }
  }
}

/**
 * A retry that is a real usage limit rather than a blip OpenCode's own
 * backoff (5 tries, ≤30 s apart — session/retry.ts) will ride out: its
 * own classification says so, or the message reads like one.
 */
export function isUsageLimitRetry(retry: OpenCodeRetry): boolean {
  if (retry.reason === 'account_rate_limit' || retry.reason === 'free_tier_limit') return true
  return /usage limit|limit reached|usage exceeded|quota/i.test(retry.message)
}

const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000
}

/**
 * "…usage limit reached. It will reset in 2h 15m" (session/retry.ts) → the
 * reset time. Only the relative form OpenCode prints; anything else is left
 * to the caller (the agent then shows the limit without a countdown).
 */
export function parseOpenCodeReset(message: string, now: number): number | undefined {
  const clause = /reset(?:s)?\s+in\s+((?:\d+\s*(?:d|h|m|s)[a-z]*[\s,]*(?:and\s+)?)+)/i.exec(message)
  if (!clause) return undefined
  let total = 0
  for (const [, amount, unit] of clause[1].matchAll(/(\d+)\s*(d|h|m|s)/gi)) {
    total += Number(amount) * UNIT_MS[unit.toLowerCase()]
  }
  return total > 0 ? now + total : undefined
}
