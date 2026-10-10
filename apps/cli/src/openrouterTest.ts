// `nsq openrouter test <model> [--harness claude|codex|opencode]`: one small request to OpenRouter
// the way the harness sends it through nsq's recipe — same endpoint, headers and body shape, the
// stored key — and OpenRouter's own answer printed in full. The harnesses show only a summary
// ("API Error: 400 Invalid Anthropic Messages API request"); OpenRouter's JSON says which field
// it rejected. The key is never printed.
//
// For Claude Code with a model that is not Claude's, it also sends the full request Claude Code
// makes on its own (what nsq 0.2.0 and earlier let through) and, when that is refused, each of
// its extras alone on top of the plain request — so the answer names the field.
import { randomUUID } from 'node:crypto'
import {
  CLAUDE_CODE_PLAIN_MESSAGES,
  OPENROUTER_API,
  OPENROUTER_ATTRIBUTION,
  checkedApiBase,
  isAnthropicSlug,
  normalizeModelId
} from '@neurosquad/core'

export type TestHarness = 'claude' | 'codex' | 'opencode'

export interface TestRequest {
  label: string
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface TestResult {
  request: TestRequest
  status: number
  ok: boolean
  /** OpenRouter's answer: the error JSON, or what the stream said (text, an error event). */
  detail: string
}

const PROMPT = 'Reply with the single word OK.'
const SYSTEM = 'You are a coding assistant. Keep answers short.'
/** The Messages betas Claude Code 2.1.296 sends with everything on. */
const CLAUDE_FULL_BETAS = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'mid-conversation-tool-changes-2026-07-01',
  'effort-2025-11-24'
]
/** What it sends with nsq's plain-request switches (CLAUDE_CODE_PLAIN_MESSAGES). */
const CLAUDE_PLAIN_BETAS = ['claude-code-20250219', 'interleaved-thinking-2025-05-14']

const READ_TOOL_SCHEMA = {
  type: 'object',
  properties: { file_path: { type: 'string', description: 'The file to read' } },
  required: ['file_path'],
  additionalProperties: false
}

/** Claude Code's extras over the plain Messages request, each one on its own. */
export const CLAUDE_EXTRAS: readonly {
  name: string
  betas: string[]
  apply: (body: Record<string, unknown>) => void
}[] = [
  {
    name: 'thinking: adaptive',
    betas: [],
    apply: (body) => {
      body['thinking'] = { type: 'adaptive' }
    }
  },
  {
    name: 'thinking.display: omitted',
    betas: [],
    apply: (body) => {
      body['thinking'] = { type: 'adaptive', display: 'omitted' }
    }
  },
  {
    name: 'output_config.effort',
    betas: ['effort-2025-11-24'],
    apply: (body) => {
      body['output_config'] = { effort: 'high' }
    }
  },
  {
    name: 'context_management',
    betas: ['context-management-2025-06-27'],
    apply: (body) => {
      body['context_management'] = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }
    }
  },
  {
    name: 'a mid-conversation role: "system" message',
    betas: ['mid-conversation-system-2026-04-07'],
    apply: (body) => {
      const messages = body['messages'] as unknown[]
      messages.push({
        role: 'system',
        content: [{ type: 'text', text: 'Context: a test.', cache_control: { type: 'ephemeral' } }]
      })
    }
  },
  {
    name: 'the anthropic-beta values of the full request',
    betas: CLAUDE_FULL_BETAS,
    apply: () => {}
  }
]

function attribution(): Record<string, string> {
  return { ...OPENROUTER_ATTRIBUTION }
}

/** The plain Messages body Claude Code sends with nsq's switches (a fixed thinking budget). */
function claudePlainBody(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: READ_TOOL_SCHEMA }],
    metadata: { user_id: JSON.stringify({ session_id: randomUUID() }) },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    stream: true
  }
}

function claudeRequest(
  label: string,
  base: string,
  key: string,
  body: Record<string, unknown>,
  betas: string[]
): TestRequest {
  return {
    label,
    // Claude Code: ANTHROPIC_BASE_URL (…/api) + /v1/messages?beta=true.
    url: `${base}/messages?beta=true`,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': [...new Set(betas)].join(','),
      'x-app': 'cli',
      ...attribution()
    },
    body
  }
}

/** The full Claude Code request: every extra at once. */
function claudeFull(model: string, base: string, key: string): TestRequest {
  const body = claudePlainBody(model)
  for (const extra of CLAUDE_EXTRAS) extra.apply(body)
  return claudeRequest(
    'Claude Code’s full request (what nsq 0.2.0 and earlier let through)',
    base,
    key,
    body,
    CLAUDE_FULL_BETAS
  )
}

