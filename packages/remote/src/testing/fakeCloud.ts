// A small local stand-in for the public NeuroSquad cloud API, enough for the sign-in tests:
// the device flow (start / poll / approve / deny), refresh with rotation, install binding and
// family revocation on reuse, revoke, and `/me`. Plus switches to simulate an outage, a lost
// answer and failing responses.
//
// It follows the documented public contract (docs/cloud/api.md in the NeuroSquad repo) and is
// written from that contract only. Never point tests at the real api.neurosquad.ai.
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeUser {
  id: string
  email: string
  name: string | null
  initials: string
  avatarColor: string
  avatarUrl: string | null
  role: 'user' | 'admin'
  createdAt: string
}

interface DeviceRequest {
  requestId: string
  userCode: string
  installId: string
  deviceName: string
  platform: string
  appVersion: string
  expiresAt: number
  approvedBy?: string
  denied?: boolean
  redeemed?: boolean
}

interface RefreshRecord {
  family: string
  userId: string
  installId: string
  rotated: boolean
  rotatedAt?: number
  successor?: string
}

interface AccessRecord {
  family: string
  userId: string
  expiresAt: number
}

export interface FakeCloudRequest {
  method: string
  path: string
  /** Whether a Bearer header was present (its value is never recorded). */
  bearer: boolean
  body?: unknown
}

export interface FakeCloud {
  /** `http://127.0.0.1:<port>` — use as both API and web origin. */
  readonly origin: string
  readonly requests: FakeCloudRequest[]
  readonly users: Map<string, FakeUser>
  readonly revokedFamilies: Set<string>
  /** Every connection is destroyed while true (the cloud "is down"). */
  down: boolean
  /** Access-token lifetime returned to the client, in seconds. */
  accessTtl: number
  /** Poll interval returned by `/device/start`, in seconds. */
  pollInterval: number
  /** Answer the next `count` requests to `path` with `status` (and `code`). */
  failNext(path: string, status: number, count?: number, code?: string): void
  /** Process the next request to `path`, then drop the connection (the answer is lost). */
  loseNextAnswer(path: string): void
  /** What the web panel's "Connect" button does. */
  approve(userCode: string, email?: string): void
  deny(userCode: string): void
  /** The pending device requests, newest last. */
  pendingCodes(): string[]
  /** Families that are live (not revoked). */
  liveFamilies(): string[]
  /** Makes every current access token expired (the next Bearer call gets 401). */
  expireAccessTokens(): void
  close(): Promise<void>
}

const USER_CODE_ALPHABET = 'CDFGHJKMNPQRTVWXZ234679'

function userCode(): string {
  const bytes = randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length]
    if (i === 3) code += '-'
  }
  return code
}

