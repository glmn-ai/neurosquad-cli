// The connection test of a custom provider (custom.ts): lists the models and
// finds which of the three endpoints the server has — OpenAI chat completions,
// OpenAI responses, Anthropic messages — whatever it is expected to be.
// Ported from the NeuroSquad desktop app (main/customProviders.ts).
//
// Redirects are never followed (the key would go wherever the server says).
// The key is sent as both APIs' auth at once and never logged.
import { randomUUID } from 'node:crypto'
import {
  customProviderDraftProblem,
  customProviderKeyProblem,
  customProviderModelsUrl,
  customProviderOrigin,
  normalizeCustomProviderDraft,
  parseCustomModels,
  type CustomModel,
  type CustomProviderDraft,
  type CustomProviderEndpoints,
  type CustomProviderTestResult
} from './custom.js'

const LIST_TIMEOUT_MS = 8_000
const PROBE_TIMEOUT_MS = 6_000
export const CUSTOM_PROVIDER_MAX_MODELS = 2000

/**
 * Both APIs' auth at once — the test does not know yet which one the server
 * speaks: OpenAI's Bearer, Anthropic's `x-api-key` + `anthropic-version`.
 */
export function customProviderAuthHeaders(key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': '2023-06-01'
  }
  if (key) {
    headers.authorization = `Bearer ${key}`
    headers['x-api-key'] = key
  }
  return headers
}

function describeFetchError(error: unknown): { kind: 'timeout' | 'unreachable'; error: string } {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { kind: 'timeout', error: 'The server did not answer in time.' }
  }
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause
  const code = cause?.code
  if (code === 'ECONNREFUSED')
    return {
      kind: 'unreachable',
      error: 'Connection refused — is the server running on this port?'
    }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return { kind: 'unreachable', error: 'The host name does not resolve.' }
  const message = cause?.message ?? (error instanceof Error ? error.message : String(error))
  return { kind: 'unreachable', error: code ? `${code}: ${message}` : message }
}

async function readError(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 2000)
    try {
      const json = JSON.parse(text) as {
        error?: { message?: unknown } | string
        message?: unknown
        detail?: unknown
      }
      const message =
        (typeof json.error === 'object' ? json.error?.message : json.error) ??
        json.message ??
        json.detail
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
    } catch {
      // Not JSON.
    }
    return text.trim().slice(0, 300) || response.statusText
  } catch {
    return response.statusText
  }
}

/** `POST {}` with no model — nothing gets loaded. The status, or undefined when it did not answer. */
async function post(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string } | undefined> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    return { status: response.status, text: await readError(response) }
  } catch {
    return undefined
  }
}

/**
 * Does the server have this endpoint? A server that serves it answers
 * 400/422 (or 401 when it wants a key); one that does not answers
 * 404/405/501. `control` is the answer to a path no server has: when the
 * endpoint gets the very same status (a server that says 401 to everything
 * without a key), there is no telling — `undefined`.
 */
export function endpointFrom(
  answer: { status: number; text: string } | undefined,
  control: { status: number } | undefined
): boolean | undefined {
  if (!answer) return undefined
  if (answer.status === 405 || answer.status === 501) return false
  // "model not found" is the endpoint answering; a bare 404 is no endpoint.
  if (answer.status === 404) return /model/i.test(answer.text)
  if (control && control.status === answer.status) return undefined
  return true
}

/** Which of the three endpoints the server has — all probed, whatever it is expected to be. */
export async function probeCustomProviderEndpoints(
  draft: CustomProviderDraft,
  key: string | undefined
): Promise<CustomProviderEndpoints> {
  const headers = customProviderAuthHeaders(key)
  const origin = customProviderOrigin(draft)
  const [control, chat, responses, messages] = await Promise.all([
    post(`${origin}/v1/neurosquad-probe-${randomUUID().slice(0, 8)}`, headers),
    post(`${origin}/v1/chat/completions`, headers),
    post(`${origin}/v1/responses`, headers),
    post(`${origin}/v1/messages`, headers)
  ])
  const endpoints: CustomProviderEndpoints = {}
  const found = {
    chat: endpointFrom(chat, control),
    responses: endpointFrom(responses, control),
    messages: endpointFrom(messages, control)
  }
  for (const [name, value] of Object.entries(found)) {
    if (value !== undefined) endpoints[name as keyof CustomProviderEndpoints] = value
  }
  return endpoints
}

/** Lists the models and checks the endpoints. Never throws. */
export async function testCustomProvider(
  input: unknown,
  key: string | undefined
): Promise<CustomProviderTestResult> {
  const problem = customProviderDraftProblem(input)
  if (problem) return { ok: false, kind: 'invalid', error: problem }
  const draft = normalizeCustomProviderDraft(input as CustomProviderDraft)
  if (key) {
    const keyProblem = customProviderKeyProblem(key)
    if (keyProblem) return { ok: false, kind: 'invalid', error: keyProblem }
  }
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(customProviderModelsUrl(draft), {
      headers: customProviderAuthHeaders(key),
      redirect: 'manual',
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS)
    })
  } catch (error) {
    return { ok: false, ...describeFetchError(error) }
  }
  const latencyMs = Date.now() - started
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      kind: 'unauthorized',
      status: response.status,
      error: key
        ? `The server rejected the key: ${await readError(response)}`
        : `The server wants an API key: ${await readError(response)}`
    }
  }
  if (response.status >= 300 && response.status < 400) {
    // Not followed: the key would go wherever the server says.
    return {
      ok: false,
      kind: 'http',
      status: response.status,
      error: `The server redirects to ${response.headers.get('location') ?? 'another address'} — enter that address instead.`
    }
  }
  if (response.status === 404) {
    return {
      ok: false,
      kind: 'not-found',
      status: 404,
      error: `No model list at ${customProviderModelsUrl(draft)}.`
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      kind: 'http',
      status: response.status,
      error: `HTTP ${response.status}: ${await readError(response)}`
    }
  }
  let parsed: ReturnType<typeof parseCustomModels>
  try {
    parsed = parseCustomModels(await response.json())
  } catch {
    parsed = undefined
  }
  if (!parsed) {
    return {
      ok: false,
      kind: 'bad-response',
      error: 'The server answered, but not with a model list.'
    }
  }

  const endpoints = await probeCustomProviderEndpoints(draft, key)
  if (endpoints.chat !== true && endpoints.messages !== true && endpoints.responses !== true) {
    return {
      ok: false,
      kind: 'wrong-format',
      error:
        'The server lists models but answers none of the OpenAI chat (/v1/chat/completions), OpenAI responses (/v1/responses) and Anthropic (/v1/messages) endpoints.'
    }
  }
  return {
    ok: true,
    models: parsed.models.slice(0, CUSTOM_PROVIDER_MAX_MODELS),
    skippedModels: parsed.skipped,
    endpoints,
    latencyMs
  }
}

/** The provider's model list now (`GET /v1/models`). Throws with a readable reason. */
export async function fetchCustomProviderModels(
  draft: CustomProviderDraft,
  key: string | undefined
): Promise<CustomModel[]> {
  let response: Response
  try {
    response = await fetch(customProviderModelsUrl(draft), {
      headers: customProviderAuthHeaders(key),
      redirect: 'manual',
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(describeFetchError(error).error, { cause: error })
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await readError(response)}`)
  const parsed = parseCustomModels(await response.json().catch(() => undefined))
  if (!parsed) throw new Error('The server answered, but not with a model list.')
  return parsed.models.slice(0, CUSTOM_PROVIDER_MAX_MODELS)
}