/** The requests `nsq openrouter test` sends first, for one harness. */
export function testRequests(
  harness: TestHarness,
  model: string,
  key: string,
  apiBase: string = OPENROUTER_API
): TestRequest[] {
  const base = checkedApiBase(apiBase)
  switch (harness) {
    case 'claude':
      if (isAnthropicSlug(model)) return [claudeFull(model, base, key)]
      return [
        claudeRequest(
          `as nsq runs Claude Code on it (${Object.keys(CLAUDE_CODE_PLAIN_MESSAGES).join(', ')})`,
          base,
          key,
          claudePlainBody(model),
          CLAUDE_PLAIN_BETAS
        ),
        claudeFull(model, base, key)
      ]
    case 'codex':
      return [
        {
          label: 'as Codex sends it (Responses API)',
          url: `${base}/responses`,
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            ...attribution()
          },
          body: {
            model,
            instructions: SYSTEM,
            input: [
              { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] }
            ],
            tools: [
              {
                type: 'function',
                name: 'read_file',
                description: 'Read a file',
                strict: false,
                parameters: READ_TOOL_SCHEMA
              }
            ],
            tool_choice: 'auto',
            parallel_tool_calls: false,
            reasoning: { effort: 'medium', summary: 'auto' },
            store: false,
            stream: true,
            include: ['reasoning.encrypted_content'],
            prompt_cache_key: randomUUID()
          }
        }
      ]
    case 'opencode':
      return [
        {
          label: 'as OpenCode sends it (Chat Completions)',
          url: `${base}/chat/completions`,
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            ...attribution()
          },
          body: {
            model,
            max_tokens: 2048,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: PROMPT }
            ],
            tools: [
              {
                type: 'function',
                function: { name: 'read', description: 'Read a file', parameters: READ_TOOL_SCHEMA }
              }
            ],
            stream: true,
            stream_options: { include_usage: true }
          }
        }
      ]
  }
}

/** One extra of the full Claude Code request on top of the plain one. */
export function claudeExtraRequest(
  model: string,
  key: string,
  extra: (typeof CLAUDE_EXTRAS)[number],
  apiBase: string = OPENROUTER_API
): TestRequest {
  const body = claudePlainBody(model)
  extra.apply(body)
  return claudeRequest(`+ ${extra.name}`, checkedApiBase(apiBase), key, body, [
    ...CLAUDE_PLAIN_BETAS,
    ...extra.betas
  ])
}

/** Never let the key into what is printed (an echo in an error body, say). */
export function redact(text: string, key: string): string {
  return key ? text.split(key).join('<key>') : text
}

/** What a streamed answer said: its text, or an error event in it. */
function streamDetail(text: string): { ok: boolean; detail: string } {
  let said = ''
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    if (event['error'] || event['type'] === 'error' || event['type'] === 'response.failed') {
      return { ok: false, detail: JSON.stringify(event, null, 2) }
    }
    const delta = event['delta'] as Record<string, unknown> | undefined
    const choice = (event['choices'] as Record<string, unknown>[] | undefined)?.[0]
    const piece =
      (typeof delta?.['text'] === 'string' ? delta['text'] : undefined) ??
      (event['type'] === 'response.output_text.delta' && typeof event['delta'] === 'string'
        ? event['delta']
        : undefined) ??
      ((choice?.['delta'] as Record<string, unknown> | undefined)?.['content'] as
        string | undefined)
    if (typeof piece === 'string') said += piece
  }
  return { ok: true, detail: said.trim() ? `answered: ${said.trim().slice(0, 200)}` : 'answered' }
}

export async function sendTest(
  request: TestRequest,
  fetchImpl: typeof fetch = fetch
): Promise<TestResult> {
  const key = (request.headers['authorization'] ?? '').replace(/^Bearer /, '')
  let response: Response
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(120_000)
    })
  } catch (error) {
    return { request, status: 0, ok: false, detail: redact(`no answer: ${String(error)}`, key) }
  }
  const text = await response.text().catch((error: unknown) => `(unreadable: ${String(error)})`)
  if (!response.ok) {
    let detail = text
    try {
      detail = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // not JSON: as it came
    }
    return { request, status: response.status, ok: false, detail: redact(detail, key) }
  }
  const streamed = streamDetail(text)
  return { request, status: response.status, ok: streamed.ok, detail: redact(streamed.detail, key) }
}

export interface TestReport {
  results: TestResult[]
  /** Claude Code's extras OpenRouter refused on their own (when the full request was refused). */
  rejected: string[]
  /** The request nsq makes now went through. */
  ok: boolean
}

/** Sends the requests (and, for a refused full Claude Code request, each extra alone). */
export async function runOpenRouterTest(
  harness: TestHarness,
  modelInput: string,
  key: string,
  options: { apiBase?: string; fetch?: typeof fetch; onResult?: (result: TestResult) => void } = {}
): Promise<TestReport> {
  const model = normalizeModelId(modelInput)
  if (!model) throw new Error(`not a model id: ${modelInput}`)
  const results: TestResult[] = []
  const send = async (request: TestRequest): Promise<TestResult> => {
    const result = await sendTest(request, options.fetch)
    results.push(result)
    options.onResult?.(result)
    return result
  }
  const requests = testRequests(harness, model, key, options.apiBase)
  const first = await send(requests[0]!)
  const rejected: string[] = []
  if (requests.length > 1) {
    const full = await send(requests[1]!)
    if (!full.ok && first.ok) {
      for (const extra of CLAUDE_EXTRAS) {
        const alone = await send(claudeExtraRequest(model, key, extra, options.apiBase))
        if (!alone.ok) rejected.push(extra.name)
      }
    }
  }
  return { results, rejected, ok: first.ok }
}