function opaque(): string {
  return randomBytes(32).toString('base64url')
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function startFakeCloud(): Promise<FakeCloud> {
  const devices = new Map<string, DeviceRequest>()
  const refreshTokens = new Map<string, RefreshRecord>()
  const accessTokens = new Map<string, AccessRecord>()
  const users = new Map<string, FakeUser>()
  const revokedFamilies = new Set<string>()
  const requests: FakeCloudRequest[] = []
  const failures = new Map<string, { status: number; count: number; code?: string }>()
  const lose = new Set<string>()

  function userByEmail(email: string): FakeUser {
    for (const user of users.values()) if (user.email === email) return user
    const user: FakeUser = {
      id: randomUUID(),
      email,
      name: null,
      initials: email.slice(0, 1).toUpperCase(),
      avatarColor: '#5b6cff',
      avatarUrl: null,
      role: 'user',
      createdAt: new Date().toISOString()
    }
    users.set(user.id, user)
    return user
  }

  function issue(family: string, userId: string, installId: string) {
    const accessToken = opaque()
    const refreshToken = opaque()
    accessTokens.set(accessToken, {
      family,
      userId,
      expiresAt: Date.now() + fake.accessTtl * 1000
    })
    refreshTokens.set(refreshToken, { family, userId, installId, rotated: false })
    return { accessToken, refreshToken, expiresIn: fake.accessTtl }
  }

  function revokeFamily(family: string): void {
    revokedFamilies.add(family)
  }

  function viewer(req: IncomingMessage): AccessRecord | undefined {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
    const record = accessTokens.get(header.slice(7))
    if (!record || record.expiresAt <= Date.now() || revokedFamilies.has(record.family)) {
      return undefined
    }
    return record
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/^\/api\/v1/, '')
      const method = req.method ?? 'GET'
      const body = await readBody(req)
      requests.push({
        method,
        path,
        bearer: typeof req.headers.authorization === 'string',
        ...(body === undefined ? {} : { body })
      })
      if (fake.down) {
        req.socket.destroy()
        return
      }
      const json = (status: number, value?: unknown): void => {
        if (lose.delete(path)) {
          req.socket.destroy()
          return
        }
        res.writeHead(status, value === undefined ? {} : { 'content-type': 'application/json' })
        res.end(value === undefined ? undefined : JSON.stringify(value))
      }
      const error = (status: number, code: string, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify({ error: { code, message: code.toLowerCase() } }))
      }
      const failure = failures.get(path)
      if (failure && failure.count > 0) {
        failure.count -= 1
        if (failure.count === 0) failures.delete(path)
        error(
          failure.status,
          failure.code ?? 'INTERNAL',
          failure.status === 429 ? { 'retry-after': '1' } : {}
        )
        return
      }
      const input = (body ?? {}) as Record<string, unknown>

      if (method === 'POST' && path === '/device/start') {
        const installId = String(input.installId ?? '')
        const platform = String(input.platform ?? '')
        if (
          !/^[A-Za-z0-9-]{8,64}$/.test(installId) ||
          !['win32', 'darwin', 'linux'].includes(platform) ||
          typeof input.deviceName !== 'string' ||
          input.deviceName.length < 1 ||
          input.deviceName.length > 64 ||
          !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(input.appVersion ?? ''))
        ) {
          error(400, 'VALIDATION')
          return
        }
        const request: DeviceRequest = {
          requestId: randomUUID(),
          userCode: userCode(),
          installId,
          deviceName: input.deviceName,
          platform,
          appVersion: String(input.appVersion),
          expiresAt: Date.now() + 600_000
        }
        devices.set(request.requestId, request)
        json(200, {
          requestId: request.requestId,
          userCode: request.userCode,
          verifyUrl: `${fake.origin}/connect?code=${request.userCode}`,
          interval: fake.pollInterval,
          expiresIn: 600
        })
        return
      }

      if (method === 'POST' && path === '/device/poll') {
        const request = devices.get(String(input.requestId ?? ''))
        if (!request || request.redeemed || request.expiresAt <= Date.now()) {
          error(410, 'EXPIRED')
          return
        }
        if (request.denied) {
          error(410, 'DENIED')
          return
        }
        if (!request.approvedBy) {
          json(202, { status: 'pending' })
          return
        }
        request.redeemed = true
        // One signed-in account per install: the install's other sessions end.
        for (const record of refreshTokens.values()) {
          if (record.installId === request.installId) revokeFamily(record.family)
        }
        const user = users.get(request.approvedBy)!
        const tokens = issue(randomUUID(), user.id, request.installId)
        json(200, {
          ...tokens,
          user: { ...user },
          plan: { id: 'free', name: 'Free', unlimited: true, trialEndsAt: null }
        })
        return
      }

      if (method === 'POST' && path === '/auth/refresh') {
        const token = String(input.refreshToken ?? '')
        const record = refreshTokens.get(token)
        if (!record || revokedFamilies.has(record.family)) {
          error(401, 'UNAUTHORIZED')
          return
        }
        if (record.installId !== input.installId) {
          error(401, 'UNAUTHORIZED')
          return
        }
        if (record.rotated) {
          // The contract's lost-answer window: within 5 minutes, while the successor was never
          // used, the same token may be presented again and gets a fresh pair.
          const successor = record.successor ? refreshTokens.get(record.successor) : undefined
          if (
            record.rotatedAt !== undefined &&
            Date.now() - record.rotatedAt < 5 * 60_000 &&
            successor &&
            !successor.rotated
          ) {
            refreshTokens.delete(record.successor!)
            const pair = issue(record.family, record.userId, record.installId)
            record.successor = pair.refreshToken
            json(200, pair)
            return
          }
          // Reuse of a rotated token: theft, as far as the server can tell.
          revokeFamily(record.family)
          error(401, 'UNAUTHORIZED')
          return
        }
        record.rotated = true
        record.rotatedAt = Date.now()
        const pair = issue(record.family, record.userId, record.installId)
        record.successor = pair.refreshToken
        json(200, pair)
        return
      }

      if (method === 'POST' && path === '/auth/revoke') {
        const record = viewer(req)
        if (!record) {
          error(401, 'UNAUTHORIZED')
          return
        }
        revokeFamily(record.family)
        json(204)
        return
      }

      if (method === 'GET' && path === '/me') {
        const record = viewer(req)
        if (!record) {
          error(401, 'UNAUTHORIZED')
          return
        }
        const user = users.get(record.userId)!
        json(200, {
          user: { ...user },
          plan: { id: 'free', name: 'Free', unlimited: true, trialEndsAt: null }
        })
        return
      }

      error(404, 'NOT_FOUND')
    })().catch(() => {
      try {
        res.writeHead(500).end()
      } catch {
        // Already answered.
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const fake: FakeCloud = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    users,
    revokedFamilies,
    down: false,
    accessTtl: 3600,
    pollInterval: 1,
    failNext(path, status, count = 1, code) {
      failures.set(path, { status, count, ...(code ? { code } : {}) })
    },
    loseNextAnswer(path) {
      lose.add(path)
    },
    approve(code, email = 'dev@example.com') {
      for (const request of devices.values()) {
        if (request.userCode === code) request.approvedBy = userByEmail(email).id
      }
    },
    deny(code) {
      for (const request of devices.values()) {
        if (request.userCode === code) request.denied = true
      }
    },
    pendingCodes() {
      return [...devices.values()]
        .filter((request) => !request.redeemed && !request.approvedBy && !request.denied)
        .map((request) => request.userCode)
    },
    liveFamilies() {
      const families = new Set<string>()
      for (const record of refreshTokens.values()) {
        if (!revokedFamilies.has(record.family)) families.add(record.family)
      }
      return [...families]
    },
    expireAccessTokens() {
      for (const record of accessTokens.values()) record.expiresAt = 0
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    }
  }
  return fake
}
