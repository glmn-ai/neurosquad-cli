// The connection test against tiny servers in the shape of LM Studio, a
// chat-only server, one that wants a key, one that redirects. Ported from the
// NeuroSquad desktop app's tests.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CustomProviderDraft } from './custom.js'
import { endpointFrom, fetchCustomProviderModels, testCustomProvider } from './customProbe.js'

/** A tiny server in the shape of LM Studio / an Anthropic-compatible API. */
interface Behaviour {
  token?: string
  paths: Record<string, (req: IncomingMessage, res: ServerResponse) => void>
}
const seen: Array<{ method?: string; url?: string; auth?: string; xApiKey?: string }> = []

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function serve(behaviour: Behaviour): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      xApiKey: req.headers['x-api-key'] as string | undefined
    })
    req.resume()
    req.on('end', () => {
      if (behaviour.token && req.headers.authorization !== `Bearer ${behaviour.token}`) {
        return json(res, 401, { error: { message: 'An API token is required' } })
      }
      const handler = behaviour.paths[`${req.method} ${req.url}`]
      if (handler) return handler(req, res)
      json(res, 404, { error: 'Unexpected endpoint or method.' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

const MODELS = {
  object: 'list',
  data: [
    { id: 'qwen/qwen3-coder-30b', object: 'model' },
    { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model' }
  ]
}
const badRequest = (_req: IncomingMessage, res: ServerResponse): void =>
  json(res, 400, { error: { message: "'messages' is required" } })

const servers: Server[] = []
let lmStudio = 0
let chatOnly = 0
let locked = 0
let redirecting = 0
let listOnly = 0

beforeAll(async () => {
  const full = await serve({
    paths: {
      'GET /v1/models': (_req, res) => json(res, 200, MODELS),
      'POST /v1/chat/completions': badRequest,
      'POST /v1/responses': badRequest,
      'POST /v1/messages': badRequest
    }
  })
  const chat = await serve({
    paths: {
      'GET /v1/models': (_req, res) => json(res, 200, MODELS),
      'POST /v1/chat/completions': badRequest
    }
  })
  const auth = await serve({
    token: 'lm-token',
    paths: {
      'GET /v1/models': (_req, res) => json(res, 200, MODELS),
      'POST /v1/chat/completions': badRequest
    }
  })
  const redirect = await serve({
    paths: {
      'GET /v1/models': (_req, res) => {
        res.writeHead(302, { location: 'https://elsewhere.example/v1/models' })
        res.end()
      }
    }
  })
  const list = await serve({
    paths: { 'GET /v1/models': (_req, res) => json(res, 200, MODELS) }
  })
  servers.push(full.server, chat.server, auth.server, redirect.server, list.server)
  listOnly = list.port
  lmStudio = full.port
  chatOnly = chat.port
  locked = auth.port
  redirecting = redirect.port
})

afterAll(() => {
  for (const server of servers) server.close()
})

const draft = (port: number, extra: Partial<CustomProviderDraft> = {}): CustomProviderDraft => ({
  name: 'LM Studio',
  protocol: 'http',
  host: '127.0.0.1',
  port,
  pathPrefix: '',
  ...extra
})

describe('testCustomProvider', () => {
  it('lists the chat models and finds every endpoint the server has', async () => {
    const result = await testCustomProvider(draft(lmStudio), 'k')
    expect(result).toMatchObject({
      ok: true,
      models: [{ id: 'qwen/qwen3-coder-30b' }],
      skippedModels: 1,
      endpoints: { chat: true, responses: true, messages: true }
    })
    // Both APIs' auth, since the test does not know yet which one the server speaks.
    const last = seen.filter((entry) => entry.url === '/v1/messages').at(-1)
    expect(last).toMatchObject({ auth: 'Bearer k', xApiKey: 'k' })
  })

  it('a chat-only server is fine for the OpenAI side; one with no chat endpoint is refused', async () => {
    expect(await testCustomProvider(draft(chatOnly), undefined)).toMatchObject({
      ok: true,
      endpoints: { chat: true, responses: false, messages: false }
    })
    expect(await testCustomProvider(draft(listOnly), undefined)).toMatchObject({
      ok: false,
      kind: 'wrong-format'
    })
  })

  it('needs the key where the server asks for one', async () => {
    expect(await testCustomProvider(draft(locked), undefined)).toMatchObject({
      ok: false,
      kind: 'unauthorized',
      status: 401
    })
    expect(await testCustomProvider(draft(locked), 'wrong')).toMatchObject({
      ok: false,
      kind: 'unauthorized'
    })
    expect(await testCustomProvider(draft(locked), 'lm-token')).toMatchObject({ ok: true })
  })

  it('reports a closed port, a wrong path and a redirect without following it', async () => {
    const closed = await serve({ paths: {} })
    const port = closed.port
    closed.server.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await testCustomProvider(draft(port), undefined)).toMatchObject({
      ok: false,
      kind: 'unreachable'
    })
    expect(
      await testCustomProvider(draft(lmStudio, { pathPrefix: '/api' }), undefined)
    ).toMatchObject({
      ok: false,
      kind: 'not-found'
    })
    expect(await testCustomProvider(draft(redirecting), 'k')).toMatchObject({
      ok: false,
      kind: 'http',
      status: 302
    })
    expect(
      await testCustomProvider(draft(lmStudio, { host: 'http://x' }), undefined)
    ).toMatchObject({
      ok: false,
      kind: 'invalid'
    })
  })
})

describe('endpointFrom', () => {
  it('reads 400/422/401 as there, 404/405/501 as absent, a model-not-found 404 as there', () => {
    expect(endpointFrom({ status: 400, text: '' }, { status: 404 })).toBe(true)
    expect(endpointFrom({ status: 422, text: '' }, { status: 404 })).toBe(true)
    expect(endpointFrom({ status: 404, text: 'Not Found' }, { status: 404 })).toBe(false)
    expect(endpointFrom({ status: 404, text: "model '' not found" }, { status: 404 })).toBe(true)
    expect(endpointFrom({ status: 405, text: '' }, { status: 404 })).toBe(false)
    expect(endpointFrom({ status: 501, text: '' }, { status: 404 })).toBe(false)
    // A server that says 401 to everything: no telling.
    expect(endpointFrom({ status: 401, text: '' }, { status: 401 })).toBeUndefined()
    expect(endpointFrom(undefined, undefined)).toBeUndefined()
  })
})

describe('fetchCustomProviderModels', () => {
  it('the list now, with the key; a readable error otherwise', async () => {
    expect(await fetchCustomProviderModels(draft(locked), 'lm-token')).toEqual([
      { id: 'qwen/qwen3-coder-30b' }
    ])
    await expect(fetchCustomProviderModels(draft(locked), undefined)).rejects.toThrow(/401/)
  })
})
