import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  configureStatusHub,
  receiveHook,
  noteUserInput,
  statusLife,
  agentStatusSnapshot
} from './hub.js'
import { emitPtyData, emitPtyExit, emitPtySpawn } from '../pty/events.js'
import { startHookServer } from '../hooks/server.js'
import type { AgentHookEvent } from './types.js'
import type { HarnessId } from '../harnesses/types.js'

const harness = new Map<string, HarnessId>()
const dangerous = new Set<string>()
const events: AgentHookEvent[] = []
const traces: { agentId: string; line: string }[] = []
const sessions = new Map<string, string>()

// Transcripts are only read under a `projects` folder (claudeReconciler.ts `plausible`).
const transcriptRoot = mkdtempSync(join(tmpdir(), 'nsq-hub-'))
const transcriptDir = join(transcriptRoot, 'projects', 'p')
mkdirSync(transcriptDir, { recursive: true })
afterAll(() =>
  rmSync(transcriptRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
)

beforeAll(() => {
  configureStatusHub({
    harnessOf: (id) => harness.get(id),
    dangerousModeOf: (id) => dangerous.has(id),
    onSessionId: (id, session) => sessions.set(id, session),
    onStatus: (event) => events.push(event),
    trace: (agentId, line) => traces.push({ agentId, line })
  })
})

let n = 0
function agent(kind: HarnessId): string {
  n += 1
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  harness.set(id, kind)
  emitPtySpawn(id, 1, { harness: kind, cols: 80, rows: 24 })
  return id
}
const kinds = (id: string): string[] => events.filter((e) => e.agentId === id).map((e) => e.kind)
const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits for real I/O (a transcript read) while the hub's timers are fake: yields to the event
 * loop until `done()` holds. No limit of its own — a stalled read hits the test's timeout.
 */
async function untilIo(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setImmediate(resolve))
}

