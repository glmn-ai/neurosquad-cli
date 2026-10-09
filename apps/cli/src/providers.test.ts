// The user's own providers in nsq: the store (no key in the file), the
// `--provider` flag, the daemon's checks, the dashboard's choices, and the
// cost of a request on a custom server ("no price", never a guess).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const secrets = new Map<string, string>()
vi.mock('./daemon/secrets.js', () => ({
  getSecret: async (name: string) => secrets.get(name),
  setSecret: async (name: string, value: string | undefined) => {
    if (value === undefined) secrets.delete(name)
    else secrets.set(name, value)
  }
}))

const home = mkdtempSync(join(tmpdir(), 'nsq-providers-'))
process.env['NSQ_HOME'] = home

const { saveProvider, listProviders, providerKey, removeProvider, providerModels, providerKeyEnv } =
  await import('./providers.js')
const { providerFlag } = await import('./commands.js')
const { checkCustomChoice } = await import('./daemon/customProviders.js')
const { providerChoices } = await import('./tui/providerChoices.js')
const { UsageTracker } = await import('./daemon/usage.js')

const KEY = 'sk-local-test-key-123'
let server: Server
let base = ''
/** Every endpoint, wants the key. */
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: 'key' })
      if (req.method === 'GET' && req.url === '/v1/models')
        return json(200, {
          data: [
            { id: 'qwen3-coder', meta: { n_ctx: 32768 } },
            { id: 'nomic-embed-text' },
            { id: 'llama3.1:8b' }
          ]
        })
      if (req.method === 'POST' && /^\/v1\/(chat\/completions|messages)$/.test(req.url ?? ''))
        return json(400, { error: { message: "'messages' is required" } })
      json(404, { error: 'not found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  rmSync(home, { recursive: true, force: true })
})

describe('the provider store', () => {
  it('a failed test stores nothing; a good one stores the models, the key only in the keyring', async () => {
    const refused = await saveProvider('local', `${base}/v1`, 'keep')
    expect(refused).toMatchObject({ ok: false })
    expect(listProviders()).toEqual([])

    const saved = await saveProvider('Local', `${base}/v1`, { set: KEY })
    expect(saved).toMatchObject({
      ok: true,
      provider: {
        id: 'local',
        pathPrefix: '',
        endpoints: { chat: true, responses: false, messages: true },
        models: [{ id: 'llama3.1:8b' }, { id: 'qwen3-coder', contextWindow: 32768 }]
      }
    })
    expect(readFileSync(join(home, 'providers.json'), 'utf8')).not.toContain(KEY)
    expect(await providerKey('local')).toBe(KEY)
    // A re-test keeps the stored key.
    expect(await saveProvider('local', undefined, 'keep')).toMatchObject({ ok: true })
    // A new address never gets the old address's key: refused here (the server wants one), kept stored.
    expect(
      await saveProvider('local', `http://localhost:${base.split(':').pop()}`, 'keep')
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/wants an API key/)
    })
    expect(await providerKey('local')).toBe(KEY)
  })

  it('names, transport and the environment key', async () => {
    expect(await saveProvider('open router', base, 'keep')).toMatchObject({ ok: false })
    expect(await saveProvider('openrouter', base, 'keep')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/reserved/)
    })
    expect(await saveProvider('far', 'http://api.example.com:8080', 'keep')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/use https/)
    })
    expect(providerKeyEnv('my-box')).toBe('NSQ_PROVIDER_KEY_MY_BOX')
    process.env['NSQ_PROVIDER_KEY_ENVBOX'] = KEY
    try {
      expect(await saveProvider('envbox', base, 'keep')).toMatchObject({ ok: true })
      expect(secrets.has('provider:envbox:api-key')).toBe(false)
    } finally {
      delete process.env['NSQ_PROVIDER_KEY_ENVBOX']
      await removeProvider('envbox')
    }
  })

  it('models are asked now; the stored list when the server is down', async () => {
    expect((await providerModels('local')).models.map((m) => m.id)).toEqual([
      'llama3.1:8b',
      'qwen3-coder'
    ])
    expect(await providerModels('nope')).toMatchObject({
      error: expect.stringMatching(/no provider/)
    })
  })
})

describe('--provider', () => {
  it('openrouter, none, or one of your own', () => {
    expect(providerFlag('openrouter')).toEqual({ provider: 'openrouter' })
    expect(providerFlag('none')).toEqual({ provider: null })
    expect(providerFlag('LMStudio')).toEqual({ provider: 'custom', customProviderId: 'lmstudio' })
    expect(() => providerFlag('../x')).toThrow()
    expect(providerFlag(undefined)).toBeUndefined()
  })
})

describe('the daemon’s checks', () => {
  it('a harness the server cannot serve is refused; a model must be named unless there is one', () => {
    expect(() => checkCustomChoice('codex-cli', 'nope', 'm')).toThrow(/no provider/)
    expect(() => checkCustomChoice('claude-code', 'local', undefined)).toThrow(/which model/)
    expect(checkCustomChoice('claude-code', 'local', 'qwen3-coder')).toMatchObject({
      model: 'qwen3-coder',
      warnings: []
    })
    expect(checkCustomChoice('opencode', 'local', 'other').warnings[0]).toMatch(/did not list/)
    expect(() => checkCustomChoice('codex-cli', 'local', 'x y')).toThrow(/not a model id/)
  })
})

describe('the dashboard’s provider choice', () => {
  it('offers the servers whose API the harness speaks, and says why not the others', () => {
    const chatOnly = {
      ...listProviders()[0]!,
      id: 'chatty',
      name: 'chatty',
      endpoints: { chat: true }
    }
    const claude = providerChoices('claude-code', [...listProviders(), chatOnly])
    expect(claude.choices.map((c) => c.id)).toEqual(['', 'openrouter', 'local'])
    expect(claude.unfit).toEqual([
      { id: 'chatty', reason: expect.stringMatching(/Anthropic Messages API/) }
    ])
    expect(providerChoices('codex-cli', [chatOnly]).choices.map((c) => c.id)).toContain('chatty')
    expect(providerChoices('command').choices.map((c) => c.id)).toEqual([''])
  })
})

describe('cost on a custom server', () => {
  it('Claude Code requests to the server are unpriced even when named like an Anthropic model', () => {
    const tracker = new UsageTracker({})
    const record = {
      id: 'claude:1',
      source: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      at: 1,
      sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      input: 1000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      webSearches: 0
    }
    // An earlier request of the same session, before the move to the server (and one the
    // harness priced itself): unpriced too — nsq cannot tell which server answered it.
    const earlier = { ...record, id: 'claude:0', model: 'claude-opus-4-1', recordedPico: '1000000' }
    ;(tracker as unknown as { records: unknown[] }).records = [record, earlier]
    const agent = {
      id: record.sessionId,
      name: 'a',
      harness: 'claude-code' as const,
      workspace: '.',
      cwd: '.',
      createdAt: 0,
      wantRunning: false
    }
    expect(tracker.costOf(agent).unpricedRequests).toBe(0)
    expect(tracker.costOf(agent).pico > 0n).toBe(true)
    const onServer = tracker.costOf({
      ...agent,
      provider: 'custom',
      customProviderId: 'local',
      model: 'claude-sonnet-4-5'
    })
    expect(onServer.unpricedRequests).toBe(2)
    expect(onServer.pico).toBe(0n)
  })
})
