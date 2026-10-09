import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakePhoneHost } from '../testing/fakeHost.js'
import { PHONE_BLOCKED, PHONE_CAPABILITIES } from './capabilities.js'
import { lanAddresses, pairingUrl } from './pairing.js'
import { PhoneServer, deviceLabel, workspaceIdFor } from './server.js'
import { generatePairingToken, isPairingToken, tokenMatches } from './token.js'
import type { PhoneEvent } from './types.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

let host: FakePhoneHost
let server: PhoneServer
let token: string
let base: string

interface Answer {
  status: number
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null; raw?: string } = {}
): Promise<Answer> {
  const headers: Record<string, string> = {}
  const presented = init.token === undefined ? token : init.token
  if (presented) headers.authorization = `Bearer ${presented}`
  let payload: string | undefined
  if (init.raw !== undefined) payload = init.raw
  else if (init.body !== undefined) payload = JSON.stringify(init.body)
  if (payload !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (payload === undefined ? 'GET' : 'POST'),
    headers,
    ...(payload !== undefined ? { body: payload } : {})
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON.
  }
  return { status: response.status, body, headers: Object.fromEntries(response.headers) }
}

/** Reads SSE frames until `count` data events arrived. */
function readEvents(path: string, count: number): Promise<PhoneEvent[]> {
  return new Promise((resolve, reject) => {
    const events: PhoneEvent[] = []
    const req = httpRequest(`${base}${path}`, (res) => {
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let index: number
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as PhoneEvent)
          if (events.length >= count) {
            req.destroy()
            resolve(events)
            return
          }
        }
      })
      res.on('end', () => resolve(events))
    })
    req.on('error', (error) => {
      if (events.length >= count) resolve(events)
      else reject(error)
    })
    req.end()
  })
}

