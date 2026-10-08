// Parsers and de-duplication, on small hand-written logs in a temp folder —
// shaped exactly like the real files these harnesses write.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UsageRecord } from '../types.js'
import { requestSpan, requestTools } from '../types.js'
import { JsonlSource } from '../jsonlSource.js'
import { claudeCodeFormat } from '../sources/claudeCode.js'
import { codexFormat } from '../sources/codex.js'
import { OpenCodeSource, parseOpenCodeRow } from '../sources/opencode.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-usage-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

interface ClaudeUsageFixture {
  in?: number
  out?: number
  cr?: number
  cw?: number
  h1?: number
  think?: number
  iterations?: unknown[]
}

function claudeLine(
  id: string,
  timestamp: string,
  usage: ClaudeUsageFixture,
  extra: Record<string, unknown> = {}
): string {
  return line({
    type: 'assistant',
    timestamp,
    sessionId: 's1',
    cwd: 'E:\\w1',
    message: {
      id,
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: usage.in ?? 0,
        output_tokens: usage.out ?? 0,
        cache_read_input_tokens: usage.cr ?? 0,
        cache_creation_input_tokens: usage.cw ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: (usage.cw ?? 0) - (usage.h1 ?? 0),
          ephemeral_1h_input_tokens: usage.h1 ?? 0
        },
        output_tokens_details: { thinking_tokens: usage.think ?? 0 },
        server_tool_use: { web_search_requests: 0 },
        speed: 'standard',
        service_tier: 'standard',
        inference_geo: 'not_available',
        ...(usage.iterations ? { iterations: usage.iterations } : {})
      }
    },
    ...extra
  })
}

const byId = (records: readonly UsageRecord[]): Map<string, UsageRecord> =>
  new Map(records.map((record) => [record.id, record]))

