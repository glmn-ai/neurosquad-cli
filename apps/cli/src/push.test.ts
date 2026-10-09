import { describe, expect, it } from 'vitest'
import {
  NtfyPush,
  checkTokenTransport,
  ntfyMessage,
  parseNtfyUrl,
  randomNtfyUrl
} from './daemon/push.js'

describe('ntfy push', () => {
  it('takes https topic URLs, http only on this machine or the local network', () => {
    expect(parseNtfyUrl('https://ntfy.sh/nsq-abc')).toEqual({
      server: 'https://ntfy.sh',
      topic: 'nsq-abc'
    })
    expect(parseNtfyUrl('https://push.example.com/ntfy/team_1')).toEqual({
      server: 'https://push.example.com/ntfy',
      topic: 'team_1'
    })
    expect(parseNtfyUrl('http://192.168.1.5:8080/alerts').server).toBe('http://192.168.1.5:8080')
    expect(() => parseNtfyUrl('http://ntfy.sh/x')).toThrow(/https/)
    expect(() => parseNtfyUrl('https://user:pw@ntfy.sh/x')).toThrow(/token/)
    expect(() => parseNtfyUrl('https://ntfy.sh/')).toThrow(/topic/)
    expect(() => parseNtfyUrl('https://ntfy.sh/x?auth=1')).toThrow(/query/)
    expect(parseNtfyUrl(randomNtfyUrl()).topic).toMatch(/^nsq-[0-9a-f]{24}$/)
  })

  it('sends the name and the question only, without terminal control characters', () => {
    const message = ntfyMessage(
      { server: 'https://ntfy.sh', topic: 't' },
      { agentId: 'a', agentName: 'api-fix', question: 'Allow \u001b[31mBash: rm\u0007?' }
    )
    expect(message).toEqual({
      topic: 't',
      title: 'api-fix needs you',
      message: 'Allow Bash: rm ?',
      priority: 4,
      tags: ['bell']
    })
    const long = ntfyMessage(
      { server: 'https://ntfy.sh', topic: 't' },
      { agentId: 'a', agentName: 'x', question: 'q'.repeat(500) }
    )
    expect(String(long.message).length).toBe(300)
  })

  it('pushes once per question, again after an answer, with the token as a header', async () => {
    const sent: { url: string; init: RequestInit }[] = []
    let now = 1000
    const push = new NtfyPush(
      () => {},
      (async (url: string, init: RequestInit) => {
        sent.push({ url, init })
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
      () => now
    )
    push.target = async () => ({
      target: { server: 'https://ntfy.example', topic: 'nsq-t' },
      token: 'tk_secret'
    })
    const event = { agentId: 'a', agentName: 'api-fix', question: 'Allow Bash: npm test?' }
    expect(await push.needsYou(event)).toBe(true)
    expect(await push.needsYou(event)).toBe(false)
    push.answered('a')
    now += 1000
    expect(await push.needsYou(event)).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.url).toBe('https://ntfy.example')
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tk_secret')
    expect(JSON.parse(String(sent[0]!.init.body)).topic).toBe('nsq-t')
  })

  it('never follows a redirect and keeps the 30 s memory only after a delivery', async () => {
    const inits: RequestInit[] = []
    let ok = false
    const push = new NtfyPush(
      () => {},
      (async (_url: string, init: RequestInit) => {
        inits.push(init)
        return new Response('{}', { status: ok ? 200 : 502 })
      }) as unknown as typeof fetch,
      () => 1000
    )
    push.target = async () => ({ target: { server: 'https://ntfy.example', topic: 'nsq-t' } })
    const event = { agentId: 'a', agentName: 'api-fix', question: 'Allow?' }
    expect(await push.needsYou(event)).toBe(false)
    ok = true
    expect(await push.needsYou(event)).toBe(true) // the failed one did not count as sent
    expect(await push.needsYou(event)).toBe(false)
    expect(inits.every((init) => init.redirect === 'error')).toBe(true)
  })

  it('sends an access token only over https', () => {
    const http = parseNtfyUrl('http://192.168.1.5/nsq-t')
    expect(() => checkTokenTransport(http, 'tk_x')).toThrow(/https/)
    expect(() => checkTokenTransport(http, undefined)).not.toThrow()
    expect(() => checkTokenTransport(parseNtfyUrl('https://ntfy.sh/t'), 'tk_x')).not.toThrow()
    expect(() => checkTokenTransport(parseNtfyUrl('http://127.0.0.1:8080/t'), 'tk_x')).not.toThrow()
  })

  it('an answer during a delivery lets the same question push again', async () => {
    let release: (() => void) | undefined
    let calls = 0
    const push = new NtfyPush(
      () => {},
      (async () => {
        calls++
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve))
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
      () => 1000
    )
    push.target = async () => ({ target: { server: 'https://ntfy.example', topic: 'nsq-t' } })
    const event = { agentId: 'a', agentName: 'api-fix', question: 'Allow?' }
    const first = push.needsYou(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    push.answered('a')
    release?.()
    expect(await first).toBe(true)
    expect(await push.needsYou(event)).toBe(true)
    expect(calls).toBe(2)
  })
})
