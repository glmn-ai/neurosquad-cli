// A Responses gateway for Codex on a custom provider that has no
// `/v1/responses` (custom.ts). Codex CLI speaks only the OpenAI Responses API,
// while most local servers — llama.cpp, Ollama, LM Studio, vLLM — and many
// remote ones serve Chat Completions. Such an agent gets a loopback base URL of
// this server; every `POST …/responses` is translated (responsesTranslate.ts)
// into a chat completion on the provider's `/v1/chat/completions` and the
// stream back into Responses events. Ported from the NeuroSquad desktop app
// (main/codex/responsesGateway.ts).
//
// - The provider's key never reaches Codex: Codex's "API key" is a per-agent
//   credential of this server (HMAC of a per-run secret and the agent id,
//   compared in constant time); the host resolves the key per request.
// - The model is the agent's (or the provider's first), whatever Codex names.
// - Usage comes from the upstream's own numbers, never estimated.
// - Nothing Codex sends in its headers (turn metadata, workspace paths) goes
//   upstream, and redirects are never followed (they would take the key along).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createAgentTokens, type AgentTokens } from '../hooks/server.js'
import {
  ResponsesStream,
  responsesError,
  toChatRequest,
  type ResponsesEvent
} from './responsesTranslate.js'

const MAX_BODY = 64 * 1024 * 1024

/** Where one agent's requests go. */
export interface ResponsesGatewayUpstream {
  /** The full chat completions URL (`…/v1/chat/completions`). */
  url: string
  /** The provider's key, if it has one. */
  key?: string
  /** The model every request runs on. */
  model: string
  /** The provider's models (for `GET /models`). */
  models: string[]
  /** Named in error messages. */
  label: string
}

export interface ResponsesGatewayOptions {
  /** The agent's upstream, or an HTTP error to answer (a removed provider, no model). */
  resolve(
    agentId: string
  ):
    | ResponsesGatewayUpstream
    | { status: number; message: string }
    | Promise<ResponsesGatewayUpstream | { status: number; message: string }>
  /** Called for a request that failed inside the gateway (non-fatal). */
  onError?(error: unknown): void
}

export interface ResponsesGateway {
  readonly port: number
  /** What the agent's Codex gets: `base_url` (it appends `/responses`) and its credential. */
  forAgent(agentId: string): { baseUrl: string; key: string }
  close(): Promise<void>
}

/** Starts a gateway on 127.0.0.1 (a free port). */
export function startResponsesGateway(options: ResponsesGatewayOptions): Promise<ResponsesGateway> {
  const tokens = createAgentTokens(randomBytes(32).toString('hex'))
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res, tokens, options.resolve).catch((error: unknown) => {
        options.onError?.(error)
        if (!res.headersSent) send(res, 502, responsesError(String(error), 'server_error'))
        else res.end()
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.off('error', reject)
      resolve({
        port,
        forAgent: (agentId) => ({
          baseUrl: `http://127.0.0.1:${port}/x/${encodeURIComponent(agentId)}/v1`,
          key: tokens.tokenFor(agentId)
        }),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          })
      })
    })
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

class BodyTooLarge extends Error {}

/**
 * The request body, at most MAX_BODY bytes. Past that it rejects with
 * BodyTooLarge and drains the rest unread (destroying the socket would show
 * Codex a broken connection instead of the 413).
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.resume()
      reject(new BodyTooLarge())
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY) {
        tooLarge = true
        chunks.length = 0
        reject(new BodyTooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', reject)
  })
}

function presentedKey(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(\S+)$/.exec(header.trim())
  return match?.[1] ?? ''
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * An upstream HTTP error for Codex. Codex retries 5xx and 429 by itself
 * (`request_max_retries`) and shows anything else at once — so a 4xx stays a
 * 4xx: retrying a request the server rejected would only repeat the error.
 */