describe('status hub', () => {
  it('Claude Code: prompt → permission question with its text → answer → finished', async () => {
    const id = agent('claude-code')
    receiveHook(id, 'UserPromptSubmit', '{}')
    expect(
      receiveHook(
        id,
        'ClaudePermission',
        JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
      )
    ).toBe('{}')
    receiveHook(
      id,
      'Notification',
      JSON.stringify({
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission'
      })
    )
    expect(agentStatusSnapshot(id)).toMatchObject({
      kind: 'needs-input',
      detail: 'Claude wants to run: npm test'
    })
    noteUserInput(id, '1')
    expect(agentStatusSnapshot(id)?.kind).toBe('working')
    receiveHook(id, 'Stop', '{}')
    await tick()
    expect(kinds(id)).toEqual(['working', 'needs-input', 'working', 'finished'])
  })

  it('Claude Code: dangerous mode answers PermissionRequest with allow and raises no question', () => {
    const id = agent('claude-code')
    dangerous.add(id)
    receiveHook(id, 'UserPromptSubmit', '{}')
    const reply = JSON.parse(
      receiveHook(id, 'ClaudePermission', JSON.stringify({ tool_name: 'Bash' }))
    )
    expect(reply.hookSpecificOutput.decision.behavior).toBe('allow')
    receiveHook(id, 'Notification', JSON.stringify({ notification_type: 'permission_prompt' }))
    expect(kinds(id)).toEqual(['working'])
  })

  it('Codex: session id adopted, approval detail, Stop', () => {
    const id = agent('codex-cli')
    const session = '0199a213-81c0-7800-8aa1-bbab2a035a53'
    receiveHook(
      id,
      'Codex',
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session })
    )
    receiveHook(
      id,
      'Codex',
      JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf dist' }
      })
    )
    expect(agentStatusSnapshot(id)).toMatchObject({
      kind: 'needs-input',
      detail: 'Bash — rm -rf dist'
    })
    receiveHook(id, 'Codex', JSON.stringify({ hook_event_name: 'Stop', session_id: session }))
    expect(sessions.get(id)).toBe(session)
    expect(kinds(id)).toEqual(['working', 'needs-input', 'finished'])
  })

  it('Codex: a failed turn line ends an open turn', () => {
    const id = agent('codex-cli')
    receiveHook(id, 'Codex', JSON.stringify({ hook_event_name: 'UserPromptSubmit' }))
    emitPtyData(id, 1, '\x1b[31m■ stream error: exceeded retry limit\x1b[0m')
    expect(kinds(id)).toEqual(['working', 'finished'])
  })

  it('OpenCode: plugin reports', () => {
    const id = agent('opencode')
    receiveHook(id, 'OpenCode', JSON.stringify({ event: 'working', sessionID: 'ses_abcdefgh1234' }))
    receiveHook(
      id,
      'OpenCode',
      JSON.stringify({ event: 'needs-input', detail: 'OpenCode needs your permission: bash — ls' })
    )
    receiveHook(id, 'OpenCode', JSON.stringify({ event: 'answered' }))
    receiveHook(
      id,
      'OpenCode',
      JSON.stringify({ event: 'finished', sessionID: 'ses_abcdefgh1234' })
    )
    expect(kinds(id)).toEqual(['working', 'needs-input', 'working', 'finished'])
    expect(sessions.get(id)).toBe('ses_abcdefgh1234')
  })

  it('Claude Code: a held Stop decided after the next prompt was submitted does not end that turn', async () => {
    // The race the live e2e hit: turn 1's Stop arrives while the transcript still shows the
    // turn running, so it is held; the transcript then ends turn 1 (finished), a prompt is typed
    // at once (UserPromptSubmit fires before Claude writes it), and the held Stop comes due.
    // The hub's timers (transcript poll, Stop hold) and clock are fake and advanced step by step;
    // only the transcript reads are real I/O, each awaited until its effect shows.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const id = agent('claude-code')
      const file = join(transcriptDir, `${id}.jsonl`)
      writeFileSync(file, '')
      const line = (entry: Record<string, unknown>): void =>
        appendFileSync(
          file,
          `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`
        )
      const hook = (event: string): string =>
        receiveHook(id, event, JSON.stringify({ transcript_path: file }))
      const traced = (text: string): number =>
        traces.filter((t) => t.agentId === id && t.line.startsWith(text)).length
      hook('UserPromptSubmit') // arms the transcript poll: due in 1 s
      line({ type: 'user', message: { content: 'turn one' } })
      await vi.advanceTimersByTimeAsync(600)
      const timersBefore = vi.getTimerCount()
      hook('Stop') // the transcript shows turn 1 busy: held for 1.5 s
      await untilIo(() => vi.getTimerCount() > timersBefore) // read done, hold armed
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }
      })
      line({ type: 'system', subtype: 'turn_duration' })
      // The transcript poll (due at 1 s) ends turn 1, long before the hold (≈2.1 s).
      await vi.advanceTimersByTimeAsync(450)
      await untilIo(() => agentStatusSnapshot(id)?.kind === 'finished')
      const own = events.filter((e) => e.agentId === id)
      expect(own.map((e) => e.kind)).toEqual(['working', 'finished'])
      expect(own[1]?.origin).toBe('transcript')
      hook('UserPromptSubmit') // turn 2, typed the instant turn 1 showed finished
      await vi.advanceTimersByTimeAsync(1100) // the held Stop comes due
      await untilIo(() => traced('Stop (held)') > 0)
      expect(agentStatusSnapshot(id)?.kind).toBe('working')
      expect(kinds(id)).toEqual(['working', 'finished', 'working'])
      // Turn 2's own Stop still ends it.
      line({ type: 'user', message: { content: 'turn two' } })
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }
      })
      hook('Stop')
      await untilIo(() => traced('Stop →') > 0)
      expect(kinds(id)).toEqual(['working', 'finished', 'working', 'finished'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops hooks sent by a previous process', () => {
    const id = agent('opencode')
    const life = statusLife(id)
    emitPtyExit(id, 1)
    emitPtySpawn(id, 2, { cols: 80, rows: 24 })
    receiveHook(id, 'OpenCode', JSON.stringify({ event: 'working' }), life)
    expect(kinds(id)).toEqual([])
  })

  it('generic command: output → working, quiet → finished', async () => {
    const id = agent('command')
    emitPtyData(id, 1, 'building…')
    expect(agentStatusSnapshot(id)?.kind).toBe('working')
    await tick(2700)
    expect(agentStatusSnapshot(id)?.kind).toBe('finished')
  })
})

describe('hook server', () => {
  it('accepts only the agent token, on loopback', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const seen: string[] = []
    const server = await startHookServer({
      knows: (agentId) => agentId === id,
      arrive: () => 7,
      handle: (agentId, event, body, life) => {
        seen.push(`${agentId}:${event}:${body}:${life}`)
        return '{"ok":true}'
      }
    })
    try {
      const base = server.baseFor(id)
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]{64}\//)
      const ok = await fetch(`${base}/Stop`, { method: 'POST', body: '{"a":1}' })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ ok: true })
      const forged = base.replace(/\/hook\/[0-9a-f]+\//, `/hook/${'0'.repeat(64)}/`)
      expect((await fetch(`${forged}/Stop`, { method: 'POST', body: '{}' })).status).toBe(404)
      expect(seen).toEqual([`${id}:Stop:{"a":1}:7`])
    } finally {
      await server.close()
    }
  })
})
