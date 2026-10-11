import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookEvent } from '@neurosquad/core'
import {
  ApprovalLog,
  approvalFiles,
  questionFromHook,
  questionFromText,
  readApprovals,
  redactSecrets,
  typedAnswer,
  type ApprovalAgent,
  type ApprovalRecord
} from './approvals.js'
import {
  answerLabel,
  byLabel,
  filterApprovals,
  formatApprovals,
  questionLabel
} from '../approvalsCommand.js'

const AGENT: ApprovalAgent = {
  id: '0f6c2a52-1111-4222-8333-944445555666',
  name: 'claude',
  harness: 'claude-code',
  workspace: '/home/me/demo-shop'
}

let dir = ''
let clock = 1_700_000_000_000
let enabled = true
let log: ApprovalLog

const ev = (kind: AgentHookEvent['kind'], extra: Partial<AgentHookEvent> = {}): AgentHookEvent => ({
  agentId: AGENT.id,
  kind,
  at: clock,
  ...extra
})
const records = (): ApprovalRecord[] => readApprovals(dir)
const PERMISSION = JSON.stringify({
  tool_name: 'Bash',
  tool_input: {
    command:
      'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com?token=s3cr3tvalue && npm test',
    description: 'run it'
  },
  transcript_path: '/home/me/.claude/x.jsonl',
  session_id: 'abc'
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nsq-approvals-'))
  enabled = true
  clock = 1_700_000_000_000
  log = new ApprovalLog({
    dir,
    enabled: () => enabled,
    showPath: (path) => path.replace('/home/me', '~'),
    now: () => clock
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the record', () => {
  it('a question answered from the dashboard: who, what, the tool and command, no secrets', () => {
    log.hook(AGENT.id, 'claude-code', 'ClaudePermission', PERMISSION)
    log.status(ev('needs-input', { detail: 'Claude wants to run: curl …' }), AGENT)
    clock += 4000
    log.answered(AGENT.id, 'yes', { via: 'dashboard', from: 'local' })
    const [record] = records()
    expect(record).toEqual({
      v: 1,
      at: new Date(clock).toISOString(),
      askedAt: new Date(clock - 4000).toISOString(),
      agent: { id: AGENT.id, name: 'claude' },
      harness: 'claude-code',
      workspace: '~/demo-shop',
      question: {
        text: 'Claude wants to run: curl …',
        tool: 'Bash',
        command: 'curl -H "Authorization: *** ***" https://api.example.com?token=*** && npm test'
      },
      outcome: 'answered',
      answer: 'yes',
      by: { via: 'dashboard', from: 'local' }
    })
    const raw = readFileSync(join(dir, 'approvals.jsonl'), 'utf8')
    expect(raw).not.toContain('abcdefghijklmnop')
    expect(raw).not.toContain('s3cr3tvalue')
    // Only the question: not the payload's other fields (transcript, session, description).
    expect(raw).not.toContain('transcript')
    expect(raw).not.toContain('session')
    expect(raw).not.toContain('run it')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('a phone answer carries its origin and device', () => {
    log.status(ev('needs-input', { detail: 'Codex: Bash — rm -rf dist' }), AGENT)
    log.answered(AGENT.id, 'always', { via: 'phone', from: 'internet', device: 'iPhone · Safari' })
    expect(records()[0]).toMatchObject({
      outcome: 'answered',
      answer: 'always',
      by: { via: 'phone', from: 'internet', device: 'iPhone · Safari' }
    })
  })

  it('keys typed into the agent terminal: the answer the key stands for', () => {
    log.status(ev('needs-input', { detail: 'Claude wants to edit src/a.ts' }), AGENT)
    log.typed(AGENT.id, 'claude-code', '3', 'attach')
    log.status(ev('working', { origin: 'user' }), AGENT)
    expect(records()[0]).toMatchObject({
      outcome: 'terminal',
      answer: 'no',
      by: { via: 'terminal', from: 'local', client: 'attach' }
    })
    // Escape: dismissed (no) — the status goes idle.
    log.status(ev('needs-input', { detail: 'again' }), AGENT)
    log.typed(AGENT.id, 'claude-code', '\x1b', 'dashboard')
    log.status(ev('idle', { origin: 'user' }), AGENT)
    expect(records()[1]).toMatchObject({ outcome: 'terminal', answer: 'no' })
    // Enter picks the highlighted option: the answer is not known.
    log.status(ev('needs-input', { detail: 'third' }), AGENT)
    log.typed(AGENT.id, 'claude-code', '\r', 'dashboard')
    log.status(ev('working', { origin: 'user' }), AGENT)
    expect(records()[2]!.answer).toBeUndefined()
    expect(records()[2]!.outcome).toBe('terminal')
  })

  it('the CLI went on by itself, the turn ended, an interrupt, an exit, nsq stopping', () => {
    log.status(ev('needs-input', { detail: 'a' }), AGENT)
    log.status(ev('working'), AGENT)
    log.status(ev('needs-input', { detail: 'b' }), AGENT)
    log.status(ev('finished'), AGENT)
    log.status(ev('needs-input', { detail: 'c' }), AGENT)
    log.interrupting(AGENT.id, { via: 'cli', from: 'local' })
    log.status(ev('idle', { origin: 'user' }), AGENT)
    log.status(ev('needs-input', { detail: 'd' }), AGENT)
    log.exited(AGENT.id)
    log.status(ev('needs-input', { detail: 'e' }), AGENT)
    log.closeAll()
    expect(records().map((r) => [r.question.text, r.outcome, r.by?.via])).toEqual([
      ['a', 'cli', undefined],
      ['b', 'ended', undefined],
      ['c', 'interrupted', 'cli'],
      ['d', 'exited', undefined],
      ['e', 'unanswered', undefined]
    ])
  })

  it('a better wording of the same question updates it; nothing is logged twice', () => {
    log.status(ev('needs-input', { detail: 'Claude needs your permission' }), AGENT)
    log.hook(AGENT.id, 'claude-code', 'ClaudePermission', PERMISSION)
    log.status(ev('needs-input', { detail: 'Claude wants to run: npm test', quiet: true }), AGENT)
    log.answered(AGENT.id, 'yes', { via: 'cli', from: 'local' })
    // The person's answer moves it on as their input: no second record.
    log.status(ev('working', { origin: 'user' }), AGENT)
    log.answered(AGENT.id, 'no', { via: 'cli', from: 'local' })
    expect(records()).toHaveLength(1)
    expect(records()[0]!.question).toMatchObject({
      text: 'Claude wants to run: npm test',
      tool: 'Bash'
    })
  })

  it('an auto-approved request (dangerous mode) is not a question and is not carried over', () => {
    log.hook(AGENT.id, 'claude-code', 'ClaudePermission', PERMISSION)
    log.status(ev('finished'), AGENT)
    log.status(ev('needs-input', { detail: 'Claude is asking: which one?' }), AGENT)
    log.answered(AGENT.id, 'yes', { via: 'cli', from: 'local' })
    expect(records()[0]!.question).toEqual({ text: 'Claude is asking: which one?' })
  })

  it('the off switch writes nothing', () => {
    enabled = false
    log.status(ev('needs-input', { detail: 'x' }), AGENT)
    log.answered(AGENT.id, 'yes', { via: 'cli', from: 'local' })
    expect(existsSync(join(dir, 'approvals.jsonl'))).toBe(false)
  })

  it('long text and commands are cut', () => {
    log.hook(
      AGENT.id,
      'claude-code',
      'ClaudePermission',
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: `echo ${'x'.repeat(5000)}` } })
    )
    log.status(ev('needs-input', { detail: 'y'.repeat(5000) }), AGENT)
    log.closeAll()
    const [record] = records()
    expect(record!.question.text.length).toBeLessThanOrEqual(300)
    expect(record!.question.command!.length).toBeLessThanOrEqual(500)
    expect(record!.question.command!.endsWith('…')).toBe(true)
  })
})

describe('rotation', () => {
  it('rotates past the size limit and keeps a few files', () => {
    const small = new ApprovalLog({
      dir,
      enabled: () => true,
      showPath: (path) => path,
      now: () => clock,
      maxBytes: 2000,
      keep: 2
    })
    for (let i = 0; i < 60; i++) {
      small.status(ev('needs-input', { detail: `question ${i} ${'z'.repeat(200)}` }), AGENT)
      small.answered(AGENT.id, 'yes', { via: 'cli', from: 'local' })
    }
    const files = approvalFiles(dir, 2)
    expect(files.map((file) => file.slice(dir.length + 1))).toEqual([
      'approvals.2.jsonl',
      'approvals.1.jsonl',
      'approvals.jsonl'
    ])
    for (const file of files) expect(statSync(file).size).toBeLessThanOrEqual(2000)
    const kept = readApprovals(dir, 2)
    // Oldest first, the newest last; the oldest beyond the kept files are gone.
    expect(kept.at(-1)!.question.text).toContain('question 59')
    expect(kept.length).toBeLessThan(60)
    const numbers = kept.map((r) => Number(/question (\d+)/.exec(r.question.text)![1]))
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
  })
})

describe('parsing', () => {
  it('Codex: a PermissionRequest and request_user_input; other hooks ask nothing', () => {
    expect(
      questionFromHook(
        'codex-cli',
        'Codex',
        JSON.stringify({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv; make' }
        })
      )
    ).toEqual({ tool: 'Bash', command: 'export OPENAI_API_KEY=*** make' })
    expect(
      questionFromHook(
        'codex-cli',
        'Codex',
        JSON.stringify({
          hook_event_name: 'PermissionRequest',
          tool_name: 'apply_patch',
          tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y' }
        })
      )
    ).toEqual({ tool: 'apply_patch', path: 'src/a.ts' })
    expect(
      questionFromHook('codex-cli', 'Codex', JSON.stringify({ hook_event_name: 'Stop' }))
    ).toBeNull()
    expect(questionFromHook('claude-code', 'Notification', '{}')).toBeNull()
    expect(questionFromHook('claude-code', 'ClaudePermission', 'not json')).toBeNull()
    expect(
      questionFromHook(
        'claude-code',
        'ClaudePermission',
        JSON.stringify({
          tool_name: 'WebFetch',
          tool_input: { url: 'https://x.dev/a?api_key=zzz' }
        })
      )
    ).toEqual({ tool: 'WebFetch', url: 'https://x.dev/a?api_key=***' })
  })

  it('OpenCode: the tool from its wording', () => {
    expect(questionFromText('OpenCode needs your permission: bash — rm -rf dist')).toEqual({
      tool: 'bash',
      command: 'rm -rf dist'
    })
    expect(questionFromText('OpenCode needs your permission: edit — src/app.ts')).toEqual({
      tool: 'edit',
      path: 'src/app.ts'
    })
    expect(questionFromText('OpenCode needs your permission: webfetch — https://a.dev')).toEqual({
      tool: 'webfetch',
      url: 'https://a.dev'
    })
    expect(questionFromText('OpenCode is asking: which db?')).toEqual({})
  })

  it('masks secrets and leaves ordinary commands alone', () => {
    expect(redactSecrets('npm test -- --grep auth')).toBe('npm test -- --grep auth')
    expect(redactSecrets('git log --author=me AUTHOR=x')).toBe('git log --author=me AUTHOR=x')
    expect(redactSecrets('git push https://me:ghp_abcdefghijklmnop@github.com/x')).toBe(
      'git push https://me:***@github.com/x'
    )
    expect(redactSecrets('tool --api-key abc123 --token=xyz')).toBe(
      'tool --api-key *** --token=***'
    )
    expect(redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstu gh pr list')).toBe(
      'GITHUB_TOKEN=*** gh pr list'
    )
    expect(redactSecrets('echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('echo sk-ant-***')
    expect(redactSecrets('use glpat-abcdefghijklmnop')).toBe('use glpat-***')
    expect(redactSecrets('curl -H "x-api-key: abcdef123456"')).toBe('curl -H "x-api-key: ***"')
    expect(redactSecrets('psql postgres://app:hunter2@db/x')).toBe('psql postgres://app:***@db/x')
  })

  it('typed keys per harness', () => {
    expect(typedAnswer('claude-code', '1')).toBe('yes')
    expect(typedAnswer('claude-code', '2')).toBe('always')
    expect(typedAnswer('codex-cli', 'p')).toBe('always')
    expect(typedAnswer('codex-cli', 'n')).toBe('no')
    expect(typedAnswer('opencode', '\x1b')).toBe('no')
    expect(typedAnswer('opencode', '\r')).toBeUndefined()
  })
})

describe('nsq log approvals', () => {
  const record = (over: Partial<ApprovalRecord>): ApprovalRecord => ({
    v: 1,
    at: '2026-10-11T10:00:00.000Z',
    askedAt: '2026-10-11T09:59:58.000Z',
    agent: { id: AGENT.id, name: 'claude' },
    harness: 'claude-code',
    workspace: '~/demo-shop',
    question: { text: 'Claude wants to run: npm test', tool: 'Bash', command: 'npm test' },
    outcome: 'answered',
    answer: 'yes',
    by: { via: 'phone', from: 'lan', device: 'iPhone · Safari' },
    ...over
  })

  it('labels', () => {
    expect(byLabel({ via: 'phone', from: 'lan', device: 'iPhone · Safari' }, 'answered')).toBe(
      'phone (LAN, iPhone · Safari)'
    )
    expect(byLabel({ via: 'cli', from: 'local' }, 'answered')).toBe('nsq answer')
    expect(byLabel({ via: 'cli', from: 'local' }, 'interrupted')).toBe('nsq interrupt')
    expect(byLabel({ via: 'terminal', from: 'local', client: 'attach' }, 'terminal')).toBe(
      'terminal (attach)'
    )
    expect(byLabel(undefined, 'cli')).toBe('—')
    expect(answerLabel(record({ answer: undefined, outcome: 'ended' }))).toBe('turn ended')
    expect(questionLabel(record({}))).toBe('Bash: npm test')
    expect(questionLabel(record({ question: { text: 'Claude is asking: which?' } }))).toBe(
      'Claude is asking: which?'
    )
  })

  it('filters by agent and time, prints a table', () => {
    const all = [
      record({}),
      record({ agent: { id: 'aaaa-1', name: 'codex' }, harness: 'codex-cli' }),
      record({ at: '2026-10-01T10:00:00.000Z' })
    ]
    expect(filterApprovals(all, { agent: 'CODEX' })).toHaveLength(1)
    expect(filterApprovals(all, { agent: 'aaaa' })).toHaveLength(1)
    expect(filterApprovals(all, { since: Date.parse('2026-10-10T00:00:00Z') })).toHaveLength(2)
    const lines = formatApprovals(all.slice(0, 1), 100)
    expect(lines[0]).toMatch(/^TIME\s+AGENT\s+HARNESS\s+ANSWER\s+BY\s+QUESTION$/)
    expect(lines[1]).toContain('Claude Code')
    expect(lines[1]).toContain('phone (LAN, iPhone · Safari)')
    expect(lines[1]).toContain('Bash: npm test')
  })
})
