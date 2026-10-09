// What each agent has spent, read from the harnesses' own logs. Scanned on
// demand (a finished turn, `nsq cost`) and incrementally — a scan reads only
// what was appended since the last one.
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  JsonlSource,
  OpenCodeSource,
  agentCost,
  claudeCodeFormat,
  codexFormat,
  type AgentCost,
  type UsageRecord,
  type UsageSource
} from '@neurosquad/core'
import type { AgentRecord } from './store.js'

/** Claude Code's project folder name for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export class UsageTracker {
  private readonly claudeDirs = new Set<string>()
  private readonly claude: JsonlSource
  private readonly codex: JsonlSource
  private readonly opencode: OpenCodeSource
  private scanning: Promise<void> | null = null
  private records: UsageRecord[] = []

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const claudeRoot = join(env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'projects')
    // Only the folders of nsq's own agents: a user's whole Claude history can be gigabytes.
    this.claude = new JsonlSource({
      ...claudeCodeFormat(() => claudeRoot),
      roots: () => [...this.claudeDirs].map((slug) => join(claudeRoot, slug))
    })
    this.codex = new JsonlSource(codexFormat(() => env['CODEX_HOME'] || join(homedir(), '.codex')))
    this.opencode = new OpenCodeSource()
  }

  /** Records the folders whose Claude Code transcripts belong to these agents. */
  track(agents: readonly AgentRecord[]): void {
    for (const agent of agents) {
      if (agent.harness === 'claude-code') this.claudeDirs.add(claudeProjectSlug(agent.cwd))
    }
  }

  scan(agents: readonly AgentRecord[]): Promise<void> {
    this.track(agents)
    if (this.scanning) return this.scanning
    const harnesses = new Set(agents.map((agent) => agent.harness))
    const sources: UsageSource[] = []
    if (harnesses.has('claude-code')) sources.push(this.claude)
    if (harnesses.has('codex-cli')) sources.push(this.codex)
    if (harnesses.has('opencode')) sources.push(this.opencode)
    this.scanning = (async () => {
      for (const source of sources) {
        try {
          await source.scan()
        } catch {
          // An unreadable log is skipped; the next scan tries again.
        }
      }
      this.records = sources.flatMap((source) => [...source.records()])
    })().finally(() => {
      this.scanning = null
    })
    return this.scanning
  }

  costOf(agent: AgentRecord, since?: number): AgentCost {
    const sessions = new Set(agent.sessionIds ?? [])
    if (agent.harness === 'claude-code') sessions.add(agent.id)
    if (agent.harnessSessionId) sessions.add(agent.harnessSessionId)
    const options = since === undefined ? {} : { since }
    if (agent.provider !== 'custom') return agentCost(this.records, sessions, options)
    // On one of the user's own servers nsq knows no price. Claude Code records every request as
    // `anthropic` (a server model named like an Anthropic one would get its list price), and the
    // session may hold earlier requests whose provider is not told apart: every request of such
    // an agent is unpriced — "no price", never $0 and never a guess.
    const unpriced = this.records.map((record) =>
      record.recordedPico === undefined ? record : { ...record, recordedPico: undefined }
    )
    return agentCost(unpriced, sessions, { ...options, price: () => undefined })
  }
}
