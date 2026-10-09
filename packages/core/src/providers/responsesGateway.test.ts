// The Responses → Chat Completions gateway for Codex on a chat-only custom
// provider (responsesGateway.ts, responsesTranslate.ts). Request shapes are
// the ones Codex 0.157.1 sends (captured on a local server). Ported from the
// NeuroSquad desktop app's tests.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ResponsesStream, toChatRequest, toResponsesUsage } from './responsesTranslate.js'
import {
  startResponsesGateway,
  type ResponsesGateway,
  type ResponsesGatewayUpstream
} from './responsesGateway.js'

/** What the host resolves for an agent (undefined: the provider was removed). */
interface Custom {
  key?: string
  model?: string
}
let custom: Custom | undefined
let gatewayServer: ResponsesGateway

type Json = Record<string, unknown>

const CODEX_TOOLS = [
  {
    type: 'function',
    name: 'exec_command',
    description: 'Runs a command in a PTY',
    strict: false,
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
  },
  {
    type: 'namespace',
    name: 'multi_agent_v1',
    description: 'Tools for spawning and managing sub-agents.',
    tools: [
      {
        type: 'function',
        name: 'spawn_agent',
        description: 'Spawn',
        parameters: { type: 'object', properties: {} }
      }
    ]
  },
  {
    type: 'custom',
    name: 'apply_patch',
    description: 'Apply a patch',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch' }
  },
  { type: 'web_search', external_web_access: false }
]

describe('Responses request → chat request', () => {
  it('instructions + leading developer messages are one system message; tools are mapped', () => {
    const { body, tools } = toChatRequest(
      {
        model: 'gpt-5',
        instructions: 'You are Codex.',
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEV' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'LATER' }] }
        ],
        tools: CODEX_TOOLS,
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { summary: 'auto' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'k',
        max_output_tokens: 500
      },
      'local/coder'
    )
    expect(body.model).toBe('local/coder')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_tokens).toBe(500)
    expect(body.tool_choice).toBe('auto')
    expect(body.parallel_tool_calls).toBe(true)
    for (const key of ['reasoning', 'store', 'include', 'prompt_cache_key', 'instructions']) {
      expect(body[key]).toBeUndefined()
    }
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are Codex.\n\nDEV' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'LATER' }
    ])
    const names = (body.tools as Json[]).map((t) => (t.function as Json).name)
    expect(names).toEqual(['exec_command', 'multi_agent_v1__spawn_agent', 'apply_patch'])
    const patch = (body.tools as Json[])[2].function as Json
    expect(patch.description).toContain('start: begin_patch')
    expect((patch.parameters as Json).required).toEqual(['input'])
    expect(tools.get('multi_agent_v1__spawn_agent')).toEqual({
      kind: 'function',
      name: 'spawn_agent',
      namespace: 'multi_agent_v1'
    })
  })

  it('calls merge into one assistant message, outputs become tool messages in order', () => {
    const { body } = toChatRequest(
      {
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
          { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'x' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
          { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
          {
            type: 'function_call',
            call_id: 'c2',
            name: 'spawn_agent',
            namespace: 'multi_agent_v1',
            arguments: '{}'
          },
          { type: 'custom_tool_call', call_id: 'c3', name: 'apply_patch', input: '*** Begin' },
          { type: 'function_call_output', call_id: 'c2', output: 'spawned' },
          {
            type: 'function_call_output',
            call_id: 'c1',
            output: [
              { type: 'input_text', text: 'a.txt' },
              { type: 'input_image', image_url: 'data:image/png;base64,AA' }
            ]
          },
          { type: 'custom_tool_call_output', call_id: 'c3', output: 'Done!' },
          { type: 'function_call_output', call_id: 'orphan', output: 'x' }
        ]
      },
      'm'
    )
    expect(body.messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"ls"}' }
          },
          {
            id: 'c2',
            type: 'function',
            function: { name: 'multi_agent_v1__spawn_agent', arguments: '{}' }
          },
          {
            id: 'c3',
            type: 'function',
            function: { name: 'apply_patch', arguments: '{"input":"*** Begin"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt\n[image]' },
      { role: 'tool', tool_call_id: 'c2', content: 'spawned' },
      { role: 'tool', tool_call_id: 'c3', content: 'Done!' }
    ])
  })

  it('a call whose output is missing gets "aborted"; a user image becomes an image part', () => {
    const { body } = toChatRequest(
      {
        input: [
          { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' },
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'look' },
              { type: 'input_image', image_url: 'data:image/png;base64,AA' }
            ]
          }
        ],
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto'
      },
      'm'
    )
    const messages = body.messages as Json[]
    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'aborted' })
    expect(messages[2].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }
    ])
    // Only web_search: no tools, no tool_choice.
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  it('tool_choice naming a tool inside a namespace uses its flat name; an unknown one is dropped', () => {
    const choose = (choice: Json): unknown =>
      toChatRequest({ model: 'gpt-5', input: [], tools: CODEX_TOOLS, tool_choice: choice }, 'm')
        .body.tool_choice
    const named = (name: string): unknown => ({ type: 'function', function: { name } })
    const spawn = { type: 'function', name: 'spawn_agent' }
    expect(choose({ ...spawn, namespace: 'multi_agent_v1' })).toEqual(
      named('multi_agent_v1__spawn_agent')
    )
    expect(choose(spawn)).toEqual(named('multi_agent_v1__spawn_agent'))
    expect(choose({ type: 'function', name: 'exec_command' })).toEqual(named('exec_command'))
    expect(choose({ type: 'function', name: 'nope' })).toBeUndefined()
  })

  it('--output-schema → response_format json_schema', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    const { body } = toChatRequest(
      { input: 'x', text: { format: { type: 'json_schema', name: 'out', schema, strict: true } } },
      'm'
    )
    expect(body.messages).toEqual([{ role: 'user', content: 'x' }])
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema, strict: true }
    })
  })
})