/** Waits until the server has registered a stream or a held poll (no fixed sleeps). */
async function untilConnected(target: PhoneServer = server): Promise<void> {
  while (target.connectionCount() === 0) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(async () => {
  host = new FakePhoneHost()
  host.agents.push(
    {
      id: A,
      name: 'api-fix',
      harness: 'claude-code',
      workspace: '/code/shop',
      status: 'needs-input',
      running: true,
      detail: 'Allow Bash: npm test?',
      queued: 1
    },
    {
      id: B,
      name: 'reviewer',
      harness: 'codex-cli',
      workspace: '/code/shop',
      status: 'working',
      running: true
    }
  )
  host.screens.set(A, 'line 1\nline 2\nline 3')
  token = generatePairingToken()
  server = new PhoneServer({ host, token, port: 0, pollHoldMs: 300, statePollMs: 50 })
  const { port } = await server.start()
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await server.stop()
})

describe('authentication', () => {
  it('requires the pairing token on every API route', async () => {
    for (const path of ['/api/state', '/api/events', '/api/poll', `/api/agent/${A}/screen`]) {
      expect((await call(path, { token: null })).status).toBe(401)
      expect((await call(path, { token: 'f'.repeat(48) })).status).toBe(401)
    }
    expect(
      (await call(`/api/agent/${A}/prompt`, { body: { text: 'hi' }, token: null })).status
    ).toBe(401)
    expect(host.calls.filter((entry) => entry.kind !== 'screen')).toEqual([])
    expect((await call(`/api/state?t=${token}`, { token: null })).status).toBe(200)
  })

  it('throttles repeated wrong tokens from one address, even with the right one after', async () => {
    const limited = new PhoneServer({ host, token, port: 0, limits: { failures: 3 } })
    const { port } = await limited.start()
    try {
      const url = `http://127.0.0.1:${port}/api/state`
      for (let i = 0; i < 3; i++) {
        expect((await fetch(url, { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
      }
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(429)
    } finally {
      await limited.stop()
    }
  })

  it('rate-limits writes', async () => {
    const limited = new PhoneServer({ host, token, port: 0, limits: { writes: 2 } })
    const { port } = await limited.start()
    try {
      const send = () =>
        fetch(`http://127.0.0.1:${port}/api/agent/${A}/interrupt`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` }
        })
      expect((await send()).status).toBe(202)
      expect((await send()).status).toBe(202)
      expect((await send()).status).toBe(429)
    } finally {
      await limited.stop()
    }
  })

  it('rotating the token cuts off streams and the old token', async () => {
    const stream = readEvents(`/api/events?t=${token}`, 99)
    await untilConnected()
    const old = token
    token = generatePairingToken()
    server.rotateToken(token)
    const events = await stream
    expect(events[0]?.type).toBe('state')
    expect((await call('/api/state', { token: old })).status).toBe(401)
    expect((await call('/api/state')).status).toBe(200)
  })

  it('sends protective headers and no CORS, and serves only the page outside /api', async () => {
    const answer = await call('/api/state')
    expect(answer.headers['referrer-policy']).toBe('no-referrer')
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(answer.headers['x-content-type-options']).toBe('nosniff')
    expect(answer.headers['access-control-allow-origin']).toBeUndefined()
    expect(answer.headers['content-security-policy']).toContain("default-src 'none'")
    expect((await call('/index.html')).status).toBe(404)
    expect((await call('/../../etc/passwd')).status).toBe(404)
    expect((await call('/web/app.js')).status).toBe(404)
    expect((await call('/constructor')).status).toBe(404)
    expect((await call('/app.js', { method: 'POST', body: {} })).status).toBe(405)
  })

  it('serves the phone page without the token, locked down by its CSP', async () => {
    const page = await call('/', { token: null })
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    const csp = String(page.headers['content-security-policy'])
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe')
    expect(String(page.body)).not.toMatch(/<script>|\son[a-z]+=|\sstyle=/i)
    const script = await call('/app.js', { token: null })
    expect(script.headers['content-type']).toContain('text/javascript')
    // Everything from the server goes in as text.
    expect(String(script.body)).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/
    )
    for (const path of ['/app.css', '/manifest.webmanifest', '/icon.svg']) {
      expect((await call(path, { token: null })).status).toBe(200)
    }
  })

  it('can leave the page out', async () => {
    const bare = new PhoneServer({ host, token, port: 0, page: false })
    const { port } = await bare.start()
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404)
    await bare.stop()
  })

  it('compares tokens in constant time and only accepts well-formed ones', () => {
    expect(tokenMatches(token, token)).toBe(true)
    expect(tokenMatches('', token)).toBe(false)
    expect(tokenMatches(token.slice(1), token)).toBe(false)
    expect(tokenMatches('x', '')).toBe(false)
    expect(isPairingToken(token)).toBe(true)
    expect(isPairingToken('abc')).toBe(false)
  })
})

describe('reads', () => {
  it('lists agents grouped into workspaces, with the pending question', async () => {
    const { status, body } = await call('/api/state')
    expect(status).toBe(200)
    const state = body as {
      workspaces: { id: string; name: string; needsInputCount: number; workingCount: number }[]
      agents: { id: string; detail?: string; workspaceId: string }[]
    }
    expect(state.workspaces).toEqual([
      expect.objectContaining({
        id: workspaceIdFor('/code/shop'),
        name: 'shop',
        cardCount: 2,
        needsInputCount: 1,
        workingCount: 1
      })
    ])
    expect(state.agents[0]).toMatchObject({ id: A, detail: 'Allow Bash: npm test?' })
    expect(state.agents[1]).not.toHaveProperty('detail')
    const detail = await call(`/api/workspace/${state.workspaces[0].id}`)
    expect(detail.body).toMatchObject({ groups: [], canvas: { nodes: [], edges: [] } })
    expect(
      (await call(`/api/workspace/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`)).status
    ).toBe(404)
  })

  it('reads the terminal mirror with a capped line count', async () => {
    const { body } = await call(`/api/agent/${A}/screen?lines=2`)
    expect(body).toEqual({
      agentId: A,
      screen: 'line 2\nline 3',
      running: true,
      status: 'needs-input',
      queued: 1
    })
    await call(`/api/agent/${A}/screen?lines=100000`)
    expect(host.calls.at(-1)).toEqual({ kind: 'screen', agentId: A, value: 600 })
    expect((await call(`/api/agent/${B}/screen`)).body).toMatchObject({ screen: '' })
    expect((await call('/api/agent/nope/screen')).status).toBe(404)
  })

  it('lists its capabilities and the blocked ones', async () => {
    const { body } = await call('/api/capabilities')
    expect(body).toEqual({
      capabilities: JSON.parse(JSON.stringify(PHONE_CAPABILITIES)),
      blocked: JSON.parse(JSON.stringify(PHONE_BLOCKED))
    })
  })
})

describe('writes', () => {
  it('sends a prompt, an answer and an interrupt through the host', async () => {
    expect(
      (await call(`/api/agent/${B}/prompt`, { body: { text: '  run the tests ' } })).status
    ).toBe(202)
    expect((await call(`/api/agent/${A}/answer`, { body: { key: 'always' } })).status).toBe(202)
    expect((await call(`/api/agent/${B}/interrupt`, { method: 'POST' })).status).toBe(202)
    expect(host.calls).toEqual([
      { kind: 'submit', agentId: B, value: 'run the tests' },
      { kind: 'answer', agentId: A, value: 'always' },
      { kind: 'interrupt', agentId: B }
    ])
  })

  it('refuses control characters in a prompt and normalizes line endings', async () => {
    for (const text of [
      'hi\u001b[201~rm -rf /',
      'hi\u0003',
      'one\u0008two',
      'x\u007f',
      'x\u009b2J'
    ]) {
      expect((await call(`/api/agent/${B}/prompt`, { body: { text } })).status).toBe(400)
    }
    expect(host.calls).toEqual([])
    const ok = await call(`/api/agent/${B}/prompt`, { body: { text: 'line one\r\nline two\tend' } })
    expect(ok.status).toBe(202)
    expect(host.calls).toEqual([{ kind: 'submit', agentId: B, value: 'line one\nline two\tend' }])
  })

  it('validates what it is sent', async () => {
    expect((await call(`/api/agent/${B}/prompt`, { body: { text: '' } })).status).toBe(400)
    expect(
      (await call(`/api/agent/${B}/prompt`, { body: { text: 'x'.repeat(4001) } })).status
    ).toBe(413)
    expect((await call(`/api/agent/${B}/prompt`, { raw: '{not json' })).status).toBe(400)
    expect((await call(`/api/agent/${B}/prompt`, { raw: '[1]' })).status).toBe(400)
    expect((await call(`/api/agent/${B}/prompt`, { raw: 'x'.repeat(70 * 1024) })).status).toBe(413)
    expect((await call(`/api/agent/${A}/answer`, { body: { key: '\u001b[A' } })).status).toBe(400)
    expect((await call(`/api/agent/${A}/answer`, { body: { key: 'y' } })).status).toBe(400)
    expect((await call(`/api/agent/${A}/screen`, { method: 'POST' })).status).toBe(405)
    expect((await call(`/api/agent/${A}/prompt`)).status).toBe(405)
    expect(host.calls.filter((entry) => entry.kind !== 'screen')).toEqual([])
  })

  it('passes the host refusals through and hides unexpected errors', async () => {
    const busy = await call(`/api/agent/${A}/prompt`, { body: { text: 'hi' } })
    expect(busy).toMatchObject({ status: 409, body: { code: 'busy' } })
    host.agents[1].running = false
    const stopped = await call(`/api/agent/${B}/prompt`, { body: { text: 'hi' } })
    expect(stopped).toMatchObject({ status: 409, body: { code: 'not-running' } })
    host.interrupt = () => {
      throw new Error('secret internals /home/me/.token')
    }
    host.agents[1].running = true
    const broken = await call(`/api/agent/${B}/interrupt`, { method: 'POST' })
    expect(broken.status).toBe(500)
    expect(JSON.stringify(broken.body)).not.toContain('secret')
  })

  it('refuses everything on the blocked list', async () => {
    expect(
      (await call('/api/agent', { body: { workspaceId: 'x', kind: 'shell-bash' } })).status
    ).toBe(403)
    expect((await call('/api/workspace', { body: { name: 'x', path: '/' } })).status).toBe(403)
    expect((await call(`/api/agent/${A}/keys`, { body: { data: 'rm -rf /\r' } })).status).toBe(404)
    expect((await call(`/api/agent/${A}/write`, { body: { data: 'x' } })).status).toBe(404)
    expect((await call('/api/kinds')).body).toEqual({ kinds: [] })
    const routes = new Set(PHONE_CAPABILITIES.map((entry) => entry.path))
    for (const blocked of PHONE_BLOCKED) {
      if (blocked.route) expect(routes.has(blocked.route.split(' ')[1])).toBe(false)
    }
  })
})

describe('events', () => {
  it('streams state, status and needs-you events over SSE', async () => {
    const stream = readEvents(`/api/events?t=${token}`, 3)
    await untilConnected()
    host.emit({ type: 'status', agentId: B, status: 'finished', at: 1 })
    host.emit({ type: 'attention', agentId: A, kind: 'needs-input', detail: 'Allow Edit?', at: 2 })
    const events = await stream
    expect(events[0].type).toBe('state')
    expect(events[1]).toEqual({ type: 'status', agentId: B, status: 'finished', at: 1 })
    expect(events[2]).toEqual({
      type: 'attention',
      agentId: A,
      agentName: 'api-fix',
      workspaceId: workspaceIdFor('/code/shop'),
      workspaceName: 'shop',
      kind: 'needs-input',
      detail: 'Allow Edit?',
      at: 2
    })
  })

  it('pushes a new state when the agent list changes', async () => {
    const stream = readEvents(`/api/events?t=${token}`, 2)
    await untilConnected()
    host.agents.pop()
    host.emit({ type: 'agents-changed' })
    const events = await stream
    expect(events[1].type).toBe('state')
    expect(events[1].type === 'state' && events[1].state.agents).toHaveLength(1)
  })

  it('long-polls: resync first, then holds, then delivers', async () => {
    const first = (await call('/api/poll')).body as { seq: number; events: PhoneEvent[] }
    expect(first.events[0].type).toBe('state')
    const empty = (await call(`/api/poll?since=${first.seq}`)).body as { events: PhoneEvent[] }
    expect(empty.events).toEqual([])
    const held = call(`/api/poll?since=${first.seq}`)
    await untilConnected()
    host.emit({ type: 'status', agentId: A, status: 'working', at: 5 })
    const delivered = (await held).body as { seq: number; events: PhoneEvent[] }
    expect(delivered.events).toEqual([{ type: 'status', agentId: A, status: 'working', at: 5 }])
    const future = (await call('/api/poll?since=99999')).body as { events: PhoneEvent[] }
    expect(future.events[0].type).toBe('state')
  })

  it('does not record events while nobody listens, and unsubscribes on stop', async () => {
    host.emit({ type: 'status', agentId: A, status: 'working' })
    const first = (await call('/api/poll')).body as { seq: number }
    expect(first.seq).toBe(0)
    expect(host.listenerCount()).toBe(1)
    await server.stop()
    expect(host.listenerCount()).toBe(0)
  })
})

describe('pairing', () => {
  it('builds the pairing link and finds LAN addresses', () => {
    expect(pairingUrl({ address: '192.168.1.5', port: 8766 }, 'abc')).toBe(
      'http://192.168.1.5:8766/?t=abc'
    )
    expect(pairingUrl('https://phone.example.com/', 'abc')).toBe('https://phone.example.com/?t=abc')
    expect(
      lanAddresses({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
        wifi: [
          { address: '192.168.1.5', family: 'IPv4', internal: false } as never,
          { address: 'fe80::1', family: 'IPv6', internal: false } as never
        ],
        dead: [{ address: '169.254.3.3', family: 'IPv4', internal: false } as never]
      })
    ).toEqual(['192.168.1.5'])
  })

  it('binds to loopback unless told otherwise', () => {
    expect(server.address().address).toBe('127.0.0.1')
  })
})

describe('connections', () => {
  it('lists who passed the token, with a device label, and forgets them on rotate', async () => {
    expect(server.connections()).toEqual([])
    await call('/api/state', { token: null })
    expect(server.connections()).toEqual([])
    await call('/api/state')
    const [phone] = server.connections()
    expect(phone?.address).toMatch(/127\.0\.0\.1/)
    expect(phone?.device).toBe('node')
    expect(phone?.open).toBe(0)

    const stream = readEvents(`/api/events?t=${token}`, 1)
    await untilConnected()
    expect(server.connections().find((c) => c.device === 'unknown device')?.open).toBe(1)
    await stream
    server.rotateToken(generatePairingToken())
    expect(server.connections()).toEqual([])
  })

  it('tells the host when the set changes', async () => {
    let changes = 0
    const watched = new PhoneServer({
      host,
      token,
      port: 0,
      onConnectionsChange: () => (changes += 1)
    })
    const { port } = await watched.start()
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { authorization: `Bearer ${token}` }
    })
    await response.text()
    expect(changes).toBe(1)
    await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { authorization: `Bearer ${token}` }
    }).then((r) => r.text())
    expect(changes).toBe(1)
    await watched.stop()
    expect(changes).toBe(2)
  })

  it('labels devices without echoing the raw user agent', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('iPhone · Safari')
    expect(
      deviceLabel(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
      )
    ).toBe('Android · Chrome')
    expect(deviceLabel('curl/8.4.0')).toBe('curl')
    expect(deviceLabel(undefined)).toBe('unknown device')
    expect(deviceLabel('\u001b[31mevil')).toBe('unknown device')
  })
})

describe('online (the tunnel listener)', () => {
  let tunnelBase = ''
  const viaTunnel = (
    path: string,
    headers: Record<string, string>,
    key: string | null = token
  ): Promise<Response> =>
    fetch(`${tunnelBase}${path}`, {
      headers: {
        'x-forwarded-proto': 'https',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers
      }
    })

  beforeEach(async () => {
    await server.stop()
    server = new PhoneServer({
      host,
      token,
      port: 0,
      pollHoldMs: 300,
      statePollMs: 50,
      onlineLockout: { attempts: 3, lockMs: 60_000 }
    })
    const { port } = await server.start()
    base = `http://127.0.0.1:${port}`
    tunnelBase = `http://127.0.0.1:${await server.openTunnelOrigin()}`
  })

  it('locks out an internet address after a few wrong tokens, others keep working', async () => {
    const stranger = { 'cf-connecting-ip': '203.0.113.7' }
    for (let i = 0; i < 3; i++) {
      expect((await viaTunnel('/api/state', stranger, 'f'.repeat(48))).status).toBe(401)
    }
    const locked = await viaTunnel('/api/state', stranger)
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
    // The owner's phone, elsewhere on the internet, is not caught by it.
    expect((await viaTunnel('/api/state', { 'cf-connecting-ip': '198.51.100.2' })).status).toBe(200)
    // Neither is anyone on the ordinary port.
    expect((await call('/api/state')).status).toBe(200)
    // Rotating the token starts everyone over.
    token = generatePairingToken()
    server.rotateToken(token)
    expect((await viaTunnel('/api/state', stranger)).status).toBe(200)
  })

  it('believes CF-Connecting-IP only on the tunnel listener', async () => {
    // On the ordinary port the header is just text: three wrong tokens "from" different
    // addresses all land on the socket address, and no lockout applies there.
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) {
      const response = await fetch(`${base}/api/state`, {
        headers: { authorization: `Bearer ${'f'.repeat(48)}`, 'cf-connecting-ip': ip }
      })
      expect(response.status).toBe(401)
    }
    expect((await call('/api/state')).status).toBe(200)
    await call('/api/state')
    const local = server.connections()
    expect(local.every((c) => c.via === undefined && !c.address.startsWith('203.'))).toBe(true)

    await viaTunnel('/api/state', { 'cf-connecting-ip': '198.51.100.9', 'user-agent': 'curl/8' })
    const online = server.connections().find((c) => c.via === 'internet')
    expect(online).toMatchObject({ address: '198.51.100.9', device: 'curl', via: 'internet' })
    // Garbage in the header is not an address.
    await viaTunnel('/api/state', { 'cf-connecting-ip': '<script>' })
    expect(server.connections().some((c) => c.address === '<script>')).toBe(false)
  })

  it('refuses plain http through the tunnel', async () => {
    const plain = await fetch(`${tunnelBase}/api/state`, {
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-proto': 'http' }
    })
    expect(plain.status).toBe(403)
    const visitor = await fetch(`${tunnelBase}/`, {
      headers: { 'cf-visitor': '{"scheme":"http"}' }
    })
    expect(visitor.status).toBe(403)
    const page = await viaTunnel('/', {}, null)
    expect(page.status).toBe(200)
    expect(page.headers.get('strict-transport-security')).toContain('max-age')
  })

  it('closing the tunnel listener cuts off the internet and keeps the local port', async () => {
    await viaTunnel('/api/state', { 'cf-connecting-ip': '198.51.100.9' })
    expect(server.connections().some((c) => c.via === 'internet')).toBe(true)
    expect(server.tunnelOriginPort()).toBeGreaterThan(0)
    await server.closeTunnelOrigin()
    expect(server.tunnelOriginPort()).toBeUndefined()
    expect(server.connections().some((c) => c.via === 'internet')).toBe(false)
    await expect(viaTunnel('/api/state', {})).rejects.toThrow()
    expect((await call('/api/state')).status).toBe(200)
  })
})
