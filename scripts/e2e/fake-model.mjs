// A scripted fake model API for end-to-end tests of nsq with real harness
// CLIs and no real model behind them. It speaks:
//
//   POST /v1/messages            Anthropic Messages (Claude Code), stream or not
//   POST /v1/responses           OpenAI Responses (Codex), streamed
//   POST /v1/chat/completions    OpenAI Chat Completions (OpenCode), stream or not
//   GET  /v1/models              a one-model list
//
// with or without an `/api` prefix (OpenRouter's path shape), so it can also
// stand in for OpenRouter and record the headers each request arrived with.
//
// A prompt containing `[nsq:<scenario>]` plays that scenario; the step is
// derived from the request itself (tool calls answered since the marked
// prompt), so the server keeps no per-conversation state. Everything else
// (titles, side requests) gets a short generic answer. Every request is logged
// (`GET /__fake/requests`, and as JSON lines to `--log <file>`) with the usage
// it was answered with and its headers (credentials reduced to their last 4
// characters), so a test can check costs and attribution headers.
//
//   node scripts/e2e/fake-model.mjs [--port 0] [--log requests.jsonl]
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const MARKER = /\[nsq:([a-z0-9-]+)\]/i
export const MODEL = 'fake-model'
/** Usage reported for a scripted step (tests compare costs against these). */
export const STEP_USAGE = { input: 1200, output: 40 }
const SIDE_USAGE = { input: 10, output: 2 }

/** A command that needs approval in every harness's default mode. */
export const PERM_DIR = 'nsq-perm-dir'

export const SCENARIOS = {
  hello: [() => ({ text: 'NSQ_HELLO_DONE — scripted answer.', delayMs: 2000 })],
  slow: [() => ({ text: 'NSQ_SLOW_DONE', delayMs: 8000 })],
  perm: [
    (ctx) => ({ tool: shellCall(ctx) }),
    (ctx) => ({
      text: `NSQ_PERM_DONE result=${JSON.stringify((ctx.lastResult ?? '').slice(0, 80))}`
    })
  ],
  ask: [(ctx) => ({ tool: questionCall(ctx) ?? shellCall(ctx) }), () => ({ text: 'NSQ_ASK_DONE' })]
}

/** The harness's shell tool and arguments for `mkdir PERM_DIR`. */
function shellCall(ctx) {
  const names = ctx.tools
  const pick = (re) => names.find((name) => re.test(name))
  const bash = pick(/^Bash$/)
  if (bash)
    return { name: bash, input: { command: `mkdir ${PERM_DIR}`, description: 'Create a folder' } }
  const exec = pick(/^exec_command$/)
  if (exec) {
    return {
      name: exec,
      input: {
        cmd: `mkdir ${PERM_DIR}`,
        sandbox_permissions: 'require_escalated',
        justification: 'Create a folder for the test'
      }
    }
  }
  const shell = pick(/^(shell|shell_command|local_shell)$/)
  if (shell) {
    return {
      name: shell,
      input:
        shell === 'shell_command'
          ? { command: `mkdir ${PERM_DIR}` }
          : {
              command:
                process.platform === 'win32'
                  ? ['powershell.exe', '-Command', `mkdir ${PERM_DIR}`]
                  : ['bash', '-lc', `mkdir ${PERM_DIR}`]
            }
    }
  }
  const lower = pick(/^bash$/)
  if (lower)
    return { name: lower, input: { command: `mkdir ${PERM_DIR}`, description: 'Create a folder' } }
  return null
}

function questionCall(ctx) {
  const ask = ctx.tools.find((name) => /^(AskUserQuestion|question|request_user_input)$/.test(name))
  if (!ask) return null
  if (ask === 'AskUserQuestion') {
    return {
      name: ask,
      input: {
        questions: [
          {
            question: 'Which color should the button be?',
            header: 'Color',
            multiSelect: false,
            options: [
              { label: 'Blue', description: 'Calm' },
              { label: 'Red', description: 'Loud' }
            ]
          }
        ]
      }
    }
  }
  return {
    name: ask,
    input: {
      questions: [
        {
          question: 'Which color should the button be?',
          header: 'Color',
          options: [{ label: 'Blue' }, { label: 'Red' }]
        }
      ]
    }
  }
}

// ---- request parsing -------------------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      typeof block === 'string'
        ? block
        : (block?.text ?? (block?.type === 'tool_result' ? textOf(block.content) : ''))
    )
    .join('\n')
}

