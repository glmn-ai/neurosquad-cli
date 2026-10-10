import { describe, expect, it } from 'vitest'
import { OPENROUTER_ATTRIBUTION } from '@neurosquad/core'
import { runOpenRouterTest, testRequests } from './openrouterTest.js'

const KEY = 'sk-or-v1-openrouter-test-key-0000'

/** A stand-in OpenRouter that refuses Messages requests carrying `output_config`, echoing the key. */
function fakeOpenRouter(seen: { url: string; headers: Record<string, string>; body: string }[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body })
    if (body.includes('"output_config"')) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Invalid Anthropic Messages API request',
            code: 400,
            metadata: { issues: [{ path: ['output_config'] }], echo: `Bearer ${KEY}` }
          }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    }
    const events = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'message_stop' }
    ]
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      }
    )
  }) as typeof fetch
}

describe('nsq openrouter test', () => {
  it('Claude Code on a non-Claude model: the plain request passes, the full one is refused and the field named', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = []
    const printed: string[] = []
    const report = await runOpenRouterTest('claude', 'deepseek/deepseek-v4.1-flash', KEY, {
      apiBase: 'http://127.0.0.1:9/api/v1',
      fetch: fakeOpenRouter(seen),
      onResult: (result) => printed.push(result.detail)
    })
    expect(report.ok).toBe(true)
    expect(report.rejected).toEqual(['output_config.effort'])
    expect(report.results[1]!.status).toBe(400)
    expect(report.results[1]!.detail).toContain('Invalid Anthropic Messages API request')
    expect(report.results[1]!.detail).toContain('output_config')
    // The key is sent, never shown.
    expect(printed.join('\n')).not.toContain(KEY)
    expect(printed.join('\n')).toContain('<key>')
    expect(seen[0]!.url).toBe('http://127.0.0.1:9/api/v1/messages?beta=true')
    expect(seen[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(seen[0]!.headers).toMatchObject(OPENROUTER_ATTRIBUTION)
    const plain = JSON.parse(seen[0]!.body) as Record<string, unknown>
    expect(plain['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(plain).not.toHaveProperty('output_config')
    expect(plain).not.toHaveProperty('context_management')
  })

  it('a Claude model gets the full request only; Codex and OpenCode their own APIs', () => {
    const claude = testRequests('claude', 'anthropic/claude-sonnet-5.5', KEY)
    expect(claude).toHaveLength(1)
    expect(claude[0]!.body['thinking']).toMatchObject({ type: 'adaptive' })
    expect(claude[0]!.url).toBe('https://openrouter.ai/api/v1/messages?beta=true')
    expect(testRequests('codex', 'openai/gpt-5.5', KEY)[0]!.url).toBe(
      'https://openrouter.ai/api/v1/responses'
    )
    expect(testRequests('opencode', 'qwen/qwen3-coder', KEY)[0]!.url).toBe(
      'https://openrouter.ai/api/v1/chat/completions'
    )
    // The key only goes to https (or this machine).
    expect(() => testRequests('claude', 'x/y', KEY, 'http://example.com/api/v1')).toThrow(/https/)
  })
})
