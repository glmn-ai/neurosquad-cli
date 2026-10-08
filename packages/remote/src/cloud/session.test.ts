import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeCloud, type FakeCloud } from '../testing/fakeCloud.js'
import { CloudHttp, CloudNetworkError } from './http.js'
import { acceptableOrigin, resolveCloudOrigins, safeVerifyUrl } from './origin.js'
import {
  CloudSession,
  LoginError,
  SessionExpiredError,
  SignedOutError,
  cloudPlatform,
  sanitizeDeviceName,
  type DeviceCode
} from './session.js'
import { FileSessionStore, MemorySessionStore } from './store.js'
import { KeyringUnavailableError, KeyringVault, MemoryVault, type TokenVault } from './vault.js'

const device = { deviceName: 'test-box', platform: 'linux', appVersion: '0.1.0' }
/** No real waiting in tests: the poll loop runs as fast as the fake answers. */
const instantSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
  signal?.aborted ? Promise.reject(signal.reason) : new Promise((resolve) => setImmediate(resolve))

let cloud: FakeCloud
let vault: MemoryVault
let store: MemorySessionStore
let clock: number

function makeSession(overrides: { vault?: TokenVault; graceMs?: number } = {}): CloudSession {
  return new CloudSession({
    http: new CloudHttp(cloud.origin, cloud.origin),
    vault: overrides.vault ?? vault,
    store,
    device,
    now: () => clock,
    sleep: instantSleep,
    ...(overrides.graceMs !== undefined ? { graceMs: overrides.graceMs } : {})
  })
}

/** Signs in through the device flow, approving the code as the web panel would. */
async function signIn(session: CloudSession, email = 'dev@example.com'): Promise<DeviceCode> {
  let shown: DeviceCode | undefined
  await session.login({
    onCode: (code) => {
      shown = code
      cloud.approve(code.userCode, email)
    }
  })
  return shown!
}

beforeEach(async () => {
  cloud = await startFakeCloud()
  vault = new MemoryVault()
  store = new MemorySessionStore()
  clock = Date.now()
})

afterEach(async () => {
  await cloud.close()
})