/** Normalized conversation: [{ role: 'user'|'assistant'|'tool', text, toolCall? }] and tool names. */
function conversation(protocol, body) {
  const items = []
  if (protocol === 'responses') {
    for (const item of body.input ?? []) {
      if (item.type === 'message' || item.role) {
        items.push({
          role: item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : 'system',
          text: textOf(item.content)
        })
      } else if (
        item.type === 'function_call' ||
        item.type === 'local_shell_call' ||
        item.type === 'custom_tool_call'
      ) {
        items.push({ role: 'assistant', text: '', toolCall: true })
      } else if (
        item.type === 'function_call_output' ||
        item.type === 'custom_tool_call_output' ||
        item.type === 'local_shell_call_output'
      ) {
        items.push({
          role: 'tool',
          text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
        })
      }
    }
    const tools = (body.tools ?? [])
      .map((tool) => tool.name ?? tool.function?.name ?? tool.type)
      .filter(Boolean)
    return { items, tools }
  }
  for (const message of body.messages ?? []) {
    if (protocol === 'anthropic' && message.role === 'user' && Array.isArray(message.content)) {
      const results = message.content.filter((block) => block?.type === 'tool_result')
      for (const result of results) items.push({ role: 'tool', text: textOf(result.content) })
      const own = message.content.filter((block) => block?.type !== 'tool_result')
      if (textOf(own).trim()) items.push({ role: 'user', text: textOf(own) })
      continue
    }
    if (message.role === 'tool') {
      items.push({ role: 'tool', text: textOf(message.content) })
      continue
    }
    const toolCall =
      (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
      (Array.isArray(message.content) &&
        message.content.some((block) => block?.type === 'tool_use'))
    items.push({ role: message.role, text: textOf(message.content), toolCall })
  }
  const tools = (body.tools ?? [])
    .map((tool) => (protocol === 'anthropic' ? tool.name : (tool.function?.name ?? tool.name)))
    .filter(Boolean)
  return { items, tools }
}

export function plan(protocol, body, scenarios = SCENARIOS) {
  const { items, tools } = conversation(protocol, body)
  let at = -1
  let scenario
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role !== 'user') continue
    const match = MARKER.exec(items[i].text)
    if (match) {
      at = i
      scenario = match[1].toLowerCase()
    }
    break
  }
  const steps = scenario ? scenarios[scenario] : undefined
  if (!steps || tools.length === 0) {
    return {
      text: scenario ? `side answer (${scenario})` : 'OK.',
      usage: SIDE_USAGE,
      scenario,
      side: true,
      tools
    }
  }
  const after = items.slice(at + 1)
  const step = after.filter((item) => item.role === 'tool').length
  const lastResult = [...after].reverse().find((item) => item.role === 'tool')?.text
  const fn = steps[step]
  const planned = fn
    ? fn({ tools, step, lastResult })
    : { text: `NSQ_${scenario.toUpperCase()}_DONE` }
  if (planned.tool === null)
    return {
      text: `NSQ_NO_TOOL among ${tools.join(',')}`,
      usage: STEP_USAGE,
      scenario,
      step,
      tools
    }
  return { ...planned, usage: STEP_USAGE, scenario, step, tools }
}

// ---- encoders ----------------------------------------------------------------------

let counter = 0
const id = (prefix) => `${prefix}_${Date.now().toString(36)}${(++counter).toString(36)}`

function anthropicMessage(model, reply) {
  const content = []
  if (reply.text) content.push({ type: 'text', text: reply.text })
  if (reply.tool)
    content.push({
      type: 'tool_use',
      id: id('toolu'),
      name: reply.tool.name,
      input: reply.tool.input
    })
  return {
    id: id('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: reply.tool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: reply.usage.input,
      output_tokens: reply.usage.output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  }
}

function anthropicEvents(message) {
  const events = []
  const push = (type, data) =>
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  push('message_start', {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { ...message.usage, output_tokens: 1 }
    }
  })
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      push('content_block_start', { index, content_block: { type: 'text', text: '' } })
      push('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
    } else {
      push('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
      })
      push('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      })
    }
    push('content_block_stop', { index })
  })
  push('message_delta', {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens }
  })
  push('message_stop', {})
  return events
}

function chatCompletion(model, reply) {
  const toolCalls = reply.tool
    ? [
        {
          id: id('call'),
          type: 'function',
          function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.input) }
        }
      ]
    : undefined
  return {
    id: id('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: reply.text ?? null, tool_calls: toolCalls },
        finish_reason: toolCalls ? 'tool_calls' : 'stop'
      }
    ],
    usage: {
      prompt_tokens: reply.usage.input,
      completion_tokens: reply.usage.output,
      total_tokens: reply.usage.input + reply.usage.output
    }
  }
}

function chatEvents(completion) {
  const base = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model
  }
  const choice = completion.choices[0]
  const lines = []
  const push = (obj) => lines.push(`data: ${JSON.stringify({ ...base, ...obj })}\n\n`)
  push({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  if (choice.message.content)
    push({
      choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }]
    })
  for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
    push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index, id: call.id, type: 'function', function: call.function }]
          },
          finish_reason: null
        }
      ]
    })
  }
  push({ choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })
  push({ choices: [], usage: completion.usage })
  lines.push('data: [DONE]\n\n')
  return lines
}