describe('Claude Code', () => {
  it('counts each message once, at its final (largest) usage, across lines, files and sub-agents', async () => {
    const project = join(dir, 'E--w1')
    mkdirSync(join(project, 's1', 'subagents'), { recursive: true })
    writeFileSync(
      join(project, 's1.jsonl'),
      // m1's first block: output still streaming (5).
      claudeLine('m1', '2026-09-10T10:00:00.000Z', { in: 3, cr: 100, cw: 50, h1: 30, out: 5 }) +
        line({ type: 'user', timestamp: '2026-09-10T10:00:00.500Z', message: { content: 'x' } }) +
        claudeLine('m2', '2026-09-10T10:00:01.000Z', { in: 1, out: 7 }) +
        // m1's last block — NOT adjacent to its first: final output 42, 10 of it thinking.
        claudeLine('m1', '2026-09-10T10:00:02.000Z', {
          in: 3,
          cr: 100,
          cw: 50,
          h1: 30,
          out: 42,
          think: 10
        }) +
        // A synthetic error message: no tokens, not a request.
        line({
          type: 'assistant',
          timestamp: '2026-09-10T10:00:03.000Z',
          sessionId: 's1',
          message: {
            id: 'm3',
            model: '<synthetic>',
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0
            }
          }
        })
    )
    // A fork of s1: a copy of m1 with its top-level usage zeroed (real ones in
    // `iterations`), and one message of its own.
    writeFileSync(
      join(project, 's2.jsonl'),
      claudeLine(
        'm1',
        '2026-09-10T10:00:00.000Z',
        {
          iterations: [
            {
              input_tokens: 3,
              output_tokens: 42,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 50,
              cache_creation: { ephemeral_1h_input_tokens: 30 }
            }
          ]
        },
        { sessionId: 's2' }
      ) + claudeLine('m4', '2026-09-10T11:00:00.000Z', { in: 9, out: 1 }, { sessionId: 's2' })
    )
    // A sub-agent of s1: its lines name the parent session.
    writeFileSync(
      join(project, 's1', 'subagents', 'agent-a1.jsonl'),
      claudeLine('m5', '2026-09-10T10:30:00.000Z', { in: 2, out: 3 }, { isSidechain: true })
    )

    const source = new JsonlSource(claudeCodeFormat(() => dir))
    expect(await source.scan()).toBe(true)
    const records = byId(source.records())
    expect([...records.keys()].sort()).toEqual([
      'claude-code:m1',
      'claude-code:m2',
      'claude-code:m4',
      'claude-code:m5'
    ])
    const m1 = records.get('claude-code:m1')!
    expect(m1).toMatchObject({
      input: 3,
      output: 42,
      cacheRead: 100,
      cacheWrite: 50,
      cacheWrite1h: 30,
      reasoning: 10,
      sessionId: 's1',
      at: Date.parse('2026-09-10T10:00:00.000Z'),
      cwd: 'E:\\w1'
    })
    expect(records.get('claude-code:m4')).toMatchObject({ sessionId: 's2', input: 9, output: 1 })
    expect(records.get('claude-code:m5')).toMatchObject({ sessionId: 's1', input: 2, output: 3 })
    const sum = source.records().reduce((total, record) => total + record.output, 0)
    expect(sum).toBe(42 + 7 + 1 + 3)
    // Nothing new: a second scan changes nothing.
    expect(await source.scan()).toBe(false)
  })

  it('never loses or double-counts a line cut in half by a scan', async () => {
    mkdirSync(join(dir, 'p'))
    const path = join(dir, 'p', 's1.jsonl')
    const second = claudeLine('m2', '2026-09-10T10:00:01.000Z', { in: 1, out: 7 })
    writeFileSync(
      path,
      claudeLine('m1', '2026-09-10T10:00:00.000Z', { in: 3, out: 5 }) + second.slice(0, 40)
    )
    const source = new JsonlSource(claudeCodeFormat(() => dir))
    await source.scan()
    expect(source.records().map((record) => record.id)).toEqual(['claude-code:m1'])
    appendFileSync(path, second.slice(40))
    await source.scan()
    expect(source.records().map((record) => record.id)).toEqual([
      'claude-code:m1',
      'claude-code:m2'
    ])
    // …and m1's later block arriving in a later scan still updates it.
    appendFileSync(path, claudeLine('m1', '2026-09-10T10:00:00.900Z', { in: 3, out: 50 }))
    await source.scan()
    expect(byId(source.records()).get('claude-code:m1')?.output).toBe(50)
  })

  it('keeps multi-byte text intact across chunk boundaries', async () => {
    mkdirSync(join(dir, 'p'))
    const path = join(dir, 'p', 's1.jsonl')
    // A user line full of 3-byte characters, long enough to straddle a 2 MB chunk.
    const filler = line({ type: 'user', text: '\u0416'.repeat(800_000) })
    writeFileSync(path, filler + claudeLine('m1', '2026-09-10T10:00:00.000Z', { in: 3, out: 5 }))
    const source = new JsonlSource(claudeCodeFormat(() => dir))
    await source.scan()
    expect(source.records()).toHaveLength(1)
  })

  it('forgets a replaced file and survives a cache round trip', async () => {
    mkdirSync(join(dir, 'p'))
    const path = join(dir, 'p', 's1.jsonl')
    writeFileSync(
      path,
      claudeLine('m1', '2026-09-10T10:00:00.000Z', { in: 3, out: 5 }) +
        claudeLine('m2', '2026-09-10T10:00:01.000Z', { in: 1, out: 7 })
    )
    const source = new JsonlSource(claudeCodeFormat(() => dir))
    await source.scan()
    const restored = new JsonlSource(claudeCodeFormat(() => dir))
    restored.importState(JSON.parse(JSON.stringify(source.exportState())))
    expect(restored.records()).toEqual(source.records())
    // Appending after a restore reads only the new line.
    appendFileSync(path, claudeLine('m9', '2026-09-10T12:00:00.000Z', { in: 4, out: 4 }))
    await restored.scan()
    expect(restored.records()).toHaveLength(3)
    // Truncated and rewritten: what came from the old content is dropped.
    writeFileSync(path, claudeLine('mX', '2026-09-11T10:00:00.000Z', { in: 1, out: 1 }))
    await restored.scan()
    expect(restored.records().map((record) => record.id)).toEqual(['claude-code:mX'])
  })

  it('a request spans from the input before it to its last line, with its tool_use names', async () => {
    const project = join(dir, 'E--w1')
    mkdirSync(project, { recursive: true })
    const path = join(project, 's1.jsonl')
    const toolUse = (id: string, name: string): Record<string, unknown> => ({
      type: 'tool_use',
      id,
      name,
      input: {}
    })
    const assistant = (id: string, timestamp: string, out: number, content: unknown[]): string => {
      const parsed = JSON.parse(claudeLine(id, timestamp, { in: 3, out })) as {
        message: Record<string, unknown>
      }
      parsed.message.content = content
      return line(parsed)
    }
    writeFileSync(
      path,
      line({ type: 'user', timestamp: '2026-09-10T10:00:00.000Z', message: { content: 'go' } }) +
        assistant('m1', '2026-09-10T10:00:02.000Z', 5, [{ type: 'text', text: 'Reading.' }]) +
        assistant('m1', '2026-09-10T10:00:03.000Z', 9, [toolUse('toolu_01AAA', 'Read')])
    )
    const source = new JsonlSource(claudeCodeFormat(() => dir))
    await source.scan()
    // The rest of m1 arrives in a later scan, after a tool result already landed
    // between its blocks — the start stays the prompt's time (kept in the file's meta).
    appendFileSync(
      path,
      line({
        type: 'user',
        timestamp: '2026-09-10T10:00:03.500Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01AAA' }] }
      }) +
        assistant('m1', '2026-09-10T10:00:04.000Z', 20, [toolUse('toolu_01BBB', 'Grep')]) +
        line({
          type: 'user',
          timestamp: '2026-09-10T10:00:05.000Z',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01BBB' }] }
        }) +
        assistant('m2', '2026-09-10T10:00:07.000Z', 4, [{ type: 'text', text: 'Done.' }])
    )
    await source.scan()
    // A fork repeats m1 (same blocks): its calls are not counted twice.
    writeFileSync(
      join(project, 's2.jsonl'),
      line({ type: 'user', timestamp: '2026-09-10T10:00:00.000Z', message: { content: 'go' } }) +
        assistant('m1', '2026-09-10T10:00:03.000Z', 9, [toolUse('toolu_01AAA', 'Read')]) +
        assistant('m1', '2026-09-10T10:00:04.000Z', 20, [toolUse('toolu_01BBB', 'Grep')])
    )
    await source.scan()
    const records = byId(source.records())
    expect(records.get('claude-code:m1')).toMatchObject({
      at: Date.parse('2026-09-10T10:00:02.000Z'),
      startedAt: Date.parse('2026-09-10T10:00:00.000Z'),
      endedAt: Date.parse('2026-09-10T10:00:04.000Z'),
      tools: ['Read', 'Grep'],
      output: 20
    })
    expect(records.get('claude-code:m2')).toMatchObject({
      startedAt: Date.parse('2026-09-10T10:00:05.000Z'),
      endedAt: Date.parse('2026-09-10T10:00:07.000Z')
    })
    expect(records.get('claude-code:m2')!.tools).toBeUndefined()
    // The span and the tools survive the cache.
    const restored = new JsonlSource(claudeCodeFormat(() => dir))
    restored.importState(JSON.parse(JSON.stringify(source.exportState())))
    expect(restored.records()).toEqual(source.records())
  })

  it('drops a start more than 30 minutes before the response, and one with no input before it', async () => {
    mkdirSync(join(dir, 'p'))
    writeFileSync(
      join(dir, 'p', 's1.jsonl'),
      claudeLine('m0', '2026-09-10T09:00:00.000Z', { in: 1, out: 1 }) +
        line({ type: 'user', timestamp: '2026-09-10T09:00:01.000Z', message: { content: 'x' } }) +
        claudeLine('m1', '2026-09-10T10:00:00.000Z', { in: 1, out: 1 })
    )
    const source = new JsonlSource(claudeCodeFormat(() => dir))
    await source.scan()
    const records = byId(source.records())
    expect(records.get('claude-code:m0')!.startedAt).toBeUndefined()
    expect(records.get('claude-code:m1')!.startedAt).toBeUndefined()
    expect(records.get('claude-code:m1')!.endedAt).toBe(Date.parse('2026-09-10T10:00:00.000Z'))
  })
})

