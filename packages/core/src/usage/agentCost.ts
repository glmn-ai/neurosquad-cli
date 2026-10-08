// One agent's spend: the requests of its harness sessions, summed exactly.
// Tokens are integers, money integer picodollars; a request with no known
// price is counted as unpriced — never as $0.
import type { UsageRecord, UsageTotals } from './types.js'
import { EMPTY_TOTALS } from './types.js'
import { listCost } from './pricing.js'

export interface AgentCost {
  totals: UsageTotals
  /** Best-known cost: the harness's own record where it keeps one, the list price otherwise. */
  pico: bigint
  /** Requests with neither (a local model, a model missing from the price table). */
  unpricedRequests: number
  /** Models seen, most requests first. */
  models: string[]
  firstAt?: number
  lastAt?: number
}

export function emptyAgentCost(): AgentCost {
  return { totals: { ...EMPTY_TOTALS }, pico: 0n, unpricedRequests: 0, models: [] }
}

/** The cost of the records whose session is one of `sessionIds` (and, optionally, at or after `since`). */
export function agentCost(
  records: readonly UsageRecord[],
  sessionIds: ReadonlySet<string>,
  options: { since?: number; price?: (record: UsageRecord) => bigint | undefined } = {}
): AgentCost {
  const out = emptyAgentCost()
  const models = new Map<string, number>()
  for (const record of records) {
    if (!sessionIds.has(record.sessionId)) continue
    if (options.since !== undefined && record.at < options.since) continue
    const t = out.totals
    t.input += record.input
    t.cacheRead += record.cacheRead
    t.cacheWrite += record.cacheWrite
    t.cacheWrite1h += record.cacheWrite1h
    t.output += record.output
    t.thinking += record.reasoning
    t.requests += 1
    t.webSearches += record.webSearches
    const recorded = record.recordedPico === undefined ? undefined : BigInt(record.recordedPico)
    const list = options.price ? options.price(record) : listCost(record).pico
    const cost = recorded ?? list
    if (cost === undefined) out.unpricedRequests += 1
    else out.pico += cost
    models.set(record.model, (models.get(record.model) ?? 0) + 1)
    out.firstAt = out.firstAt === undefined ? record.at : Math.min(out.firstAt, record.at)
    out.lastAt = out.lastAt === undefined ? record.at : Math.max(out.lastAt, record.at)
  }
  out.models = [...models.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model)
  return out
}