describe('device sign-in', () => {
  it('signs in, keeps tokens only in the vault and the user in the store', async () => {
    const session = makeSession()
    expect(await session.status()).toEqual({ state: 'signed-out', reason: 'signed-out' })
    const code = await signIn(session)
    expect(code.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(code.verifyUrl.startsWith(cloud.origin)).toBe(true)
    const status = await session.status()
    expect(status).toMatchObject({ state: 'signed-in', user: { email: 'dev@example.com' } })
    expect(vault.has(cloud.origin)).toBe(true)
    const persisted = JSON.stringify(store.read())
    const tokens = await vault.load(cloud.origin)
    expect(persisted).not.toContain(tokens!.accessToken)
    expect(persisted).not.toContain(tokens!.refreshToken)
    const start = cloud.requests.find((request) => request.path === '/device/start')
    expect(start?.body).toMatchObject({
      installId: store.read().installId,
      deviceName: 'test-box',
      platform: 'linux',
      appVersion: '0.1.0'
    })
  })

  it('waits while pending and survives an unreachable poll', async () => {
    const session = makeSession()
    const pending: boolean[] = []
    let code = ''
    let polls = 0
    const done = session.login({
      onCode: (shown) => {
        code = shown.userCode
      },
      onPending: ({ offline }) => {
        pending.push(offline)
        polls += 1
        if (polls === 2) cloud.failNext('/device/poll', 503)
        if (polls === 3) cloud.approve(code)
      }
    })
    await expect(done).resolves.toMatchObject({ state: 'signed-in' })
    expect(pending).toEqual([false, false, true])
  })

  it('reports denial, expiry, rate limits and an unreachable cloud', async () => {
    const session = makeSession()
    await expect(
      session.login({ onCode: (code) => cloud.deny(code.userCode) })
    ).rejects.toMatchObject({ code: 'denied' })

    const expiring = makeSession()
    await expect(
      expiring.login({
        onCode: () => {
          clock += 11 * 60_000
        }
      })
    ).rejects.toMatchObject({ code: 'expired' })

    cloud.failNext('/device/start', 429, 1, 'RATE_LIMITED')
    await expect(makeSession().login({ onCode: () => undefined })).rejects.toMatchObject({
      code: 'rate-limited'
    })

    cloud.down = true
    await expect(makeSession().login({ onCode: () => undefined })).rejects.toMatchObject({
      code: 'offline'
    })
    expect(await session.status()).toEqual({ state: 'signed-out', reason: 'signed-out' })
  })

  it('slows down on 429 from poll', async () => {
    const delays: number[] = []
    const session = new CloudSession({
      http: new CloudHttp(cloud.origin, cloud.origin),
      vault,
      store,
      device,
      now: () => clock,
      sleep: (ms) => {
        delays.push(ms)
        return new Promise((resolve) => setImmediate(resolve))
      }
    })
    let code = ''
    await session.login({
      onCode: (shown) => {
        code = shown.userCode
        cloud.failNext('/device/poll', 429, 1, 'RATE_LIMITED')
      },
      onPending: () => cloud.approve(code)
    })
    expect(delays[0]).toBe(1000)
    expect(delays[1]).toBeGreaterThanOrEqual(6000)
  })

  it('can be cancelled', async () => {
    const controller = new AbortController()
    const session = makeSession()
    const done = session.login({
      signal: controller.signal,
      onCode: () => undefined,
      onPending: () => controller.abort()
    })
    await expect(done).rejects.toBeInstanceOf(LoginError)
    await expect(done).rejects.toMatchObject({ code: 'aborted' })
  })

  it('refuses a verify link that is neither https nor loopback http', () => {
    expect(
      safeVerifyUrl('https://app.neurosquad.ai/connect?code=X', 'https://app.neurosquad.ai')
    ).toBe('https://app.neurosquad.ai/connect?code=X')
    expect(
      safeVerifyUrl('http://evil.example/connect', 'https://app.neurosquad.ai')
    ).toBeUndefined()
    expect(safeVerifyUrl('file:///etc/passwd', 'https://app.neurosquad.ai')).toBeUndefined()
    expect(safeVerifyUrl('javascript:alert(1)', 'https://app.neurosquad.ai')).toBeUndefined()
  })

  it('does not stay half signed in when the keyring refuses the tokens', async () => {
    const broken: TokenVault = {
      load: async () => undefined,
      save: async () => {
        throw new KeyringUnavailableError(new Error('no secret service'))
      },
      clear: async () => undefined
    }
    const session = makeSession({ vault: broken })
    await expect(signIn(session)).rejects.toBeInstanceOf(KeyringUnavailableError)
    expect(store.read().sessions).toEqual({})
    expect(cloud.liveFamilies()).toEqual([])
  })
})

describe('tokens', () => {
  it('refreshes an expired access token once for concurrent calls (single-flight)', async () => {
    const session = makeSession()
    await signIn(session)
    clock += 2 * 3600_000
    const answers = await Promise.all([
      session.authorized({ method: 'GET', path: '/me' }),
      session.authorized({ method: 'GET', path: '/me' }),
      session.authorized({ method: 'GET', path: '/me' })
    ])
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
    expect(cloud.requests.filter((request) => request.path === '/auth/refresh')).toHaveLength(1)
    expect(cloud.liveFamilies()).toHaveLength(1)
  })

  it('a lost refresh answer is retried with the same token and stays signed in', async () => {
    const session = makeSession()
    await signIn(session)
    clock += 2 * 3600_000
    cloud.loseNextAnswer('/auth/refresh')
    await expect(session.refresh()).rejects.toBeInstanceOf(CloudNetworkError)
    expect(await session.verify()).toMatchObject({ state: 'signed-in' })
    expect(cloud.liveFamilies()).toHaveLength(1)
  })

  it('retries once after a 401 with a refreshed token', async () => {
    const session = makeSession()
    await signIn(session)
    cloud.expireAccessTokens()
    const answer = await session.authorized({ method: 'GET', path: '/me' })
    expect(answer.status).toBe(200)
  })

  it('stays signed in on network errors and 5xx, offline until the grace ends', async () => {
    const session = makeSession({ graceMs: 1000 * 60 })
    await signIn(session)
    clock += 2 * 3600_000
    cloud.down = true
    await expect(session.authorized({ method: 'GET', path: '/me' })).rejects.toBeInstanceOf(
      CloudNetworkError
    )
    cloud.down = false
    cloud.failNext('/auth/refresh', 502)
    await expect(session.refresh()).rejects.toBeInstanceOf(CloudNetworkError)
    cloud.failNext('/auth/refresh', 403, 1, 'FORBIDDEN')
    await expect(session.refresh()).rejects.toBeInstanceOf(CloudNetworkError)
    expect(vault.has(cloud.origin)).toBe(true)
    // Past the grace: reported, but the tokens stay so the session can come back.
    const status = await session.status()
    expect(status).toEqual({ state: 'signed-out', reason: 'grace-expired' })
    expect(await session.verify()).toMatchObject({ state: 'signed-in' })
  })

  it('reports offline with the end of the grace while it lasts', async () => {
    const session = makeSession()
    await signIn(session)
    cloud.down = true
    const status = await session.verify()
    expect(status).toMatchObject({ state: 'signed-in', offline: true })
    expect(status.state === 'signed-in' && status.graceEndsAt).toBeGreaterThan(clock)
    cloud.down = false
    expect(await session.verify()).toEqual(expect.not.objectContaining({ offline: true }))
  })

  it('ends the session only on the cloud saying 401 to a refresh', async () => {
    const session = makeSession()
    await signIn(session)
    clock += 2 * 3600_000
    cloud.failNext('/auth/refresh', 401, 1, 'UNAUTHORIZED')
    await expect(session.authorized({ method: 'GET', path: '/me' })).rejects.toBeInstanceOf(
      SessionExpiredError
    )
    expect(vault.has(cloud.origin)).toBe(false)
    expect(await session.status()).toEqual({ state: 'signed-out', reason: 'signed-out' })
    await expect(session.authorized({ method: 'GET', path: '/me' })).rejects.toBeInstanceOf(
      SignedOutError
    )
  })

  it('verify() says session-expired after a revocation on the web panel', async () => {
    const session = makeSession()
    await signIn(session)
    for (const family of cloud.liveFamilies()) cloud.revokedFamilies.add(family)
    expect(await session.verify()).toEqual({ state: 'signed-out', reason: 'session-expired' })
  })

  it('binds the session to its API origin', async () => {
    const session = makeSession()
    await signIn(session)
    const other = new CloudSession({
      http: new CloudHttp('https://api.example.invalid', 'https://app.example.invalid'),
      vault,
      store,
      device,
      now: () => clock
    })
    expect(await other.status()).toEqual({ state: 'signed-out', reason: 'signed-out' })
    await expect(other.authorized({ method: 'GET', path: '/me' })).rejects.toBeInstanceOf(
      SignedOutError
    )
  })

  it('reports an unreadable keyring instead of throwing', async () => {
    const session = makeSession()
    await signIn(session)
    const locked = makeSession({
      vault: {
        load: async () => {
          throw new KeyringUnavailableError(new Error('locked'))
        },
        save: async () => undefined,
        clear: async () => undefined
      }
    })
    expect(await locked.status()).toEqual({ state: 'signed-out', reason: 'keyring-unavailable' })
  })
})

describe('sign-out', () => {
  it('forgets the session locally and revokes it on the server', async () => {
    const session = makeSession()
    await signIn(session)
    await session.logout()
    expect(vault.has(cloud.origin)).toBe(false)
    expect(store.read().sessions).toEqual({})
    expect(cloud.liveFamilies()).toEqual([])
    expect(await session.status()).toEqual({ state: 'signed-out', reason: 'signed-out' })
  })

  it('rotates once to revoke when the access token has expired', async () => {
    const session = makeSession()
    await signIn(session)
    clock += 2 * 3600_000
    await session.logout()
    expect(cloud.liveFamilies()).toEqual([])
  })

  it('forgets the session even when the cloud is down', async () => {
    const session = makeSession()
    await signIn(session)
    cloud.down = true
    await session.logout()
    expect(vault.has(cloud.origin)).toBe(false)
    expect(store.read().sessions).toEqual({})
  })

  it('drops a refresh answer that arrives after sign-out, and still revokes it', async () => {
    const session = makeSession()
    await signIn(session)
    clock += 2 * 3600_000
    const refreshing = session.refresh().catch((error: unknown) => error)
    await session.logout()
    await refreshing
    expect(vault.has(cloud.origin)).toBe(false)
    expect(store.read().sessions).toEqual({})
    expect(cloud.liveFamilies()).toEqual([])
  })

  it('a new sign-in on the same install replaces the old session', async () => {
    const session = makeSession()
    await signIn(session, 'one@example.com')
    await signIn(session, 'two@example.com')
    expect(await session.status()).toMatchObject({ user: { email: 'two@example.com' } })
    expect(cloud.liveFamilies()).toHaveLength(1)
  })
})

describe('helpers', () => {
  it('sanitizes the device name and platform the way the server wants them', () => {
    expect(sanitizeDeviceName('box\u0007\n')).toBe('box')
    expect(sanitizeDeviceName('')).toBe('nsq')
    expect(sanitizeDeviceName('x'.repeat(100))).toHaveLength(64)
    expect(cloudPlatform('win32')).toBe('win32')
    expect(cloudPlatform('freebsd')).toBe('linux')
  })

  it('accepts an origin override only over https or loopback http', () => {
    expect(acceptableOrigin('https://staging.example.com/x')).toBe('https://staging.example.com')
    expect(acceptableOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(acceptableOrigin('http://192.168.1.5:8787')).toBeUndefined()
    expect(acceptableOrigin('ftp://x')).toBeUndefined()
    expect(resolveCloudOrigins({})).toEqual({
      api: 'https://api.neurosquad.ai',
      web: 'https://app.neurosquad.ai'
    })
    expect(resolveCloudOrigins({ NSQ_CLOUD_URL: 'http://localhost:9' })).toEqual({
      api: 'http://localhost:9',
      web: 'http://localhost:9'
    })
  })
})

describe('storage', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsq-remote-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a stable install id in a private file', () => {
    const file = join(dir, 'nested', 'cloud.json')
    const first = new FileSessionStore(file).read()
    expect(first.installId).toMatch(/^[A-Za-z0-9-]{8,64}$/)
    expect(new FileSessionStore(file).read().installId).toBe(first.installId)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      installId: first.installId,
      sessions: {}
    })
  })

  it('stores tokens in one keyring entry per origin and reports keyring failures', async () => {
    const entries = new Map<string, string>()
    const keyring = new KeyringVault((service, account) => ({
      getPassword: async () => entries.get(`${service}/${account}`),
      setPassword: async (password) => {
        entries.set(`${service}/${account}`, password)
      },
      deletePassword: async () => entries.delete(`${service}/${account}`)
    }))
    await keyring.save('https://a', { accessToken: 'A', refreshToken: 'R' })
    expect([...entries.keys()]).toEqual(['neurosquad-cli/https://a'])
    expect(await keyring.load('https://a')).toEqual({ accessToken: 'A', refreshToken: 'R' })
    expect(await keyring.load('https://b')).toBeUndefined()
    await keyring.clear('https://a')
    expect(entries.size).toBe(0)

    const failing = new KeyringVault(() => ({
      getPassword: async () => {
        throw new Error('org.freedesktop.secrets was not provided')
      },
      setPassword: async () => undefined,
      deletePassword: async () => false
    }))
    await expect(failing.load('https://a')).rejects.toBeInstanceOf(KeyringUnavailableError)
  })
})