function responsesEvents(model, reply) {
  const responseId = id('resp')
  const events = []
  let seq = 0
  const push = (type, data) =>
    events.push(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`
    )
  const output = []
  const shell = {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'in_progress',
    output: []
  }
  push('response.created', { response: shell })
  push('response.in_progress', { response: shell })
  let index = 0
  if (reply.text) {
    const itemId = id('msg')
    const item = {
      type: 'message',
      id: itemId,
      role: 'assistant',
      status: 'in_progress',
      content: []
    }
    push('response.output_item.added', { output_index: index, item })
    push('response.content_part.added', {
      item_id: itemId,
      output_index: index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    })
    push('response.output_text.delta', {
      item_id: itemId,
      output_index: index,
      content_index: 0,
      delta: reply.text
    })
    push('response.output_text.done', {
      item_id: itemId,
      output_index: index,
      content_index: 0,
      text: reply.text
    })
    const part = { type: 'output_text', text: reply.text, annotations: [] }
    push('response.content_part.done', {
      item_id: itemId,
      output_index: index,
      content_index: 0,
      part
    })
    const done = { ...item, status: 'completed', content: [part] }
    push('response.output_item.done', { output_index: index, item: done })
    output.push(done)
    index++
  }
  if (reply.tool) {
    const itemId = id('fc')
    const args = JSON.stringify(reply.tool.input)
    const item = {
      type: 'function_call',
      id: itemId,
      call_id: id('call'),
      name: reply.tool.name,
      arguments: '',
      status: 'in_progress'
    }
    push('response.output_item.added', { output_index: index, item })
    push('response.function_call_arguments.delta', {
      item_id: itemId,
      output_index: index,
      delta: args
    })
    push('response.function_call_arguments.done', {
      item_id: itemId,
      output_index: index,
      arguments: args
    })
    const done = { ...item, arguments: args, status: 'completed' }
    push('response.output_item.done', { output_index: index, item: done })
    output.push(done)
  }
  push('response.completed', {
    response: {
      ...shell,
      status: 'completed',
      output,
      usage: {
        input_tokens: reply.usage.input,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: reply.usage.output,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: reply.usage.input + reply.usage.output
      }
    }
  })
  return events
}

// ---- the server ----------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'cookie'])

function headersOf(req) {
  const out = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    out[name] = SECRET_HEADERS.has(name) ? `…${text.slice(-4)}` : text
  }
  return out
}

export async function startFakeModel({ port = 0, logFile, scenarios = SCENARIOS } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      handle(req, res, data).catch((error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(error) } }))
      })
    })
  })
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const record = (entry) => {
    requests.push(entry)
    if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
  }
  async function handle(req, res, data) {
    const url = new URL(req.url ?? '/', 'http://fake')
    const route = url.pathname.replace(/\/+$/, '').replace(/^\/api(?=\/v1\/)/, '')
    if (route === '/__fake/requests') return json(res, 200, requests)
    if (route === '/__fake/reset') {
      requests.length = 0
      return json(res, 200, { ok: true })
    }
    let body = {}
    try {
      body = data ? JSON.parse(data) : {}
    } catch {
      body = {}
    }
    if (req.method === 'GET' && route === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [{ id: MODEL, object: 'model', created: 1_700_000_000, owned_by: 'fake' }]
      })
    }
    if (route === '/v1/messages/count_tokens')
      return json(res, 200, { input_tokens: Math.max(1, Math.round(data.length / 4)) })
    const protocol =
      route === '/v1/messages'
        ? 'anthropic'
        : route === '/v1/responses'
          ? 'responses'
          : route === '/v1/chat/completions'
            ? 'chat'
            : null
    if (req.method !== 'POST' || !protocol) {
      record({
        at: Date.now(),
        path: url.pathname,
        method: req.method,
        status: 404,
        headers: headersOf(req)
      })
      res.writeHead(404).end()
      return
    }
    const reply = plan(protocol, body, scenarios)
    record({
      at: Date.now(),
      path: url.pathname,
      protocol,
      model: body.model,
      scenario: reply.scenario,
      step: reply.step,
      side: Boolean(reply.side),
      tools: reply.tools?.slice(0, 40),
      replied: reply.tool ? `tool ${reply.tool.name}` : `text ${String(reply.text).slice(0, 60)}`,
      usage: reply.usage,
      headers: headersOf(req)
    })
    if (reply.delayMs) await sleep(reply.delayMs)
    const model = body.model ?? MODEL
    if (protocol === 'anthropic') {
      const message = anthropicMessage(model, reply)
      if (!body.stream) return json(res, 200, message)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const event of anthropicEvents(message)) {
        res.write(event)
        await sleep(10)
      }
      return res.end()
    }
    if (protocol === 'chat') {
      const completion = chatCompletion(model, reply)
      if (!body.stream) return json(res, 200, completion)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const line of chatEvents(completion)) {
        res.write(line)
        await sleep(10)
      }
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const event of responsesEvents(model, reply)) {
      res.write(event)
      await sleep(10)
    }
    res.end()
  }
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return {
    base: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const arg = (name) => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const fake = await startFakeModel({ port: Number(arg('port') ?? 0), logFile: arg('log') })
  process.stdout.write(`fake model on ${fake.base}\n`)
}