describe('Codex', () => {
  const meta = (id: string): string =>
    line({
      timestamp: '2026-09-16T07:11:21.893Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id, cwd: 'C:\\w1', model_provider: 'openai' }
    })
  const context = (model: string, ordinal: number): string =>
    line({
      timestamp: '2026-09-16T07:11:23.000Z',
      ordinal,
      type: 'turn_context',
      payload: { model }
    })
  const tokenCount = (ordinal: number, total: object, last: object): string =>
    line({
      timestamp: '2026-09-16T07:11:26.848Z',
      ordinal,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } }
    })

  it('counts token_usage_record per response and ignores the repeated token_count events', async () => {
    const day = join(dir, 'sessions', '2026', '09', '16')
    mkdirSync(day, { recursive: true })
    const u1 = {
      input_tokens: 15576,
      cached_input_tokens: 9984,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0
    }
    const u2 = {
      input_tokens: 20000,
      cached_input_tokens: 15000,
      cache_write_input_tokens: 1000,
      output_tokens: 300,
      reasoning_output_tokens: 200
    }
    writeFileSync(
      join(day, 'rollout-2026-09-16T10-10-59-01a0a90d-f6c5-7da2-b0ef-239cdd262e82.jsonl'),
      meta('sess-1') +
        context('gpt-5.6-terra', 1) +
        line({
          timestamp: '2026-09-16T07:11:26.847Z',
          ordinal: 2,
          type: 'token_usage_record',
          payload: { response_id: 'resp1', usage: u1 }
        }) +
        tokenCount(3, u1, u1) +
        tokenCount(4, u1, u1) +
        context('gpt-5.6-sol', 5) +
        line({
          timestamp: '2026-09-16T07:12:00.000Z',
          ordinal: 6,
          type: 'token_usage_record',
          payload: { response_id: 'resp2', usage: u2 }
        })
    )
    const source = new JsonlSource(codexFormat(() => dir))
    await source.scan()
    const records = byId(source.records())
    expect(records.size).toBe(2)
    // Cached tokens are inside OpenAI's input_tokens: 15576 − 9984 = 5592 uncached.
    expect(records.get('codex-cli:r:resp1')).toMatchObject({
      model: 'gpt-5.6-terra',
      provider: 'openai',
      input: 5592,
      cacheRead: 9984,
      cacheWrite: 0,
      output: 5,
      sessionId: 'sess-1',
      cwd: 'C:\\w1'
    })
    // 20000 − 15000 − 1000 = 4000 uncached; reasoning is part of output.
    expect(records.get('codex-cli:r:resp2')).toMatchObject({
      model: 'gpt-5.6-sol',
      input: 4000,
      cacheRead: 15000,
      cacheWrite: 1000,
      output: 300,
      reasoning: 200
    })
  })

  it('falls back to token_count, once per change of the running total', async () => {
    const day = join(dir, 'sessions', '2025', '01', '01')
    mkdirSync(day, { recursive: true })
    const t1 = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }
    const t2 = { input_tokens: 250, cached_input_tokens: 50, output_tokens: 30 }
    const last2 = { input_tokens: 150, cached_input_tokens: 50, output_tokens: 20 }
    writeFileSync(
      join(day, 'rollout-2025-01-01T00-00-00-11111111-2222-3333-4444-555555555555.jsonl'),
      meta('sess-2') +
        context('gpt-5', 1) +
        tokenCount(2, t1, t1) +
        tokenCount(3, t1, t1) +
        tokenCount(4, t2, last2)
    )
    const source = new JsonlSource(codexFormat(() => dir))
    await source.scan()
    const records = source.records()
    expect(records).toHaveLength(2)
    expect(records.map((record) => [record.input, record.cacheRead, record.output])).toEqual([
      [100, 0, 10],
      [100, 50, 20]
    ])
  })

  // The order a real 0.13x rollout writes: inputs, the model's items as they
  // stream, token_usage_record, then the tool outputs and token_count.
  const item = (timestamp: string, payload: Record<string, unknown>): string =>
    line({ timestamp, type: 'response_item', payload })
  const record = (timestamp: string, responseId: string): string =>
    line({
      timestamp,
      type: 'token_usage_record',
      payload: {
        response_id: responseId,
        turn_id: 't1',
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }
      }
    })

  it('spans each response from its last input line to its record, with its tool calls', async () => {
    const day = join(dir, 'sessions', '2026', '09', '26')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, 'rollout-2026-09-26T02-48-17-01a0e01e-9d27-7710-b0e5-243cb1bf4840.jsonl'),
      meta('sess-3') +
        item('2026-09-26T23:48:35.436Z', { type: 'message', role: 'developer', content: [] }) +
        item('2026-09-26T23:48:35.615Z', { type: 'message', role: 'user', content: [] }) +
        context('gpt-5.6-sol', 3) +
        item('2026-09-26T23:48:37.907Z', { type: 'reasoning', summary: [] }) +
        item('2026-09-26T23:48:37.909Z', { type: 'message', role: 'assistant', content: [] }) +
        item('2026-09-26T23:48:38.500Z', {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_1',
          arguments: '{}'
        }) +
        item('2026-09-26T23:48:39.021Z', {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'call_2',
          input: ''
        }) +
        record('2026-09-26T23:48:39.058Z', 'resp_a') +
        item('2026-09-26T23:48:41.370Z', { type: 'function_call_output', call_id: 'call_1' }) +
        item('2026-09-26T23:48:41.375Z', { type: 'custom_tool_call_output', call_id: 'call_2' }) +
        tokenCount(9, { input_tokens: 100, output_tokens: 10 }, { input_tokens: 100 }) +
        item('2026-09-26T23:48:43.327Z', { type: 'reasoning', summary: [] }) +
        item('2026-09-26T23:48:44.041Z', { type: 'message', role: 'assistant', content: [] }) +
        record('2026-09-26T23:48:46.025Z', 'resp_b')
    )
    const source = new JsonlSource(codexFormat(() => dir))
    await source.scan()
    const records = byId(source.records())
    expect(records.get('codex-cli:r:resp_a')).toMatchObject({
      at: Date.parse('2026-09-26T23:48:39.058Z'),
      startedAt: Date.parse('2026-09-26T23:48:35.615Z'),
      endedAt: Date.parse('2026-09-26T23:48:39.058Z'),
      tools: ['exec_command', 'apply_patch']
    })
    const second = records.get('codex-cli:r:resp_b')!
    expect(second.startedAt).toBe(Date.parse('2026-09-26T23:48:41.375Z'))
    expect(second.endedAt).toBe(Date.parse('2026-09-26T23:48:46.025Z'))
    expect(second.tools).toBeUndefined()
  })

  it('a token_count fallback written after the tool outputs still starts at the input before the response', async () => {
    const day = join(dir, 'sessions', '2025', '02', '02')
    mkdirSync(day, { recursive: true })
    const t1 = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }
    writeFileSync(
      join(day, 'rollout-2025-02-02T00-00-00-11111111-2222-3333-4444-666666666666.jsonl'),
      meta('sess-4') +
        context('gpt-5', 1) +
        item('2025-02-02T00:00:01.000Z', { type: 'message', role: 'user', content: [] }) +
        item('2025-02-02T00:00:03.000Z', {
          type: 'function_call',
          name: 'shell',
          call_id: 'c1',
          arguments: '{}'
        }) +
        item('2025-02-02T00:00:05.000Z', { type: 'function_call_output', call_id: 'c1' }) +
        line({
          timestamp: '2025-02-02T00:00:05.100Z',
          ordinal: 6,
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: t1, last_token_usage: t1 } }
        })
    )
    const source = new JsonlSource(codexFormat(() => dir))
    await source.scan()
    expect(source.records()).toHaveLength(1)
    expect(source.records()[0]).toMatchObject({
      startedAt: Date.parse('2025-02-02T00:00:01.000Z'),
      endedAt: Date.parse('2025-02-02T00:00:05.100Z'),
      tools: ['shell']
    })
  })
})

