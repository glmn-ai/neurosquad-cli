// Pure translation between the OpenAI Responses API that Codex CLI speaks and
// the Chat Completions API of a custom provider that has no `/v1/responses`
// (LM Studio, llama.cpp, vLLM, Ollama…). Used by responsesGateway.ts; ported from
// the NeuroSquad desktop app (its docs/codex-integration.md, "Custom provider without /v1/responses").
//
// Shapes are the ones Codex 0.157.1 really sends (captured on a local server):
// `instructions`, `input` items (message with developer/user/assistant roles
// and input_text / output_text / input_image parts, function_call,
// function_call_output, custom_tool_call(_output), reasoning, …), `tools`
// (function, namespace with nested functions, web_search), `tool_choice`,
// `parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`,
// `prompt_cache_key`, `client_metadata`.
//
// Back to Codex: Responses SSE events — `response.created`,
// `response.output_item.added/done` (message, reasoning summary,
// function_call with its `namespace`, custom_tool_call),
// `response.output_text.delta`, `response.reasoning_summary_text.delta`,
// `response.completed` with the upstream's usage, exact (never estimated),
// or `response.failed`.

type Json = Record<string, unknown>

/** A Responses tool Chat Completions cannot express is dropped; these are the ones we map. */
interface ToolOrigin {
  kind: 'function' | 'custom'
  /** The tool's own name in Codex. */
  name: string
  /** Set for a tool inside a `namespace` tool (Codex's `multi_agent_v1`). */
  namespace?: string
}

/** Chat function name → where it came from. */
export type ToolMap = Map<string, ToolOrigin>

export interface ChatRequest {
  body: Json
  tools: ToolMap
}

/** Chat function names: `^[a-zA-Z0-9_-]{1,64}$`. A namespaced tool is `<ns>__<name>`. */
const NAMESPACE_JOIN = '__'

function flatName(name: string, namespace?: string): string {
  return namespace ? `${namespace}${NAMESPACE_JOIN}${name}` : name
}

function textOf(part: unknown): string | undefined {
  if (typeof part === 'string') return part
  if (!part || typeof part !== 'object') return undefined
  const p = part as Json
  return typeof p.text === 'string' ? p.text : undefined
}

/** A Responses message's content as chat content: a string, or parts when it has images. */
function messageContent(content: unknown, allowImages: boolean): string | Json[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: Json[] = []
  for (const raw of content) {
    const part = (raw ?? {}) as Json
    if (part.type === 'input_image') {
      const url =
        typeof part.image_url === 'string'
          ? part.image_url
          : typeof (part.image_url as Json | undefined)?.url === 'string'
            ? ((part.image_url as Json).url as string)
            : undefined
      if (url && allowImages) parts.push({ type: 'image_url', image_url: { url } })
      else parts.push({ type: 'text', text: '[image]' })
      continue
    }
    const text = textOf(part)
    if (text !== undefined) parts.push({ type: 'text', text })
  }
  if (parts.every((part) => part.type === 'text')) return parts.map((p) => p.text).join('')
  return parts
}

/** A tool output (string, or content items) as the text of a chat `tool` message. */
export function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        const it = (item ?? {}) as Json
        if (it.type === 'input_image') return '[image]'
        return textOf(it) ?? JSON.stringify(it)
      })
      .join('\n')
  }
  if (output && typeof output === 'object') {
    const o = output as Json
    // Older shape: { content, success }.
    if (typeof o.content === 'string') return o.content
    if (Array.isArray(o.content)) return toolOutputText(o.content)
    return JSON.stringify(o)
  }
  return output === undefined || output === null ? '' : String(output)
}

function customToolDescription(tool: Json): string {
  const base = typeof tool.description === 'string' ? tool.description : ''
  const format = (tool.format ?? {}) as Json
  const hint =
    format.type === 'grammar' && typeof format.definition === 'string'
      ? `\n\nPut the raw text (not JSON) in \`input\`. It must follow this ${String(
          format.syntax ?? ''
        )} grammar:\n${format.definition}`
      : '\n\nPut the raw text (not JSON) in `input`.'
  return base + hint
}