const chunk = (delta: Json, finish: string | null = null): Json => ({
  id: 'c',
  choices: [{ index: 0, delta, finish_reason: finish }]
})

describe('chat stream → Responses events', () => {
  it('usage maps exactly; none → no usage (never an estimate)', () => {
    expect(
      toResponsesUsage({
        prompt_tokens: 1234,
        completion_tokens: 56,
        total_tokens: 1290,
        prompt_tokens_details: { cached_tokens: 1000 },
        completion_tokens_details: { reasoning_tokens: 7 }
      })
    ).toEqual({
      input_tokens: 1234,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens: 56,
      output_tokens_details: { reasoning_tokens: 7 },
      total_tokens: 1290
    })
    expect(toResponsesUsage(undefined)).toBeUndefined()
    const stream = new ResponsesStream('m', new Map())
    stream.push(chunk({ content: 'hi' }, 'stop'))
    const completed = stream.end().at(-1)!
    expect((completed.response as Json).usage).toBeUndefined()
  })

  it('reasoning, text and split parallel tool calls; namespace and custom tools map back', () => {
    const { tools } = toChatRequest({ tools: CODEX_TOOLS }, 'm')
    const stream = new ResponsesStream('m', tools)
    const events = [
      ...stream.start(),
      ...stream.push(chunk({ role: 'assistant', reasoning_content: 'think' })),
      ...stream.push(chunk({ content: 'Let me ' })),
      ...stream.push(chunk({ content: 'look.' })),
      ...stream.push(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cm' }
            }
          ]
        })
      ),
      ...stream.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'd":"ls"}' } }] })),
      ...stream.push(
        chunk({
          tool_calls: [
            {
              index: 1,
              id: 'call_b',
              function: { name: 'multi_agent_v1__spawn_agent', arguments: '{}' }
            },
            {
              index: 2,
              id: 'call_c',
              function: { name: 'apply_patch', arguments: '{"input":"*** P"}' }
            }
          ]
        })
      ),
      ...stream.push(chunk({}, 'tool_calls')),
      ...stream.push({
        id: 'c',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }),
      ...stream.end()
    ]
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('response.created')
    expect(types).toContain('response.reasoning_summary_text.delta')
    expect(types.at(-1)).toBe('response.completed')
    const text = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
      .join('')
    expect(text).toBe('Let me look.')
    const done = events
      .filter((e) => e.type === 'response.output_item.done')
      .map((e) => e.item as Json)
    expect(done.map((item) => item.type)).toEqual([
      'reasoning',
      'message',
      'function_call',
      'function_call',
      'custom_tool_call'
    ])
    expect(done[0].summary).toEqual([{ type: 'summary_text', text: 'think' }])
    expect(done[1].content).toEqual([
      { type: 'output_text', text: 'Let me look.', annotations: [] }
    ])
    expect(done[2]).toMatchObject({
      call_id: 'call_a',
      name: 'exec_command',
      arguments: '{"cmd":"ls"}'
    })
    expect(done[2].namespace).toBeUndefined()
    expect(done[3]).toMatchObject({
      call_id: 'call_b',
      name: 'spawn_agent',
      namespace: 'multi_agent_v1'
    })
    expect(done[4]).toMatchObject({ call_id: 'call_c', name: 'apply_patch', input: '*** P' })
    const completed = events.at(-1)!.response as Json
    expect((completed.output as Json[]).length).toBe(5)
    expect(completed.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
  })

  it('finish_reason "length" → response.incomplete; a cut-off tool call is not run', () => {
    const stream = new ResponsesStream('m', new Map())
    stream.push(chunk({ content: 'Running' }))
    stream.push(
      chunk({
        tool_calls: [
          { index: 0, id: 'call_ok', function: { name: 'f', arguments: '{"a":1}' } },
          { index: 1, id: 'call_cut', function: { name: 'g', arguments: '{"cmd":"rm -r' } }
        ]
      })
    )
    stream.push(chunk({}, 'length'))
    const events = stream.end()
    const last = events.at(-1)!
    expect(last.type).toBe('response.incomplete')
    const response = last.response as Json
    expect(response.status).toBe('incomplete')
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
    const output = response.output as Json[]
    expect(output.map((item) => item.type)).toEqual(['message', 'function_call'])
    expect(output[0].status).toBe('incomplete')
    expect(output[1]).toMatchObject({ call_id: 'call_ok', arguments: '{"a":1}' })
    expect(stream.completedResponse().status).toBe('incomplete')
  })

  it('parallel calls without an index are told apart by id; an index reused for a new id too', () => {
    const stream = new ResponsesStream('m', new Map())
    stream.push(chunk({ tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{"a"' } }] }))
    stream.push(chunk({ tool_calls: [{ function: { arguments: ':1}' } }] }))
    stream.push(chunk({ tool_calls: [{ id: 'b', function: { name: 'f', arguments: '{"b":2}' } }] }))
    stream.push(
      chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'g', arguments: '{' } }] })
    )
    stream.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }))
    stream.push(
      chunk({ tool_calls: [{ index: 0, id: 'd', function: { name: 'g', arguments: '{"d":4}' } }] })
    )
    stream.push(chunk({}, 'tool_calls'))
    const done = stream
      .end()
      .filter((e) => e.type === 'response.output_item.done')
      .map((e) => e.item as Json)
    expect(done.map((item) => [item.call_id, item.arguments])).toEqual([
      ['a', '{"a":1}'],
      ['b', '{"b":2}'],
      ['c', '{}'],
      ['d', '{"d":4}']
    ])
  })

  it('a non-streamed completion (server ignored stream) and a missing call id', () => {
    const stream = new ResponsesStream('m', new Map())
    stream.push({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok',
            tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }]
          },
          finish_reason: 'tool_calls'
        }
      ]
    })
    stream.end()
    const out = stream.completedResponse().output as Json[]
    expect(out[0]).toMatchObject({ type: 'message' })
    expect(out[1]).toMatchObject({ type: 'function_call', name: 'f' })
    expect(String(out[1].call_id)).toMatch(/^call_/)
  })
})

