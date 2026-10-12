// A newer client meeting an older daemon: the explanation instead of a bare "unknown request",
// the capability check before asking, and the daemon's version in its "unknown request" reply.
// The client side runs against a fake daemon on this test's own socket (no real daemon).
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CAPABILITIES, LineDecoder, encode, requestCapability } from '../protocol.js'
import { VERSION } from '../version.js'
import {
  DaemonTooOldError,
  capabilityNeeds,
  errorText,
  isUnknownRequest,
  outdatedText,
  versionSupports
} from './outdated.js'

/** A version older than this copy (for "Press U" / `nsq down && nsq up`). */
const OLD = '0.3.0'

describe('outdatedText', () => {
  it('the dashboard: which daemon runs, what this needs, U or wait for the agents', () => {
    const text = outdatedText(OLD, '0.4.0', 'tui')
    expect(text).toBe(
      'The running daemon is nsq 0.3.0; this needs 0.4.0 or newer. Press U to restart it now (agents resume their sessions), or it restarts by itself when agents are free.'
    )
  })

  it('the command line: the command that exists', () => {
    const text = outdatedText(OLD, '0.4.0', 'cli')
    expect(text).toContain('The running daemon is nsq 0.3.0; this needs 0.4.0 or newer.')
    expect(text).toContain('Run `nsq down && nsq up` to restart it now')
    expect(text).not.toContain('Press U')
  })

  it('a daemon that is not older (a dev build, a request it dropped): no restart advice', () => {
    expect(outdatedText('0.5.0', '0.4.0', 'tui')).toBe(
      'The running daemon (nsq 0.5.0) does not know this request.'
    )
  })

  it('an unknown daemon version still explains', () => {
    expect(outdatedText('', '0.4.0', 'tui')).toMatch(
      /^The running daemon is an older nsq; this needs 0\.4\.0/
    )
  })

  it('errorText: the explanation for an outdated daemon, the message otherwise', () => {
    const error = new DaemonTooOldError(OLD, '0.4.0', 'push')
    expect(errorText(error, 'tui')).toContain('Press U')
    expect(error.message).toContain('nsq down && nsq up')
    expect(errorText(new Error('boom'), 'tui')).toBe('boom')
  })

  it('isUnknownRequest: the new error and the old wording', () => {
    expect(isUnknownRequest(new DaemonTooOldError(OLD, '0.4.0', 'push'))).toBe(true)
    expect(isUnknownRequest(new Error('unknown request'))).toBe(true)
    expect(isUnknownRequest(new Error('agent not found'))).toBe(false)
  })
})

describe('capabilities', () => {
  it('a daemon without a list is judged by its version', () => {
    expect(versionSupports('0.3.0', 'push')).toBe(false)
    expect(versionSupports('0.4.0', 'push')).toBe(true)
    expect(versionSupports('0.2.0', 'handover')).toBe(false)
    expect(versionSupports('0.0.0-dev', 'push')).toBe(true)
    expect(versionSupports('', 'push')).toBe(true)
  })

  it('requests that need a capability', () => {
    expect(requestCapability({ t: 'push', action: 'setup' })).toBe('push')
    expect(requestCapability({ t: 'phone', action: 'on', online: true })).toBe('phone.online')
    expect(requestCapability({ t: 'phone', action: 'on', online: false })).toBe('phone')
    expect(requestCapability({ t: 'list' })).toBeUndefined()
    expect(capabilityNeeds('push')).toBe('0.4.0')
    expect(capabilityNeeds(undefined)).toBe(VERSION)
    expect(CAPABILITIES).toContain('push')
  })
})

describe('DaemonClient against an older daemon', () => {
  let home = ''
  let server: Server | null = null
  const previous = process.env['NSQ_HOME']
  /** What the fake daemon received. */
  let received: { t: string }[] = []

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'nsq-outdated-'))
    process.env['NSQ_HOME'] = home
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
    received = []
  })
  afterAll(() => {
    if (previous === undefined) delete process.env['NSQ_HOME']
    else process.env['NSQ_HOME'] = previous
    rmSync(home, { recursive: true, force: true })
  })

  /** A fake daemon: `hello` answered with `hello`, everything else "unknown request" (± version). */
  async function fakeDaemon(hello: Record<string, unknown>, unknown: Record<string, unknown>) {
    const { ipcPath } = await import('../paths.js')
    const ipc = ipcPath(home)
    server = createServer((socket: Socket) => {
      socket.setEncoding('utf8')
      const decoder = new LineDecoder<{ t: string; rid: number }>((message) => {
        received.push(message)
        if (message.t === 'hello')
          socket.write(encode({ t: 'reply', rid: message.rid, ok: true, data: hello }))
        else socket.write(encode({ t: 'reply', rid: message.rid, ok: false, ...unknown }))
      })
      socket.on('data', (chunk: string) => decoder.push(chunk))
    })
    await new Promise<void>((resolve) => server!.listen(ipc, resolve))
    writeFileSync(
      join(home, 'daemon.json'),
      JSON.stringify({ pid: 1, ipc, token: 't', hookPort: 0, version: '9.9.9', startedAt: 0 })
    )
  }

  it('an older daemon (no capability list): push is refused before it is asked, with the explanation', async () => {
    await fakeDaemon({ version: OLD, pid: 42 }, { error: 'unknown request' })
    const { DaemonClient } = await import('./client.js')
    const client = await DaemonClient.open('test', { autostart: false })
    try {
      expect(client.capabilities).toBeNull()
      expect(client.supports('push')).toBe(false)
      expect(client.supports('handover')).toBe(true)
      const error = await client.request({ t: 'push', action: 'setup' }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DaemonTooOldError)
      expect((error as DaemonTooOldError).daemonVersion).toBe(OLD)
      expect((error as DaemonTooOldError).needs).toBe('0.4.0')
      expect(received.map((m) => m.t)).toEqual(['hello'])
    } finally {
      client.close()
    }
  })

  it('"unknown request" from an old daemon becomes the explanation, with the version from its hello', async () => {
    await fakeDaemon({ version: OLD, pid: 42 }, { error: 'unknown request' })
    const { DaemonClient } = await import('./client.js')
    const client = await DaemonClient.open('test', { autostart: false })
    try {
      const error = await client.request({ t: 'cost' }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DaemonTooOldError)
      expect(errorText(error, 'tui')).toMatch(/^The running daemon is nsq 0\.3\.0; this needs /)
      expect(isUnknownRequest(error)).toBe(true)
    } finally {
      client.close()
    }
  })

  it('a daemon with a list is taken at its word; its reply carries its own version', async () => {
    await fakeDaemon(
      { version: '', pid: 42, capabilities: ['phone', 'update', 'handover'] },
      { error: 'unknown request', code: 'unknown-request', daemonVersion: '0.4.1' }
    )
    const { DaemonClient } = await import('./client.js')
    const client = await DaemonClient.open('test', { autostart: false })
    try {
      expect(client.supports('push')).toBe(false)
      expect(client.supports('handover')).toBe(true)
      const error = await client.request({ t: 'cost' }).catch((e: unknown) => e)
      expect((error as DaemonTooOldError).daemonVersion).toBe('0.4.1')
    } finally {
      client.close()
    }
  })
})