/** Responses `tools` → chat `tools`, and the map back. */
function translateTools(tools: unknown): { tools: Json[]; map: ToolMap } {
  const out: Json[] = []
  const map: ToolMap = new Map()
  const addFunction = (tool: Json, namespace?: string): void => {
    if (typeof tool.name !== 'string') return
    const name = flatName(tool.name, namespace)
    map.set(name, { kind: 'function', name: tool.name, ...(namespace ? { namespace } : {}) })
    out.push({
      type: 'function',
      function: {
        name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: tool.parameters ?? { type: 'object', properties: {} }
      }
    })
  }
  for (const raw of Array.isArray(tools) ? tools : []) {
    const tool = (raw ?? {}) as Json
    if (tool.type === 'function') addFunction(tool)
    else if (tool.type === 'namespace' && typeof tool.name === 'string') {
      for (const inner of Array.isArray(tool.tools) ? tool.tools : []) {
        if ((inner as Json)?.type === 'function') addFunction(inner as Json, tool.name)
      }
    } else if (tool.type === 'custom' && typeof tool.name === 'string') {
      map.set(tool.name, { kind: 'custom', name: tool.name })
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          description: customToolDescription(tool),
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'The raw input text.' } },
            required: ['input'],
            additionalProperties: false
          }
        }
      })
    }
    // web_search, image_generation, local_shell, tool_search, file_search…:
    // the server would have to run them; a chat endpoint has no such thing.
  }
  return { tools: out, map }
}

interface ChatMessage extends Json {
  role: 'system' | 'user' | 'assistant' | 'tool'
}

/** Responses `instructions` + `input` → chat `messages`. */
function translateInput(instructions: unknown, input: unknown): ChatMessage[] {
  const system: string[] = []
  if (typeof instructions === 'string' && instructions) system.push(instructions)
  const messages: ChatMessage[] = []
  const items: Json[] =
    typeof input === 'string'
      ? [{ type: 'message', role: 'user', content: input }]
      : Array.isArray(input)
        ? (input as Json[])
        : []
  const lastAssistant = (): ChatMessage => {
    const last = messages.at(-1)
    if (last?.role === 'assistant') return last
    const fresh: ChatMessage = { role: 'assistant', content: null }
    messages.push(fresh)
    return fresh
  }
  const addCall = (id: string, name: string, args: string): void => {
    const assistant = lastAssistant()
    const calls = (assistant.tool_calls as Json[] | undefined) ?? []
    calls.push({ id, type: 'function', function: { name, arguments: args } })
    assistant.tool_calls = calls
  }
  for (const raw of items) {
    const item = (raw ?? {}) as Json
    const type = item.type ?? (item.role ? 'message' : undefined)
    switch (type) {
      case 'message': {
        const role = item.role
        if (role === 'developer' || role === 'system') {
          const text = messageContent(item.content, false)
          const flat = typeof text === 'string' ? text : ''
          // Chat templates of local models (Qwen's, among others) accept a
          // system message only at the start: the ones before the
          // conversation join it; a later one goes in as a user turn, so the
          // prefix the server has cached stays the same.
          if (messages.length === 0) system.push(flat)
          else messages.push({ role: 'user', content: flat })
        } else if (role === 'assistant') {
          const text = messageContent(item.content, false)
          const flat = typeof text === 'string' ? text : ''
          const last = messages.at(-1)
          if (last?.role === 'assistant' && !last.tool_calls) {
            last.content = `${(last.content as string | null) ?? ''}${flat}`
          } else messages.push({ role: 'assistant', content: flat })
        } else {
          messages.push({ role: 'user', content: messageContent(item.content, true) })
        }
        break
      }
      case 'function_call': {
        const name =
          typeof item.name === 'string'
            ? flatName(item.name, typeof item.namespace === 'string' ? item.namespace : undefined)
            : 'unknown'
        addCall(
          String(item.call_id ?? item.id ?? ''),
          name,
          typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
        )
        break
      }
      case 'custom_tool_call':
        addCall(
          String(item.call_id ?? item.id ?? ''),
          typeof item.name === 'string' ? item.name : 'unknown',
          JSON.stringify({ input: typeof item.input === 'string' ? item.input : '' })
        )
        break
      case 'local_shell_call':
        addCall(
          String(item.call_id ?? item.id ?? ''),
          'local_shell',
          JSON.stringify(item.action ?? {})
        )
        break
      case 'function_call_output':
      case 'custom_tool_call_output':
        messages.push({
          role: 'tool',
          tool_call_id: String(item.call_id ?? ''),
          content: toolOutputText(item.output)
        })
        break
      // reasoning (encrypted, for OpenAI only), compaction, tool_search_*,
      // web_search_call…: nothing a chat endpoint can take.
      default:
        break
    }
  }
  return [
    ...(system.length ? [{ role: 'system' as const, content: system.join('\n\n') }] : []),
    ...pairToolMessages(messages)
  ]
}

