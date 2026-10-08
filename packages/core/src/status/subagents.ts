// Subagents running inside an agent — the set the status machine holds a
// parent's turn end for (./machine.ts `subagents` signal). Claude Code's
// SubagentStart / SubagentStop hooks and OpenCode's child sessions report
// here, keyed by the harness's own id for the subagent; a stop for an unknown
// id changes nothing. Pure bookkeeping plus one sink (./hub.ts).
import type { SubagentRun } from './machine.js'

export type { SubagentRun }

/** At most this many tracked per agent (a runaway fan-out is still "many"). */
const MAX_PER_CARD = 64
/** Names are labels on a chip: short, one line. */
const MAX_NAME = 48

const running = new Map<string, Map<string, SubagentRun>>()

type Sink = (agentId: string, runs: SubagentRun[]) => void
let sink: Sink | undefined

/** agentHooks.ts: told every time a agent's set changes. */
export function setSubagentSink(next: Sink): void {
  sink = next
}

function cleanName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  const line = name.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return line.length > MAX_NAME ? `${line.slice(0, MAX_NAME - 1)}…` : line
}

/** The agent's running subagents, oldest first. */
export function subagentsOf(agentId: string): SubagentRun[] {
  const runs = running.get(agentId)
  if (!runs) return []
  return [...runs.values()].sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1))
}

function changed(agentId: string): void {
  try {
    sink?.(agentId, subagentsOf(agentId))
  } catch (error) {
    console.error('subagents: sink threw (non-fatal)', error)
  }
}

/** A subagent started inside the agent. A repeat (same id) only fills in a missing name. */
export function subagentStarted(
  agentId: string,
  id: string,
  name?: unknown,
  at: number = Date.now()
): void {
  if (!id) return
  let runs = running.get(agentId)
  if (!runs) {
    runs = new Map()
    running.set(agentId, runs)
  }
  const label = cleanName(name)
  const existing = runs.get(id)
  if (existing) {
    if (label && !existing.name) {
      runs.set(id, { ...existing, name: label })
      changed(agentId)
    }
    return
  }
  if (runs.size >= MAX_PER_CARD) return
  runs.set(id, { id, since: at, ...(label ? { name: label } : {}) })
  changed(agentId)
}

/** A subagent ended (done, failed or cancelled). */
export function subagentStopped(agentId: string, id: string): void {
  const runs = running.get(agentId)
  if (!runs?.delete(id)) return
  if (runs.size === 0) running.delete(agentId)
  changed(agentId)
}

/** The agent's subagent with this id is known to be running. */
export function subagentRunning(agentId: string, id: string): boolean {
  return running.get(agentId)?.has(id) ?? false
}

/**
 * Forget every subagent of a agent: its process was replaced or exited, or the
 * agent was deleted.
 */
export function clearSubagents(agentId: string): void {
  if (!running.delete(agentId)) return
  changed(agentId)
}
