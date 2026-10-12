// The approvals log: every "needs you" question an agent asked and how it ended, across all
// agents, as one JSON line per question in `NSQ_HOME/logs/approvals.jsonl` (append-only, rotated
// at ~10 MB, a few old files kept). After a bad call it answers "which agent asked, what exactly,
// and who said yes — from where".
//
// Fed by the daemon, which every answer passes through: the status events (a question opens on
// `needs-input`; leaving it ends it), the hook payloads (the tool and its command/path/url, read
// before the status machine sees them), and the answer paths themselves (the dashboard's y/a/n,
// `nsq answer`, the phone page, keys typed into the agent's terminal, an interrupt). Never logged:
// the environment, tokens, prompts — only the question as the CLI put it, with secret-looking
// parts of a command masked and long text cut.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import type { AgentHookEvent, HarnessId } from '@neurosquad/core'
import type { AnswerKey } from './answers.js'
import type { QuietEnd, QuietView } from './quiet.js'

export const APPROVALS_FILE = 'approvals.jsonl'
/** The live file is rotated once it would grow past this. */
export const APPROVALS_MAX_BYTES = 10 * 1024 * 1024
/** Rotated files kept next to it (`approvals.1.jsonl` the newest). */
export const APPROVALS_KEEP = 3

const MAX_TEXT = 300
const MAX_COMMAND = 500
const MAX_PATH = 300

/** Where an answer came from: this machine, the local network, or the internet tunnel. */
export type ApprovalOrigin = 'local' | 'lan' | 'internet'

export interface ApprovalBy {
  /**
   * `dashboard` — its y/a/n keys (or its interrupt); `cli` — `nsq answer` / `nsq interrupt`;
   * `phone` — the phone page (or anything else holding the pairing token); `terminal` — keys
   * typed into the agent's own terminal (the dashboard's full-screen view, `nsq attach`).
   */
  via: 'dashboard' | 'cli' | 'phone' | 'terminal'
  from: ApprovalOrigin
  /** The phone's device label ("iPhone · Safari"). */
  device?: string
  /** For `terminal`: whose terminal (`dashboard`, `attach`). */
  client?: string
}

/**
 * How a question ended.
 * - `answered`: yes / always / no through nsq (`by` says who and from where)
 * - `terminal`: answered by typing into the agent's own terminal (`answer` when the key says it)
 * - `cli`: the CLI went on by itself — its own rule, an automatic approval
 * - `ended`: the turn ended with no answer — the CLI gave up, timed out or failed
 * - `interrupted`: an interrupt (`by`) ended the turn while it waited
 * - `exited`: the agent stopped, restarted or was removed while it waited
 * - `unanswered`: nsq itself stopped while it waited
 *
 * A quiet episode (`kind: 'quiet'`) ends with a `QuietEnd`: `output` (the screen changed),
 * `input` (someone typed or sent something — `by`), `hook` (the harness reported progress),
 * `finished` / `needs-input` / `idle` (its status changed), `exited`, `unanswered`.
 */
export type ApprovalOutcome =
  'answered' | 'terminal' | 'cli' | 'ended' | 'interrupted' | 'exited' | 'unanswered' | QuietEnd

export interface ApprovalQuestion {
  /** The question as the CLI worded it (what the dashboard shows). */
  text: string
  tool?: string
  command?: string
  path?: string
  url?: string
}

export interface ApprovalRecord {
  v: 1
  /**
   * `quiet`: not a question the CLI asked but a quiet episode — the agent worked with no new
   * output for the quiet threshold (`askedAt` is when nsq flagged it, `quietSince` when the
   * screen last changed; `question.text` says what the screen showed). Absent: a question.
   */
  kind?: 'quiet'
  quietSince?: string
  /** When it ended (ISO). */
  at: string
  /** When it was asked (ISO). */
  askedAt: string
  agent: { id: string; name: string }
  harness: HarnessId
  /** The agent's folder, the home folder shown as `~`. */
  workspace: string
  question: ApprovalQuestion
  outcome: ApprovalOutcome
  answer?: AnswerKey
  by?: ApprovalBy
}