/**
 * Chat servers reject a tool call without its result and a result without its
 * call. Codex records an output for each call (an interrupted one gets
 * "aborted"); this only guards against a history that lost one.
 */
function pairToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const results = new Map<string, ChatMessage>()
  for (const message of messages) {
    if (message.role === 'tool') results.set(String(message.tool_call_id), message)
  }
  const out: ChatMessage[] = []
  for (const message of messages) {
    // Each result goes right after its call (below); one without a call is dropped.
    if (message.role === 'tool') continue
    out.push(message)
    const calls = message.role === 'assistant' ? (message.tool_calls as Json[] | undefined) : []
    for (const call of calls ?? []) {
      const id = String(call.id)
      out.push(results.get(id) ?? { role: 'tool', tool_call_id: id, content: 'aborted' })
      results.delete(id)
    }
  }
  return out
}

/**
 * The chat function a Responses `tool_choice` names: a tool inside a
 * `namespace` goes by its flat `<ns>__<name>`, as in `tools`. When the choice
 * carries no namespace, a tool of that name inside exactly one namespace.
 */
function chosenTool(choice: Json, map: ToolMap): string | undefined {
  const name = choice.name as string
  const namespace = typeof choice.namespace === 'string' ? choice.namespace : undefined
  const flat = flatName(name, namespace)
  if (map.has(flat)) return flat
  const matches = [...map].filter(([, origin]) => origin.name === name)
  return matches.length === 1 ? matches[0][0] : undefined
}

/**
 * The chat request for a Responses request. `model` is the card's model —
 * whatever name Codex put in the body. Always streamed (with usage), also for
 * a non-streaming Codex request: the gateway gathers it.
 */
export function toChatRequest(body: Json, model: string): ChatRequest {
  const { tools, map } = translateTools(body.tools)
  const chat: Json = {
    model,
    messages: translateInput(body.instructions, body.input),
    stream: true,
    stream_options: { include_usage: true }
  }
  if (tools.length) {
    chat.tools = tools
    const choice = body.tool_choice
    if (choice === 'auto' || choice === 'none' || choice === 'required') chat.tool_choice = choice
    else if (choice && typeof choice === 'object' && typeof (choice as Json).name === 'string') {
      const named = chosenTool(choice as Json, map)
      // A tool the request does not have would be a 400 upstream: left to the model then.
      if (named) chat.tool_choice = { type: 'function', function: { name: named } }
    }
    if (typeof body.parallel_tool_calls === 'boolean') {
      chat.parallel_tool_calls = body.parallel_tool_calls
    }
  }
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens
  if (typeof body.temperature === 'number') chat.temperature = body.temperature
  if (typeof body.top_p === 'number') chat.top_p = body.top_p
  // `codex exec --output-schema`: Responses `text.format` → chat `response_format`.
  const format = ((body.text ?? {}) as Json).format as Json | undefined
  if (format?.type === 'json_schema' && format.schema) {
    chat.response_format = {
      type: 'json_schema',
      json_schema: {
        name: typeof format.name === 'string' ? format.name : 'output',
        schema: format.schema,
        ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {})
      }
    }
  }
  return { body: chat, tools: map }
}