// End to end: a fake chat-completions server behind the gateway.
interface Seen {
  url?: string
  auth?: string
  headers: Json
  body: Json
}
const seen: Seen[] = []
let upstream: Server
let base = ''
let script: (body: Json) => {
  status?: number
  frames?: string[]
  json?: unknown
  /** Close the stream without the closing `data: [DONE]`. */
  noDone?: boolean
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (part) => (raw += part))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Json
      seen.push({ url: req.url, auth: req.headers.authorization, headers: req.headers, body })
      const reply = script(body)
      if (reply.json !== undefined) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.json))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of reply.frames ?? []) res.write(frame)
      res.end(reply.noDone ? undefined : 'data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
  gatewayServer = await startResponsesGateway({
    resolve: (): ResponsesGatewayUpstream | { status: number; message: string } => {
      if (!custom) return { status: 400, message: 'the provider of this agent was removed' }
      const models = ['local/first']
      return {
        url: `${base}/chat/completions`,
        ...(custom.key ? { key: custom.key } : {}),
        model: custom.model ?? models[0]!,
        models,
        label: 'LM Studio'
      }
    }
  })
})

afterAll(async () => {
  await gatewayServer?.close()
  upstream?.close()
})

function customFor(key?: string, model?: string): Custom {
  return { ...(key ? { key } : {}), ...(model ? { model } : {}) }
}

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