async function forwardError(res: ServerResponse, upstream: Response, label: string): Promise<void> {
  const text = await upstream.text().catch(() => '')
  let message = text.slice(0, 2000) || upstream.statusText || `HTTP ${upstream.status}`
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    const inner =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
    if (inner) message = inner
  } catch {
    // Not JSON: the text as is.
  }
  // A redirect is never followed (it would take the provider's key along).
  const status = upstream.status >= 300 && upstream.status < 400 ? 502 : upstream.status
  send(
    res,
    status,
    responsesError(
      `${message} (${label}, via the Responses gateway)`,
      status >= 500 ? 'server_error' : 'invalid_request_error'
    )
  )
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  tokens: AgentTokens,
  resolveUpstream: ResponsesGatewayOptions['resolve']
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const match = /^\/x\/([^/]+)\/v1\/(responses|models)\/?$/.exec(url.pathname)
  if (!match) return send(res, 404, responsesError('Not found'))
  const agentId = decodeURIComponent(match[1])
  if (!sameSecret(presentedKey(req), tokens.tokenFor(agentId))) {
    return send(res, 401, responsesError('nsq gateway: wrong card credential'))
  }
  const resolved = await resolveUpstream(agentId)
  if ('status' in resolved) return send(res, resolved.status, responsesError(resolved.message))
  const target = {
    url: resolved.url,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      // Only the provider's own key — a local server without one gets no header.
      ...(resolved.key ? { authorization: `Bearer ${resolved.key}` } : {})
    },
    model: resolved.model,
    models: resolved.models,
    label: resolved.label
  }

  if (match[2] === 'models') {
    if (req.method !== 'GET') return send(res, 405, responsesError('Method not allowed'))
    const ids = target.models.includes(target.model)
      ? target.models
      : [target.model, ...target.models]
    return send(res, 200, {
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', owned_by: target.label }))
    })
  }
  if (req.method !== 'POST') return send(res, 405, responsesError('Method not allowed'))

  let raw: string
  try {
    raw = await readBody(req)
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      return send(
        res,
        413,
        responsesError(
          `nsq gateway: the request body is over ${MAX_BODY / (1024 * 1024)} MB`,
          'invalid_request_error',
          'request_too_large'
        )
      )
    }
    throw error
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    return send(res, 400, responsesError('nsq gateway: the request body is not JSON'))
  }
  const wantsStream = body.stream === true
  const chat = toChatRequest(body, target.model)
  const abort = new AbortController()
  res.on('close', () => abort.abort())

  let upstream: Response
  try {
    upstream = await fetch(target.url, {
      method: 'POST',
      headers: target.headers,
      // A redirect would take the provider's key wherever it points.
      redirect: 'manual',
      body: JSON.stringify(chat.body),
      signal: abort.signal
    })
  } catch (error) {
    if (abort.signal.aborted) return
    return send(
      res,
      502,
      responsesError(
        `${target.label} is not reachable: ${(error as Error).message}`,
        'server_error'
      )
    )
  }
  if (!upstream.ok) return forwardError(res, upstream, target.label)

  const translator = new ResponsesStream(target.model, chat.tools)
  const emit = (events: ResponsesEvent[]): void => {
    if (!wantsStream) return
    for (const event of events) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
  }
  if (wantsStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  }
  emit(translator.start())

  let streamError: string | undefined
  let sawDone = false
  const contentType = upstream.headers.get('content-type') ?? ''
  try {
    if (!contentType.includes('text/event-stream')) {
      // A server that ignored `stream: true`: one completion object.
      const whole = (await upstream.json()) as Record<string, unknown>
      const error = whole.error as { message?: string } | undefined
      if (error) streamError = error.message ?? 'upstream error'
      else emit(translator.push(whole))
    } else {
      const reader = upstream.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // One SSE event's `data:` lines, joined by "\n" (a server may split a
      // JSON chunk over several), dispatched at the blank line that ends it.
      let eventData: string[] = []
      const dispatch = (): void => {
        if (eventData.length === 0) return
        const data = eventData.join('\n').trim()
        eventData = []
        handleData(data)
      }
      const isWhole = (data: string): boolean => {
        const text = data.trim()
        if (text === '[DONE]') return true
        try {
          JSON.parse(text)
          return true
        } catch {
          return false
        }
      }
      const handleLine = (raw: string): void => {
        const line = raw.replace(/\r$/, '')
        if (line.trim() === '') return dispatch()
        if (!line.startsWith('data:')) return
        // A server that never sends the blank line: a previous data line that
        // is already a whole chunk is an event of its own.
        if (eventData.length > 0 && isWhole(eventData.join('\n'))) dispatch()
        eventData.push(line.slice(5).replace(/^ /, ''))
      }
      const handleData = (data: string): void => {
        if (data === '[DONE]') sawDone = true
        if (!data || data === '[DONE]') return
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(data) as Record<string, unknown>
        } catch {
          return
        }
        // A mid-stream failure arrives as an `error` chunk (OpenRouter, vLLM, llama.cpp).
        const error = chunk.error as { message?: string } | string | undefined
        if (error) {
          streamError =
            (typeof error === 'string' ? error : error.message) ?? `${target.label} stream error`
          return
        }
        emit(translator.push(chunk))
      }
      while (reader) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
          handleLine(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
        }
      }
      // The decoder's last bytes (a character split at the very end), then the last event.
      buffer += decoder.decode()
      if (buffer) handleLine(buffer)
      dispatch()
      // Closed with neither [DONE] nor a finish_reason: the answer was cut off
      // (server crash, dropped connection) — not a whole response to run.
      if (!streamError && !sawDone && !translator.finished) {
        streamError = `${target.label} closed the stream before the answer finished`
      }
    }
  } catch (error) {
    if (abort.signal.aborted) return // Codex went away (interrupt): nothing to tell.
    streamError = `${target.label} stream broke: ${(error as Error).message}`
  }

  if (streamError) {
    const message = `${streamError} (${target.label}, via the Responses gateway)`
    if (wantsStream) {
      emit([translator.fail(message)])
      res.end()
    } else send(res, 502, responsesError(message, 'server_error'))
    return
  }
  const closing = translator.end()
  if (wantsStream) {
    emit(closing)
    res.end()
  } else send(res, 200, translator.completedResponse())
}