/** Responses usage from a chat usage object — the upstream's numbers as they are. */
export function toResponsesUsage(usage: unknown): Json | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Json
  const int = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  if (typeof u.prompt_tokens !== 'number' && typeof u.completion_tokens !== 'number') {
    return undefined
  }
  const input = int(u.prompt_tokens)
  const output = int(u.completion_tokens)
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: int((u.prompt_tokens_details as Json | undefined)?.cached_tokens)
    },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: int((u.completion_tokens_details as Json | undefined)?.reasoning_tokens)
    },
    total_tokens: typeof u.total_tokens === 'number' ? int(u.total_tokens) : input + output
  }
}

/** A Responses SSE event: its type and payload. */
export interface ResponsesEvent {
  type: string
  [key: string]: unknown
}

interface PendingCall {
  outputIndex: number
  id: string
  callId: string
  /** `callId` is the server's own (not one made up here). */
  serverId: boolean
  name: string
  args: string
}

/** Whether streamed tool arguments are a whole JSON value (not cut off mid-way). */
function isWholeJson(text: string): boolean {
  if (!text.trim()) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

let idCounter = 0
function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

/**
 * Chat completion chunks in, Responses SSE events out. `push` per upstream
 * chunk, `end` once (`response.completed`, or `response.incomplete` for an
 * answer cut short), or `fail` on an error.
 */
export class ResponsesStream {
  readonly responseId = newId('resp')
  private nextIndex = 0
  private output: Json[] = []
  private message?: { index: number; id: string; text: string }
  private reasoning?: { index: number; id: string; text: string }
  /** Calls being streamed, by a key from their `index` or `id` (see `callKey`). */
  private calls = new Map<string, PendingCall>()
  /** The call an `index` currently points at (a server may reuse an index for a new id). */
  private callByIndex = new Map<number, string>()
  private callById = new Map<string, string>()
  private callSeq = 0
  private lastCallKey?: string
  /** The upstream's `finish_reason`, once a choice carried one. */
  private finishReason?: string
  private usage?: Json
  private createdAt = Math.floor(Date.now() / 1000)

  constructor(
    private readonly model: string,
    private readonly tools: ToolMap
  ) {}

  private base(status: string): Json {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model
    }
  }

  start(): ResponsesEvent[] {
    return [{ type: 'response.created', response: { ...this.base('in_progress'), output: [] } }]
  }

  private closeReasoning(): ResponsesEvent[] {
    const r = this.reasoning
    if (!r) return []
    this.reasoning = undefined
    const item = {
      type: 'reasoning',
      id: r.id,
      summary: [{ type: 'summary_text', text: r.text }]
    }
    this.output[r.index] = item
    return [
      {
        type: 'response.reasoning_summary_text.done',
        item_id: r.id,
        output_index: r.index,
        summary_index: 0,
        text: r.text
      },
      { type: 'response.output_item.done', output_index: r.index, item }
    ]
  }

  private closeMessage(status = 'completed'): ResponsesEvent[] {
    const m = this.message
    if (!m) return []
    this.message = undefined
    const item = {
      type: 'message',
      id: m.id,
      role: 'assistant',
      status,
      content: [{ type: 'output_text', text: m.text, annotations: [] }]
    }
    this.output[m.index] = item
    return [
      {
        type: 'response.output_text.done',
        item_id: m.id,
        output_index: m.index,
        content_index: 0,
        text: m.text
      },
      { type: 'response.output_item.done', output_index: m.index, item }
    ]
  }

  private callItem(call: PendingCall): Json {
    const origin = this.tools.get(call.name)
    if (origin?.kind === 'custom') {
      let input = call.args
      try {
        const parsed = JSON.parse(call.args) as Json
        if (typeof parsed.input === 'string') input = parsed.input
      } catch {
        // Not JSON: the model wrote the raw input — take it as it is.
      }
      return {
        type: 'custom_tool_call',
        id: call.id,
        call_id: call.callId,
        name: origin.name,
        input,
        status: 'completed'
      }
    }
    return {
      type: 'function_call',
      id: call.id,
      call_id: call.callId,
      name: origin?.name ?? call.name,
      ...(origin?.namespace ? { namespace: origin.namespace } : {}),
      arguments: call.args || '{}',
      status: 'completed'
    }
  }

  /**
   * Which streamed call a `tool_calls` fragment continues: the call with its
   * `id`, else the one at its `index` — unless that index comes with a new id
   * (some servers put every parallel call at index 0), and a fragment with an
   * id but no index never joins another id's call (`{"a":1}{"b":2}` of two
   * calls stays two calls). A fragment with neither continues the call before
   * it, or — inside a whole listing (a non-streamed `message`) — is a call.
   */
  private callKey(call: Json, position: number, count: number): string {
    const id = typeof call.id === 'string' && call.id ? call.id : undefined
    const index = typeof call.index === 'number' ? call.index : undefined
    let key: string | undefined
    if (id) {
      key = this.callById.get(id)
      if (!key && index !== undefined) {
        const atIndex = this.callByIndex.get(index)
        const pending = atIndex ? this.calls.get(atIndex) : undefined
        // A call first streamed without an id gets the server's now.
        if (atIndex && pending && !pending.serverId) {
          pending.callId = id
          pending.serverId = true
          key = atIndex
        }
      }
    } else if (index !== undefined) {
      key = this.callByIndex.get(index)
    } else if (count === 1) {
      key = this.lastCallKey
    }
    key ??= `c:${this.callSeq++}:${position}`
    if (id) this.callById.set(id, key)
    if (index !== undefined) this.callByIndex.set(index, key)
    return key
  }

  /** Why the upstream stopped short of a whole answer, in Responses terms (undefined: it did not). */
  private incompleteReason(): string | undefined {
    if (this.finishReason === 'length') return 'max_output_tokens'
    if (this.finishReason === 'content_filter') return 'content_filter'
    return undefined
  }

  /** Whether the upstream said how the answer ended (a `finish_reason` arrived). */
  get finished(): boolean {
    return this.finishReason !== undefined
  }

  push(chunk: Json): ResponsesEvent[] {
    const events: ResponsesEvent[] = []
    if (chunk.usage) this.usage = toResponsesUsage(chunk.usage) ?? this.usage
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Json[]) : []
    const choice = choices[0]
    if (!choice) return events
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      this.finishReason = choice.finish_reason
    }
    // A server that ignored `stream` answers with `message` instead of `delta`.
    const delta = ((choice.delta ?? choice.message ?? {}) as Json) || {}
    const reasoningText =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : ''
    if (reasoningText) {
      if (!this.reasoning) {
        this.reasoning = { index: this.nextIndex++, id: newId('rs'), text: '' }
        events.push(
          {
            type: 'response.output_item.added',
            output_index: this.reasoning.index,
            item: { type: 'reasoning', id: this.reasoning.id, summary: [] }
          },
          {
            type: 'response.reasoning_summary_part.added',
            item_id: this.reasoning.id,
            output_index: this.reasoning.index,
            summary_index: 0,
            part: { type: 'summary_text', text: '' }
          }
        )
      }
      this.reasoning.text += reasoningText
      events.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: this.reasoning.id,
        output_index: this.reasoning.index,
        summary_index: 0,
        delta: reasoningText
      })
    }
    if (typeof delta.content === 'string' && delta.content) {
      events.push(...this.closeReasoning())
      if (!this.message) {
        this.message = { index: this.nextIndex++, id: newId('msg'), text: '' }
        events.push(
          {
            type: 'response.output_item.added',
            output_index: this.message.index,
            item: {
              type: 'message',
              id: this.message.id,
              role: 'assistant',
              status: 'in_progress',
              content: []
            }
          },
          {
            type: 'response.content_part.added',
            item_id: this.message.id,
            output_index: this.message.index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] }
          }
        )
      }
      this.message.text += delta.content
      events.push({
        type: 'response.output_text.delta',
        item_id: this.message.id,
        output_index: this.message.index,
        content_index: 0,
        delta: delta.content
      })
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Json[]) : []
    toolCalls.forEach((raw, position) => {
      const call = (raw ?? {}) as Json
      const fn = (call.function ?? {}) as Json
      const key = this.callKey(call, position, toolCalls.length)
      this.lastCallKey = key
      let pending = this.calls.get(key)
      if (!pending) {
        events.push(...this.closeReasoning())
        pending = {
          outputIndex: this.nextIndex++,
          id: newId('fc'),
          callId: typeof call.id === 'string' && call.id ? call.id : newId('call'),
          serverId: typeof call.id === 'string' && !!call.id,
          name: '',
          args: ''
        }
        this.calls.set(key, pending)
      }
      if (typeof fn.name === 'string' && fn.name && !pending.name) pending.name = fn.name
      if (typeof fn.arguments === 'string') pending.args += fn.arguments
      else if (fn.arguments && typeof fn.arguments === 'object') {
        pending.args += JSON.stringify(fn.arguments)
      }
    })
    return events
  }

  /**
   * The closing events: open items done, then `response.completed` with the
   * usage — or `response.incomplete` when the upstream stopped short
   * (`finish_reason` "length" / "content_filter"). A cut-off answer's tool
   * call whose arguments are not whole JSON is dropped: run as if complete,
   * it would act on half an input.
   */
  end(): ResponsesEvent[] {
    const incomplete = this.incompleteReason()
    const events: ResponsesEvent[] = [
      ...this.closeReasoning(),
      ...this.closeMessage(incomplete ? 'incomplete' : 'completed')
    ]
    for (const call of [...this.calls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (!call.name) continue // a fragment with no tool name: nothing Codex could run
      if (incomplete && !isWholeJson(call.args)) continue
      const item = this.callItem(call)
      this.output[call.outputIndex] = item
      events.push(
        {
          type: 'response.output_item.added',
          output_index: call.outputIndex,
          item: { ...item, status: 'in_progress' }
        },
        { type: 'response.output_item.done', output_index: call.outputIndex, item }
      )
    }
    this.calls.clear()
    this.callByIndex.clear()
    this.callById.clear()
    this.lastCallKey = undefined
    events.push({
      type: incomplete ? 'response.incomplete' : 'response.completed',
      response: this.completedResponse()
    })
    return events
  }

  /** The whole response as one object, for a non-streaming Codex request (call after `end`). */
  completedResponse(): Json {
    const incomplete = this.incompleteReason()
    return {
      ...this.base(incomplete ? 'incomplete' : 'completed'),
      ...(incomplete ? { incomplete_details: { reason: incomplete } } : {}),
      output: this.output.filter(Boolean),
      ...(this.usage ? { usage: this.usage } : {})
    }
  }

  fail(message: string, code = 'server_error'): ResponsesEvent {
    return {
      type: 'response.failed',
      response: { ...this.base('failed'), error: { code, message } }
    }
  }
}

/** An OpenAI-style error body, which Codex prints after the status line. */
export function responsesError(
  message: string,
  type = 'invalid_request_error',
  code?: string
): Json {
  return { error: { message, type, ...(code ? { code } : {}) } }
}