describe('OpenCode', () => {
  const row = (id: string, data: object): Parameters<typeof parseOpenCodeRow>[0] => ({
    id,
    session_id: 'ses_1',
    time_created: 1784565943856,
    data: JSON.stringify(data),
    directory: 'E:/w1'
  })

  it('counts reasoning inside output and keeps the recorded cost', () => {
    const record = parseOpenCodeRow(
      row('msg_1', {
        role: 'assistant',
        providerID: 'lmstudio',
        modelID: 'qwen/qwen3.5-9b',
        cost: 0,
        path: { cwd: 'E:\\w1' },
        time: { created: 1784565943856, completed: 1784565948222 },
        // OpenCode's own total: 7816 + 49 + 38 + 1792 = 9695.
        tokens: {
          total: 9695,
          input: 7816,
          output: 49,
          reasoning: 38,
          cache: { read: 1792, write: 0 }
        }
      })
    )
    expect(record).toMatchObject({
      id: 'opencode:msg_1',
      input: 7816,
      output: 87,
      reasoning: 38,
      cacheRead: 1792,
      at: 1784565948222,
      startedAt: 1784565943856,
      endedAt: 1784565948222,
      recordedPico: '0',
      cwd: 'E:\\w1'
    })
    // The message row has no tool calls (they are parts, not read).
    expect(record!.tools).toBeUndefined()
    // total tokens in this section's sense = OpenCode's total.
    expect(record!.input + record!.output + record!.cacheRead + record!.cacheWrite).toBe(9695)
  })

  it("the app's custom provider: OpenCode's 0 means no price, not $0", () => {
    const step = (providerID: string, cost: number): ReturnType<typeof parseOpenCodeRow> =>
      parseOpenCodeRow(
        row(`m-${providerID}`, {
          role: 'assistant',
          providerID,
          modelID: 'e2e-model',
          cost,
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
        })
      )
    expect(step('neurosquad-custom', 0)!.recordedPico).toBeUndefined()
    expect(step('neurosquad-custom', 0.5)!.recordedPico).toBe('500000000000')
    expect(step('opencode', 0)!.recordedPico).toBe('0')
  })

  it('skips user rows and empty (aborted) steps', () => {
    expect(parseOpenCodeRow(row('u', { role: 'user' }))).toBeNull()
    expect(
      parseOpenCodeRow(
        row('a', {
          role: 'assistant',
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        })
      )
    ).toBeNull()
  })

  it('reads a real SQLite database read-only', async () => {
    const sqlite = (
      process as unknown as { getBuiltinModule(id: string): unknown }
    ).getBuiltinModule('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
    }
    const path = join(dir, 'opencode.db')
    const db = new sqlite.DatabaseSync(path)
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT INTO session VALUES ('ses_1', 'E:/w1');
      INSERT INTO message VALUES ('msg_u', 'ses_1', 1, 1, '{"role":"user"}');
      INSERT INTO message VALUES ('msg_a', 'ses_1', 2, 2, '{"role":"assistant","providerID":"anthropic","modelID":"claude-sonnet-5","cost":0.0336565,"time":{"created":2},"tokens":{"input":2,"output":103,"reasoning":0,"cache":{"read":0,"write":13049}}}');`)
    db.close()
    const source = new OpenCodeSource(() => path)
    expect(await source.scan()).toBe(true)
    expect(source.records()).toHaveLength(1)
    expect(source.records()[0]).toMatchObject({
      id: 'opencode:msg_a',
      cwd: 'E:/w1',
      input: 2,
      output: 103,
      cacheWrite: 13049,
      recordedPico: '33656500000'
    })
    // Unchanged database: not re-read.
    expect(await source.scan()).toBe(false)
  })
})

describe('request span and tools', () => {
  it('keeps only a start that is not after the end and at most 30 minutes before it', () => {
    expect(requestSpan(10_000, 4_000, 12_000)).toEqual({ startedAt: 4_000, endedAt: 12_000 })
    expect(requestSpan(10_000, 11_000, 12_000)).toEqual({ endedAt: 12_000 })
    expect(requestSpan(10_000, 13_000, undefined)).toEqual({})
    const end = Date.parse('2026-09-10T10:00:00.000Z')
    expect(requestSpan(end, end - 30 * 60_000, end).startedAt).toBe(end - 30 * 60_000)
    expect(requestSpan(end, end - 30 * 60_000 - 1, end).startedAt).toBeUndefined()
    expect(requestSpan(end, Number.NaN, 'x')).toEqual({})
  })

  it('clamps tool names: at most 32, each at most 64 characters, duplicates kept', () => {
    expect(requestTools(undefined)).toBeUndefined()
    expect(requestTools([])).toBeUndefined()
    expect(requestTools(['Read', 'Read', '', 7])).toEqual(['Read', 'Read'])
    const many = requestTools(Array.from({ length: 40 }, (_, i) => `t${i}`))!
    expect(many).toHaveLength(32)
    expect(requestTools(['x'.repeat(100)])![0]).toHaveLength(64)
  })
})