export interface ApprovalAgent {
  id: string
  name: string
  harness: HarnessId
  workspace: string
}

// ---- secrets and length ---------------------------------------------------------------

const SECRET_NAME =
  '[A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|AUTHORIZATION|CREDENTIALS?)[A-Za-z0-9_-]*'
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // Authorization headers: `Bearer xyz`, `Basic xyz`.
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2***'],
  // An Authorization header's whole value, whatever the scheme (`Token x`, `Digest …`).
  [/\b((?:proxy-)?authorization\s*[:=]\s*)[^"'\r\n]+/gi, '$1***'],
  // curl's -u / --user user:password.
  [/((?:^|\s)(?:-u|--user)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/g, '$1***'],
  // NAME=value / NAME: value where the name says it is a secret.
  [new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi'), '$1$2***'],
  // --token x, --password=x, --api-key x, -p'x' is left alone (too ambiguous).
  [
    /(--?(?:[a-z0-9-]*(?:token|secret|password|passwd|api-?key|authorization)[a-z0-9-]*))(=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi,
    '$1$2***'
  ],
  // user:password@ in a URL.
  [/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^@\s/]+@/gi, '$1:***@'],
  // ?token=… / &key=… in a URL.
  [
    /([?&](?:[a-z0-9_-]*(?:token|key|secret|sig|signature|password|auth)[a-z0-9_-]*)=)[^&\s#]+/gi,
    '$1***'
  ],
  // Well-known key shapes, wherever they are.
  [/\b(sk-(?:ant-|proj-|or-v1-|or-)?)[A-Za-z0-9_-]{12,}/g, '$1***'],
  [/\b(gh[pousr]_|github_pat_|xox[abposr]-|glpat-|AKIA|AIza)[A-Za-z0-9_-]{8,}/g, '$1***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***jwt***']
]

/** Masks the parts of a text that look like credentials (headers, NAME=value, keys, URL auth). */
export function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS)
    result = result.replace(pattern, replacement)
  return result
}

/** One line, secrets masked, cut to `max` characters. */
export function cleanText(text: string, max: number): string {
  const line = redactSecrets(text.replace(/\s+/g, ' ').trim())
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ---- the question from the hook payloads -----------------------------------------------

/** The hook-endpoint events whose payload carries the tool a question is about. */
const CLAUDE_PERMISSION_EVENT = 'ClaudePermission'
const CODEX_EVENT = 'Codex'

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

function fromToolInput(
  tool: string | undefined,
  input: Record<string, unknown>
): Omit<ApprovalQuestion, 'text'> {
  const question: Omit<ApprovalQuestion, 'text'> = {}
  if (tool) question.tool = cleanText(tool, 100)
  let command =
    str(input.command) ?? (Array.isArray(input.command) ? input.command.join(' ') : undefined)
  if (command && tool === 'apply_patch') {
    // A patch: the files it touches, not the diff.
    const files = [...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
      m[1]!.trim()
    )
    command = undefined
    if (files.length) question.path = cleanText(files.join(', '), MAX_PATH)
  }
  if (command) question.command = cleanText(command, MAX_COMMAND)
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  if (path && !question.path) question.path = cleanText(path, MAX_PATH)
  const url = str(input.url)
  if (url) question.url = cleanText(url, MAX_PATH)
  return question
}

/**
 * What a hook payload says about the question about to be asked: the tool and its command, path
 * or url. Null for a payload that asks nothing.
 */
export function questionFromHook(
  harness: HarnessId,
  event: string,
  body: string
): Omit<ApprovalQuestion, 'text'> | null {
  if (
    !(harness === 'claude-code' && event === CLAUDE_PERMISSION_EVENT) &&
    !(harness === 'codex-cli' && event === CODEX_EVENT)
  )
    return null
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(body.replace(/^\uFEFF/, '')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    payload = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (harness === 'codex-cli') {
    const kind = str(payload.hook_event_name)
    const asks =
      kind === 'PermissionRequest' ||
      (kind === 'PreToolUse' && str(payload.tool_name) === 'request_user_input')
    if (!asks) return null
  }
  const input =
    payload.tool_input && typeof payload.tool_input === 'object'
      ? (payload.tool_input as Record<string, unknown>)
      : {}
  return fromToolInput(str(payload.tool_name), input)
}

/** OpenCode puts the tool in its wording: "OpenCode needs your permission: bash — rm -rf dist". */
export function questionFromText(text: string): Omit<ApprovalQuestion, 'text'> {
  const match = /needs your permission: (\S+)(?: — (.+))?$/.exec(text)
  if (!match) return {}
  const tool = match[1]!
  const target = match[2]?.trim()
  const question: Omit<ApprovalQuestion, 'text'> = { tool: cleanText(tool, 100) }
  if (!target || target.endsWith('…')) return question
  if (/^https?:\/\//i.test(target)) question.url = cleanText(target, MAX_PATH)
  else if (/^(bash|shell|command)$/i.test(tool)) question.command = cleanText(target, MAX_COMMAND)
  else if (/edit|write|read|patch|director|glob|grep|list/i.test(tool))
    question.path = cleanText(target, MAX_PATH)
  return question
}

/**
 * The answer a key typed into the harness's own dialog stands for, where the key alone says it
 * (Claude Code: 1 / 2 / 3; Codex: y / p·a / n; Escape is "no" everywhere). Enter picks whatever
 * option is highlighted: unknown.
 */
export function typedAnswer(harness: HarnessId, data: string): AnswerKey | undefined {
  if (data === '\x1b' || data === '\x1b\x1b' || data === '\x03') return 'no'
  const key = data.replace(/\r$/, '')
  if (harness === 'claude-code')
    return ({ '1': 'yes', '2': 'always', '3': 'no' } as const)[key as '1']
  if (harness === 'codex-cli')
    return ({ y: 'yes', Y: 'yes', p: 'always', a: 'always', n: 'no', N: 'no' } as const)[key as 'y']
  return undefined
}

// ---- the file -------------------------------------------------------------------------

function rotatedName(dir: string, index: number): string {
  return join(dir, `approvals.${index}.jsonl`)
}

/** Every file of the log, oldest first. */
export function approvalFiles(dir: string, keep = APPROVALS_KEEP): string[] {
  const files: string[] = []
  for (let index = keep; index >= 1; index--) {
    const file = rotatedName(dir, index)
    if (existsSync(file)) files.push(file)
  }
  const live = join(dir, APPROVALS_FILE)
  if (existsSync(live)) files.push(live)
  return files
}

/** All records, oldest first; a line that does not parse is skipped. */
export function readApprovals(dir: string, keep = APPROVALS_KEEP): ApprovalRecord[] {
  const records: ApprovalRecord[] = []
  for (const file of approvalFiles(dir, keep)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as ApprovalRecord
        if (record && typeof record === 'object' && record.v === 1) records.push(record)
      } catch {
        // a torn line
      }
    }
  }
  return records
}

export interface ApprovalLogOptions {
  /** The folder of the log (`NSQ_HOME/logs`). */
  dir: string
  /** Read on every write: the off switch (`nsq config set approvalsLog false`) applies at once. */
  enabled: () => boolean
  /** `~` for the home folder. */
  showPath: (path: string) => string
  now?: () => number
  maxBytes?: number
  keep?: number
  log?: (line: string) => void
}

interface Open {
  agent: ApprovalAgent
  askedAt: number
  question: ApprovalQuestion
  /** Keys typed into the agent's terminal while it waited (the first key that says an answer). */
  typed?: { answer?: AnswerKey; client: string }
  /** An interrupt someone sent while it waited. */
  interrupt?: ApprovalBy
  /** An answer sent through nsq, its keys going in: it counts once the agent moves on. */
  answer?: { key: AnswerKey; by: ApprovalBy }
}

/** How long a tool from a hook payload stays the subject of the next question. */
const STASH_MS = 120_000

export class ApprovalLog {
  private readonly open = new Map<string, Open>()
  private readonly quiets = new Map<
    string,
    { agent: ApprovalAgent; view: QuietView; text: string }
  >()
  private readonly stash = new Map<
    string,
    { at: number; question: Omit<ApprovalQuestion, 'text'> }
  >()
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly keep: number

  constructor(private readonly options: ApprovalLogOptions) {
    this.now = options.now ?? Date.now
    this.maxBytes = options.maxBytes ?? APPROVALS_MAX_BYTES
    this.keep = options.keep ?? APPROVALS_KEEP
  }

  get file(): string {
    return join(this.options.dir, APPROVALS_FILE)
  }

  /** A hook payload, before the status machine sees it: the tool of the question it announces. */
  hook(agentId: string, harness: HarnessId, event: string, body: string): void {
    try {
      const question = questionFromHook(harness, event, body)
      if (question) this.stash.set(agentId, { at: this.now(), question })
    } catch {
      // never in the way of a hook
    }
  }

  /** A published status change of the agent. */
  status(event: AgentHookEvent, agent: ApprovalAgent): void {
    const current = this.open.get(agent.id)
    if (event.kind === 'needs-input') {
      if (current && event.quiet) {
        // The same question, worded better (Claude Code: the PermissionRequest's detail).
        current.question = this.question(agent, event.detail, current.question)
        return
      }
      // A new question while one was open: that one ended without nsq seeing an answer.
      if (current) this.close(agent.id, 'cli')
      this.open.set(agent.id, {
        agent,
        askedAt: event.at,
        question: this.question(agent, event.detail)
      })
      return
    }
    this.stash.delete(agent.id)
    if (!current) return
    if (event.origin === 'reset') {
      this.close(agent.id, 'exited')
      return
    }
    if (current.answer) {
      this.close(agent.id, 'answered', { answer: current.answer.key, by: current.answer.by })
      return
    }
    if (current.interrupt) {
      this.close(agent.id, 'interrupted', { by: current.interrupt })
      return
    }
    if (event.origin === 'user') {
      // The person's keys in the agent's terminal moved it on (Escape: dismissed = no).
      const answer = event.kind === 'idle' ? ('no' as const) : current.typed?.answer
      this.close(agent.id, 'terminal', {
        ...(answer ? { answer } : {}),
        by: { via: 'terminal', from: 'local', client: current.typed?.client ?? 'terminal' }
      })
      return
    }
    this.close(agent.id, event.kind === 'working' ? 'cli' : 'ended')
  }

  /** A quiet episode started (the agent works, its screen has not changed for the threshold). */
  quietStarted(agent: ApprovalAgent, view: QuietView): void {
    const text = view.asking
      ? `quiet; looks like it's asking: ${view.asking}`
      : view.line
        ? `quiet; last line: ${view.line}`
        : 'quiet; no output'
    this.quiets.set(agent.id, { agent, view, text: cleanText(text, MAX_TEXT) })
  }

  /** The quiet episode ended (`by`: whose input ended it). */
  quietEnded(agentId: string, how: QuietEnd, by?: ApprovalBy): void {
    const open = this.quiets.get(agentId)
    if (!open) return
    this.quiets.delete(agentId)
    this.write({
      v: 1,
      kind: 'quiet',
      at: new Date(this.now()).toISOString(),
      askedAt: new Date(open.view.at).toISOString(),
      quietSince: new Date(open.view.since).toISOString(),
      agent: { id: open.agent.id, name: open.agent.name },
      harness: open.agent.harness,
      workspace: this.options.showPath(open.agent.workspace),
      question: { text: open.text },
      outcome: how,
      ...(by ? { by } : {})
    })
  }

  /** Answered through nsq (dashboard key, `nsq answer`, the phone), just before the keys go in. */
  answering(agentId: string, answer: AnswerKey, by: ApprovalBy): void {
    const current = this.open.get(agentId)
    if (current) current.answer = { key: answer, by }
  }

  /** The answer's keys could not be written: it did not reach the agent. */
  answerFailed(agentId: string): void {
    const current = this.open.get(agentId)
    if (current) delete current.answer
  }

  /** Keys typed into the agent's terminal while it may be waiting. */
  typed(agentId: string, harness: HarnessId, data: string, client: string): void {
    const current = this.open.get(agentId)
    if (!current) return
    // The first key that says an answer counts; Enter confirms it, a navigation key (an arrow)
    // moves away from it.
    const navigation = data.length > 1 && data.startsWith('\x1b[')
    const answer = navigation ? undefined : (current.typed?.answer ?? typedAnswer(harness, data))
    current.typed = { ...(answer ? { answer } : {}), client }
  }

  /** An interrupt sent to the agent (dashboard, `nsq interrupt`, the phone). */
  interrupting(agentId: string, by: ApprovalBy): void {
    const current = this.open.get(agentId)
    if (current) current.interrupt = by
  }

  /** The interrupt did not go out: whatever ends the question next is not it. */
  interruptFailed(agentId: string): void {
    const current = this.open.get(agentId)
    if (current) delete current.interrupt
  }

  /** The agent's process ended (stopped, restarted, crashed) or it was removed. */
  exited(agentId: string): void {
    this.stash.delete(agentId)
    if (this.open.has(agentId)) this.close(agentId, 'exited')
  }

  /** nsq is stopping: questions still open are written as unanswered. */
  closeAll(): void {
    for (const id of [...this.open.keys()]) this.close(id, 'unanswered')
    for (const id of [...this.quiets.keys()]) this.quietEnded(id, 'unanswered')
  }

  /** Open questions (tests). */
  pending(agentId: string): ApprovalQuestion | undefined {
    return this.open.get(agentId)?.question
  }

  private question(
    agent: ApprovalAgent,
    detail: string | undefined,
    before?: ApprovalQuestion
  ): ApprovalQuestion {
    const stash = this.stash.get(agent.id)
    const fresh = stash && this.now() - stash.at <= STASH_MS ? stash.question : undefined
    if (fresh) this.stash.delete(agent.id)
    const text = detail ? cleanText(detail, MAX_TEXT) : (before?.text ?? 'needs you')
    const parts =
      fresh ??
      (before && (before.tool || before.command || before.path || before.url)
        ? { tool: before.tool, command: before.command, path: before.path, url: before.url }
        : detail
          ? questionFromText(detail)
          : {})
    const question: ApprovalQuestion = { text }
    if (parts.tool) question.tool = parts.tool
    if (parts.command) question.command = parts.command
    if (parts.path) question.path = parts.path
    if (parts.url) question.url = parts.url
    return question
  }

  private close(
    agentId: string,
    outcome: ApprovalOutcome,
    extra: { answer?: AnswerKey; by?: ApprovalBy } = {}
  ): void {
    const current = this.open.get(agentId)
    if (!current) return
    this.open.delete(agentId)
    const { agent } = current
    const record: ApprovalRecord = {
      v: 1,
      at: new Date(this.now()).toISOString(),
      askedAt: new Date(current.askedAt).toISOString(),
      agent: { id: agent.id, name: agent.name },
      harness: agent.harness,
      workspace: this.options.showPath(agent.workspace),
      question: current.question,
      outcome,
      ...(extra.answer ? { answer: extra.answer } : {}),
      ...(extra.by ? { by: extra.by } : {})
    }
    this.write(record)
  }

  private write(record: ApprovalRecord): void {
    try {
      if (!this.options.enabled()) return
      const line = `${JSON.stringify(record)}\n`
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 })
      const file = this.file
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        // a new file
      }
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) this.rotate()
      const created = !existsSync(file)
      appendFileSync(file, line, { mode: 0o600 })
      if (created) {
        try {
          chmodSync(file, 0o600)
        } catch {
          // Windows: the profile's ACLs apply
        }
      }
    } catch (error) {
      this.options.log?.(`approvals log: could not write: ${String(error)}`)
    }
  }

  /** approvals.jsonl → .1, .1 → .2 …; the oldest beyond `keep` goes. */
  private rotate(): void {
    const dir = this.options.dir
    rmSync(rotatedName(dir, this.keep), { force: true })
    for (let index = this.keep - 1; index >= 1; index--) {
      const from = rotatedName(dir, index)
      if (existsSync(from)) renameSync(from, rotatedName(dir, index + 1))
    }
    renameSync(this.file, rotatedName(dir, 1))
  }
}
