import { describe, expect, it } from 'vitest'
import { NtfyPush, ntfyMessage, parseNtfyUrl, randomNtfyUrl } from './daemon/push.js'

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
})