function parseSse(text: string): Json[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Json)
}

async function ask(agentId: string, key?: string, stream = true): Promise<Response> {
  const gateway = gatewayServer.forAgent(agentId)
  return fetch(`${gateway.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key ?? gateway.key}`,
      'x-codex-turn-metadata': '{"workspaces":{"C:\\\\secret":{}}}'
    },
    body: JSON.stringify({
      model: 'gpt-5',
      instructions: 'sys',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: CODEX_TOOLS,
      stream
    })
  })
}

describe('gateway end to end', () => {
  it('streams a chat reply back as Responses events with the exact usage; key and model are the card’s', async () => {
    custom = customFor('sk-local', 'local/coder')
    script = () => ({
      frames: [
        frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'DONE' } }] }),
        frame({ choices: [{ index: 0, delta: { content: '_OK' }, finish_reason: 'stop' }] }),
        frame({
          choices: [],
          usage: {
            prompt_tokens: 321,
            completion_tokens: 9,
            total_tokens: 330,
            prompt_tokens_details: { cached_tokens: 300 }
          }
        })
      ]
    })
    const response = await ask('x1')
    expect(response.status).toBe(200)
    const events = parseSse(await response.text())
    const done = events.find((e) => e.type === 'response.output_item.done')!.item as Json
    expect(done.content).toEqual([{ type: 'output_text', text: 'DONE_OK', annotations: [] }])
    const completed = events.at(-1)!
    expect(completed.type).toBe('response.completed')
    expect((completed.response as Json).usage).toEqual({
      input_tokens: 321,
      input_tokens_details: { cached_tokens: 300 },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 330
    })
    const last = seen.at(-1)!
    expect(last.url).toBe('/v1/chat/completions')
    expect(last.auth).toBe('Bearer sk-local')
    expect(last.body.model).toBe('local/coder')
    expect(last.headers['x-codex-turn-metadata']).toBeUndefined()
  })

  it('a non-streaming request gets the whole response object', async () => {
    custom = customFor()
    script = () => ({
      frames: [frame({ choices: [{ index: 0, delta: { content: 'yo' }, finish_reason: 'stop' }] })]
    })
    const response = await ask('x2', undefined, false)
    const body = (await response.json()) as Json
    expect(body.object).toBe('response')
    expect((body.output as Json[])[0]).toMatchObject({ type: 'message' })
    // No key → no Authorization upstream; no card model → the provider's first.
    expect(seen.at(-1)!.auth).toBeUndefined()
    expect(seen.at(-1)!.body.model).toBe('local/first')
  })

  it('wrong credential → 401 and nothing upstream; another card’s credential does not open it', async () => {
    custom = customFor('sk-local')
    const before = seen.length
    expect((await ask('x3', 'nope')).status).toBe(401)
    expect((await ask('x3', gatewayServer.forAgent('x1').key)).status).toBe(401)
    expect(seen.length).toBe(before)
  })

  it('an upstream 400 stays a 400 with its message; a mid-stream error is response.failed', async () => {
    custom = customFor()
    script = () => ({ status: 400, json: { error: { message: 'context too long' } } })
    const rejected = await ask('x4')
    expect(rejected.status).toBe(400)
    expect(JSON.stringify(await rejected.json())).toContain('context too long')
    script = () => ({
      frames: [
        frame({ choices: [{ index: 0, delta: { content: 'pa' } }] }),
        frame({ error: { message: 'model crashed' } })
      ]
    })
    const events = parseSse(await (await ask('x4')).text())
    expect(events.at(-1)!.type).toBe('response.failed')
    expect(JSON.stringify(events.at(-1))).toContain('model crashed')
  })

  it('a stream closed before it finished is response.failed, not a completed answer', async () => {
    custom = customFor()
    script = () => ({
      noDone: true,
      frames: [
        frame({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'k', function: { name: 'exec_command' } }] }
            }
          ]
        }),
        frame({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"rm' } }] }
            }
          ]
        })
      ]
    })
    const events = parseSse(await (await ask('x6')).text())
    expect(events.at(-1)!.type).toBe('response.failed')
    expect(events.some((e) => e.type === 'response.output_item.done')).toBe(false)
    // A finish_reason is a whole answer even when [DONE] never comes.
    script = () => ({
      noDone: true,
      frames: [frame({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })]
    })
    expect(parseSse(await (await ask('x6')).text()).at(-1)!.type).toBe('response.completed')
    // A cut by max tokens is response.incomplete.
    script = () => ({
      frames: [
        frame({ choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'length' }] })
      ]
    })
    const cut = parseSse(await (await ask('x6')).text()).at(-1)!
    expect(cut.type).toBe('response.incomplete')
    expect((cut.response as Json).incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('one event split over several data: lines, CRLF frames, and a character split at the very end', async () => {
    custom = customFor()
    const whole = JSON.stringify({
      choices: [{ index: 0, delta: { content: 'héllo' }, finish_reason: 'stop' }]
    })
    const cut = whole.indexOf('"delta"')
    script = () => ({
      noDone: true,
      frames: [`data: ${whole.slice(0, cut)}\r\ndata: ${whole.slice(cut)}\r\n\r\n`]
    })
    const events = parseSse(await (await ask('x7')).text())
    const done = events.find((e) => e.type === 'response.output_item.done')!.item as Json
    expect(done.content).toEqual([{ type: 'output_text', text: 'héllo', annotations: [] }])
    expect(events.at(-1)!.type).toBe('response.completed')
    // A server that ends without the blank line, a multi-byte character last.
    script = () => ({
      noDone: true,
      frames: [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ü' }, finish_reason: 'stop' }] })}`
      ]
    })
    const tail = parseSse(await (await ask('x7')).text())
    const item = tail.find((e) => e.type === 'response.output_item.done')!.item as Json
    expect(item.content).toEqual([{ type: 'output_text', text: 'aü', annotations: [] }])
  })

  it('a body over the limit is a 413, not "not JSON" or a broken connection', async () => {
    custom = customFor()
    const gateway = gatewayServer.forAgent('x7')
    const before = seen.length
    const response = await fetch(`${gateway.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${gateway.key}` },
      body: 'x'.repeat(64 * 1024 * 1024 + 1)
    })
    expect(response.status).toBe(413)
    expect(JSON.stringify(await response.json())).toContain('over 64 MB')
    expect(seen.length).toBe(before)
  })

  it('a removed provider is an error; GET /models lists the card model', async () => {
    custom = customFor(undefined, 'local/coder')
    const gateway = gatewayServer.forAgent('x5')
    const models = (await (
      await fetch(`${gateway.baseUrl}/models`, {
        headers: { authorization: `Bearer ${gateway.key}` }
      })
    ).json()) as { data: Json[] }
    expect(models.data.map((m) => m.id)).toEqual(['local/coder', 'local/first'])
    custom = undefined
    expect((await ask('x5')).status).toBe(400)
  })
})
