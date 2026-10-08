// The agents the daemon knows, persisted in `agents.json` (atomic writes).
// No secret is ever stored here.
import { readJsonFile, writeFileAtomic, isHarnessId, type HarnessId } from '@neurosquad/core'
import { paths } from '../paths.js'

export interface AgentRecord {
  id: string
  name: string
  harness: HarnessId
  workspace: string
  cwd: string
  worktree?: { path: string; branch: string; repo: string }
  command?: string[]
  provider?: 'openrouter'
  model?: string
  dangerousMode?: boolean
  createdAt: number
  /** The harness's own session id (Codex, OpenCode). */
  harnessSessionId?: string
  /** Every session the agent used (for its cost). */
  sessionIds?: string[]
  /** A process was spawned at least once: the next start resumes. */
  sessionStarted?: boolean
  /** Should run: restarted by `nsq up` and when the daemon starts. */
  wantRunning: boolean
}

function valid(value: unknown): value is AgentRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    /^[0-9a-f-]{36}$/.test(record.id) &&
    typeof record.name === 'string' &&
    isHarnessId(record.harness) &&
    typeof record.workspace === 'string' &&
    typeof record.cwd === 'string'
  )
}

export class AgentStore {
  private readonly records = new Map<string, AgentRecord>()

  constructor(private readonly file = paths.agents()) {
    try {
      // Unparseable content is moved aside (agents.json.corrupt-<time>) and a
      // backup of an interrupted write is used — never silently replaced by an empty list.
      const parsed = readJsonFile(this.file) as { agents?: unknown[] }
      for (const entry of parsed.agents ?? []) {
        if (valid(entry))
          this.records.set(entry.id, { ...entry, wantRunning: entry.wantRunning === true })
      }
    } catch {
      // No file yet, or nothing usable: start empty.
    }
  }

  all(): AgentRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): AgentRecord | undefined {
    return this.records.get(id)
  }

  /** By id, id prefix, or name (case-insensitive). */
  find(ref: string): AgentRecord | undefined {
    const exact = this.records.get(ref)
    if (exact) return exact
    const lower = ref.toLowerCase()
    const byName = this.all().filter((record) => record.name.toLowerCase() === lower)
    if (byName.length === 1) return byName[0]
    const byPrefix = this.all().filter((record) => record.id.startsWith(lower))
    return byPrefix.length === 1 ? byPrefix[0] : undefined
  }

  put(record: AgentRecord): void {
    this.records.set(record.id, record)
    this.save()
  }

  update(id: string, patch: Partial<AgentRecord>): AgentRecord | undefined {
    const current = this.records.get(id)
    if (!current) return undefined
    const next: AgentRecord = { ...current, ...patch }
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete (next as unknown as Record<string, unknown>)[key]
    }
    this.records.set(id, next)
    this.save()
    return next
  }

  remove(id: string): void {
    if (this.records.delete(id)) this.save()
  }

  /** A unique name: `base`, `base-2`, `base-3`… */
  uniqueName(base: string): string {
    const taken = new Set(this.all().map((record) => record.name.toLowerCase()))
    const clean =
      base
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'agent'
    if (!taken.has(clean.toLowerCase())) return clean
    for (let n = 2; ; n++) {
      const candidate = `${clean}-${n}`
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
  }

  private save(): void {
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, agents: this.all() }, null, 2)}\n`)
  }
}
