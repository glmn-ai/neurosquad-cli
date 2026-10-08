// The optional NeuroSquad account for nsq: device-code sign-in, rotating refresh tokens, `/me`,
// the offline grace and sign-out — against the public cloud contract (`/api/v1`), the same one the
// desktop app uses. Nothing here is required to run agents; it only unlocks cloud features.
//
// Rules carried over from the desktop (they are what keeps a session alive on a flaky network):
// - A refresh is single-flight. Refresh tokens rotate on every use and the server treats reuse of
//   an old one as theft (it revokes the whole family), so two refreshes racing with the same token
//   would sign the user out.
// - Only the cloud's own `401` from `/auth/refresh` ends a session. A timeout, a refused connection,
//   a 5xx, a 429 or a proxy's 403 is "offline": the same token is retried later.
// - While offline the session stays usable for a grace period (7 days since the last confirmation),
//   then the status says `grace-expired` — the tokens are kept, and the next successful call brings
//   the session back.
// - Sign-out forgets the session locally *first* (the user asked; an unreachable cloud must not keep
//   the machine signed in), then revokes it on the server on a best-effort basis.
//
// Tokens never leave this module except as a Bearer header to the API origin, and never appear in
// an error message.
import { CloudHttp, CloudNetworkError, type CloudRequest, type CloudResponse } from './http.js'
import { safeVerifyUrl } from './origin.js'
import type { CloudPlan, CloudUser, OriginSession, SessionStore } from './store.js'
import type { StoredTokens, TokenVault } from './vault.js'

export const CLOUD_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000
/** The access token is treated as expired this long before it really is. */
const ACCESS_SKEW_MS = 60_000
const MIN_POLL_MS = 1_000
const DEFAULT_POLL_MS = 5_000

export type SignedOutReason =
  /** Never signed in, or signed out. */
  | 'signed-out'
  /** The cloud refused the session (revoked from the web panel, reuse detected, expired). */
  | 'session-expired'
  /** Offline for longer than the grace period. Tokens are kept: `verify()` can bring it back. */
  | 'grace-expired'
  /** The OS keyring cannot be read on this machine. */
  | 'keyring-unavailable'

export type CloudStatus =
  | { state: 'signed-out'; reason: SignedOutReason }
  | {
      state: 'signed-in'
      user: CloudUser
      plan?: CloudPlan
      /** The cloud could not be reached on the last attempt; usable until `graceEndsAt`. */
      offline?: true
      graceEndsAt?: number
    }

export interface DeviceInfo {
  /** Shown on the web's "Connect NeuroSquad on <deviceName>?" page; sanitized to 1–64 chars. */
  deviceName: string
  platform: NodeJS.Platform | string
  /** `x.y.z[-pre]` */
  appVersion: string
}

export interface DeviceCode {
  /** `XXXX-XXXX`, to compare with what the browser shows. Not a secret. */
  userCode: string
  /** The web panel's connect page (already checked to be https, or http on loopback). */
  verifyUrl: string
  /** ms epoch */
  expiresAt: number
}

export type LoginFailure =
  'offline' | 'expired' | 'denied' | 'aborted' | 'rate-limited' | 'protocol'

export class LoginError extends Error {
  constructor(
    readonly code: LoginFailure,
    message: string
  ) {
    super(message)
    this.name = 'LoginError'
  }
}

/** There is no session to make the call with. */
export class SignedOutError extends Error {
  constructor() {
    super('Not signed in to NeuroSquad (run `nsq login`).')
    this.name = 'SignedOutError'
  }
}

/** The cloud refused the session; it has been forgotten locally. */
export class SessionExpiredError extends Error {
  constructor() {
    super('The NeuroSquad session has ended; sign in again (`nsq login`).')
    this.name = 'SessionExpiredError'
  }
}

/**
 * The session changed (signed out, or replaced by a new sign-in) while a refresh was on the wire.
 * Its answer is dropped, not stored; `orphanAccessToken` lets sign-out still revoke it.
 */
class SessionMovedError extends Error {
  constructor(readonly orphanAccessToken?: string) {
    super('The session changed while it was being refreshed.')
    this.name = 'SessionMovedError'
  }
}

export interface CloudSessionDeps {
  http: CloudHttp
  vault: TokenVault
  store: SessionStore
  device: DeviceInfo
  now?: () => number
  /** Resolves after `ms`, rejects with an AbortError when `signal` fires. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  graceMs?: number
}

export interface LoginOptions {
  /** Called once the code exists: show it, and open `verifyUrl` (or print it). */
  onCode: (code: DeviceCode) => void
  /** Called after each poll that is still waiting; `offline` when the cloud was unreachable. */
  onPending?: (info: { offline: boolean }) => void
  /** Cancels the flow (Ctrl+C): rejects with `LoginError('aborted')`. */
  signal?: AbortSignal
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function asUser(value: unknown): CloudUser | undefined {
  if (!value || typeof value !== 'object') return undefined
  const user = value as Record<string, unknown>
  if (typeof user.id !== 'string' || typeof user.email !== 'string') return undefined
  return {
    id: user.id,
    email: user.email,
    name: typeof user.name === 'string' ? user.name : null,
    ...(typeof user.initials === 'string' ? { initials: user.initials } : {}),
    ...(typeof user.avatarColor === 'string' ? { avatarColor: user.avatarColor } : {}),
    ...(typeof user.role === 'string' ? { role: user.role } : {})
  }
}

function asPlan(value: unknown): CloudPlan | undefined {
  if (!value || typeof value !== 'object') return undefined
  const plan = value as Record<string, unknown>
  if (typeof plan.id !== 'string' || typeof plan.name !== 'string') return undefined
  return {
    id: plan.id,
    name: plan.name,
    ...(typeof plan.unlimited === 'boolean' ? { unlimited: plan.unlimited } : {}),
    ...(typeof plan.trialEndsAt === 'string' || plan.trialEndsAt === null
      ? { trialEndsAt: plan.trialEndsAt as string | null }
      : {})
  }
}

/** The server's `deviceName` rule: control characters stripped, 1–64 chars. */
export function sanitizeDeviceName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  return (clean || 'nsq').slice(0, 64)
}

/** The server accepts `win32 | darwin | linux`; anything else is closest to linux. */
export function cloudPlatform(platform: string): 'win32' | 'darwin' | 'linux' {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux'
}

export class CloudSession {
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly graceMs: number
  /** undefined = not loaded from the vault yet; null = loaded, none. */
  private tokens: StoredTokens | null | undefined
  private refreshing: Promise<string> | null = null
  private verifying: Promise<CloudStatus> | null = null
  /**
   * Bumped whenever the session itself changes — wiped or replaced by a new sign-in — so an answer
   * that was in flight across that change is dropped instead of resurrecting it.
   */
  private sessionEpoch = 0
  /** Set by a network failure, cleared by any successful answer. */
  private offline = false

  constructor(private readonly deps: CloudSessionDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.graceMs = deps.graceMs ?? CLOUD_OFFLINE_GRACE_MS
  }

  get origin(): string {
    return this.deps.http.origin
  }

  // ------------------------------------------------------------- persisted

  private session(): OriginSession | undefined {
    return this.deps.store.read().sessions[this.origin]
  }

  private saveSession(session: OriginSession | undefined): void {
    const persisted = this.deps.store.read()
    if (session) persisted.sessions[this.origin] = session
    else delete persisted.sessions[this.origin]
    this.deps.store.write(persisted)
  }

  private patchSession(patch: Partial<OriginSession>): void {
    const current = this.session()
    if (current) this.saveSession({ ...current, ...patch })
  }

  private installId(): string {
    return this.deps.store.read().installId
  }

  private async loadTokens(): Promise<StoredTokens | null> {
    if (this.tokens === undefined) {
      this.tokens = (await this.deps.vault.load(this.origin)) ?? null
    }
    return this.tokens
  }

  private async storeTokens(
    accessToken: string,
    refreshToken: string,
    expiresIn: unknown
  ): Promise<void> {
    this.tokens = { accessToken, refreshToken }
    const seconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600
    this.patchSession({ accessExpiresAt: this.now() + seconds * 1000, lastVerifiedAt: this.now() })
    await this.deps.vault.save(this.origin, this.tokens)
  }

  /** Forgets the session on this machine (store first, then the keyring). */
  private async wipe(): Promise<void> {
    this.sessionEpoch++
    this.tokens = null
    this.offline = false
    this.saveSession(undefined)
    await this.deps.vault.clear(this.origin)
  }

  // ---------------------------------------------------------------- status

  private graceLeft(session: OriginSession): boolean {
    return this.now() - session.lastVerifiedAt < this.graceMs
  }

  private statusFrom(session: OriginSession | undefined): CloudStatus {
    if (!session) return { state: 'signed-out', reason: 'signed-out' }
    if (!this.graceLeft(session)) return { state: 'signed-out', reason: 'grace-expired' }
    return {
      state: 'signed-in',
      user: session.user,
      ...(session.plan ? { plan: session.plan } : {}),
      ...(this.offline
        ? { offline: true as const, graceEndsAt: session.lastVerifiedAt + this.graceMs }
        : {})
    }
  }

  /** What is known locally, without asking the cloud. Never throws. */
  async status(): Promise<CloudStatus> {
    const session = this.session()
    if (!session) return { state: 'signed-out', reason: 'signed-out' }
    try {
      if (!(await this.loadTokens())) return { state: 'signed-out', reason: 'signed-out' }
    } catch {
      return { state: 'signed-out', reason: 'keyring-unavailable' }
    }
    return this.statusFrom(session)
  }

  // ---------------------------------------------------------------- tokens

  /**
   * Rotates the refresh token. Single-flight; resolves with the new access token. Rejects with
   * `SignedOutError`, `SessionExpiredError`, `CloudNetworkError` or `KeyringUnavailableError`.
   */
  refresh(): Promise<string> {
    return this.sharedRefresh().catch((error: unknown) => {
      throw error instanceof SessionMovedError ? new SignedOutError() : error
    })
  }

  /** The single in-flight rotation, with the internal SessionMovedError (logout needs its token). */
  private sharedRefresh(): Promise<string> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(): Promise<string> {
    // Captured before any await: a sign-out between here and the answer must win.
    const epoch = this.sessionEpoch
    const tokens = await this.loadTokens()
    if (!tokens || epoch !== this.sessionEpoch) throw new SignedOutError()
    let response: CloudResponse
    try {
      response = await this.deps.http.request({
        method: 'POST',
        path: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken, installId: this.installId() }
      })
    } catch (error) {
      if (error instanceof CloudNetworkError) this.offline = true
      throw error
    }
    const body = response.body as Record<string, unknown> | undefined
    if (epoch !== this.sessionEpoch) {
      throw new SessionMovedError(
        response.status === 200 && typeof body?.accessToken === 'string'
          ? body.accessToken
          : undefined
      )
    }
    if (response.status === 200) {
      if (typeof body?.accessToken !== 'string' || typeof body?.refreshToken !== 'string') {
        this.offline = true
        throw new CloudNetworkError('Malformed refresh response')
      }
      this.offline = false
      await this.storeTokens(body.accessToken, body.refreshToken, body.expiresIn)
      return body.accessToken
    }
    // Only the cloud's own 401 ends the session (every refusal of /auth/refresh is 401). A 403 from
    // a proxy or captive portal, a 5xx, a 429 is "offline" — the same token is retried later.
    if (response.status === 401) {
      await this.wipe()
      throw new SessionExpiredError()
    }
    this.offline = true
    throw new CloudNetworkError(`The cloud answered ${response.status} to a refresh`)
  }

  private async accessToken(): Promise<string> {
    const tokens = await this.loadTokens()
    if (!tokens) throw new SignedOutError()
    const expiresAt = this.session()?.accessExpiresAt ?? 0
    if (this.now() < expiresAt - ACCESS_SKEW_MS) return tokens.accessToken
    return this.sharedRefresh()
  }

  /**
   * A Bearer call to the API. Refreshes an expired token first, retries once on 401, forgets the
   * session if the refresh is refused (`SessionExpiredError`). A network failure rethrows
   * `CloudNetworkError` and marks the session offline. `SignedOutError` when there is no session,
   * or it was signed out while the call was on the wire.
   */
  async authorized(request: Omit<CloudRequest, 'token'>): Promise<CloudResponse> {
    // Every await below is a point where the user may sign out or in as someone else; a call that
    // started under one session never refreshes, retries or answers under another.
    const epoch = this.sessionEpoch
    const moved = (): void => {
      if (epoch !== this.sessionEpoch) throw new SessionMovedError()
    }
    try {
      if (!this.session() || !(await this.loadTokens())) throw new SignedOutError()
      moved()
      const first = await this.accessToken()
      moved()
      let response = await this.deps.http.request({ ...request, token: first })
      moved()
      if (response.status === 401) {
        const token = await this.sharedRefresh()
        moved()
        response = await this.deps.http.request({ ...request, token })
        moved()
        if (response.status === 401) {
          await this.wipe()
          throw new SessionExpiredError()
        }
      }
      if (response.status < 500) this.offline = false
      return response
    } catch (error) {
      if (error instanceof CloudNetworkError) this.offline = true
      // Signed out (or signed in again) while this call was on the wire.
      if (error instanceof SessionMovedError) throw new SignedOutError()
      throw error
    }
  }

  // ------------------------------------------------------------------ /me

  /** Confirms the session with `/me` and returns the resulting status. Coalesced; never throws. */
  verify(): Promise<CloudStatus> {
    if (!this.verifying) {
      this.verifying = this.doVerify().finally(() => {
        this.verifying = null
      })
    }
    return this.verifying
  }

  private async doVerify(): Promise<CloudStatus> {
    const local = await this.status()
    if (local.state === 'signed-out' && local.reason !== 'grace-expired') return local
    const epoch = this.sessionEpoch
    let response: CloudResponse
    try {
      response = await this.authorized({ method: 'GET', path: '/me' })
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        return { state: 'signed-out', reason: 'session-expired' }
      }
      if (error instanceof SignedOutError || error instanceof SessionMovedError) {
        return this.status()
      }
      this.offline = true
      return this.statusFrom(this.session())
    }
    if (epoch !== this.sessionEpoch) return this.status()
    const body = response.body as Record<string, unknown> | undefined
    const user = response.status === 200 ? asUser(body?.user) : undefined
    if (!user) {
      // A server error is "unreachable" for the grace's purposes.
      this.offline = true
      return this.statusFrom(this.session())
    }
    this.offline = false
    this.patchSession({
      user,
      plan: asPlan(body?.plan) ?? this.session()?.plan,
      lastVerifiedAt: this.now()
    })
    return this.statusFrom(this.session())
  }

  // --------------------------------------------------------------- sign in

  /**
   * The device flow (docs/cloud/api.md "Desktop sign-in"): start, show the code, poll until the
   * browser approves. Resolves with the signed-in status; rejects with `LoginError`. A successful
   * sign-in replaces any earlier session of this install (the server revokes it).
   */
  async login(options: LoginOptions): Promise<Extract<CloudStatus, { state: 'signed-in' }>> {
    const { signal } = options
    const aborted = (): LoginError => new LoginError('aborted', 'Sign-in cancelled.')
    if (signal?.aborted) throw aborted()
    let response: CloudResponse
    try {
      response = await this.deps.http.request({
        method: 'POST',
        path: '/device/start',
        body: {
          installId: this.installId(),
          deviceName: sanitizeDeviceName(this.deps.device.deviceName),
          platform: cloudPlatform(this.deps.device.platform),
          appVersion: this.deps.device.appVersion
        }
      })
    } catch {
      throw new LoginError('offline', 'The NeuroSquad cloud could not be reached.')
    }
    if (response.status === 429) {
      throw new LoginError('rate-limited', 'Too many sign-in attempts; try again in a minute.')
    }
    const start = response.body as Record<string, unknown> | undefined
    if (
      response.status !== 200 ||
      typeof start?.requestId !== 'string' ||
      typeof start?.userCode !== 'string' ||
      typeof start?.verifyUrl !== 'string'
    ) {
      throw new LoginError('protocol', `Unexpected answer from the cloud (${response.status}).`)
    }
    const verifyUrl = safeVerifyUrl(start.verifyUrl, this.deps.http.webOrigin)
    if (!verifyUrl) throw new LoginError('protocol', 'The cloud sent an unusable verify link.')
    const expiresIn =
      typeof start.expiresIn === 'number' && start.expiresIn > 0 ? start.expiresIn : 600
    const interval = typeof start.interval === 'number' && start.interval > 0 ? start.interval : 5
    const requestId = start.requestId
    const expiresAt = this.now() + expiresIn * 1000
    let intervalMs = Math.max(MIN_POLL_MS, interval * 1000 || DEFAULT_POLL_MS)
    options.onCode({ userCode: start.userCode, verifyUrl, expiresAt })

    let delay = intervalMs
    for (;;) {
      try {
        await this.sleep(delay, signal)
      } catch {
        throw aborted()
      }
      if (signal?.aborted) throw aborted()
      if (this.now() >= expiresAt) throw new LoginError('expired', 'The sign-in code expired.')
      delay = intervalMs
      let poll: CloudResponse
      try {
        poll = await this.deps.http.request({
          method: 'POST',
          path: '/device/poll',
          body: { requestId }
        })
      } catch {
        options.onPending?.({ offline: true })
        continue
      }
      if (signal?.aborted) throw aborted()
      const body = poll.body as Record<string, unknown> | undefined
      if (poll.status === 200 && typeof body?.accessToken === 'string') {
        const user = asUser(body.user)
        if (typeof body.refreshToken !== 'string' || !user) {
          throw new LoginError('protocol', 'The cloud sent an incomplete session.')
        }
        this.sessionEpoch++
        this.offline = false
        const plan = asPlan(body.plan)
        this.saveSession({ user, ...(plan ? { plan } : {}), lastVerifiedAt: this.now() })
        try {
          await this.storeTokens(body.accessToken, body.refreshToken, body.expiresIn)
        } catch (error) {
          // No keyring: nothing may be left half signed in, and the server-side session this
          // poll just created is revoked rather than orphaned.
          this.tokens = null
          this.saveSession(undefined)
          await this.deps.http
            .request({
              method: 'POST',
              path: '/auth/revoke',
              token: body.accessToken,
              timeoutMs: 5_000
            })
            .catch(() => undefined)
          throw error
        }
        return this.statusFrom(this.session()) as Extract<CloudStatus, { state: 'signed-in' }>
      }
      if (poll.status === 410) {
        if (poll.code === 'DENIED')
          throw new LoginError('denied', 'Sign-in was cancelled in the browser.')
        throw new LoginError('expired', 'The sign-in code expired.')
      }
      if (poll.status === 429) {
        // Slow down, RFC 8628 style.
        intervalMs += 5_000
        delay = Math.max(intervalMs, (poll.retryAfter ?? 0) * 1000)
        options.onPending?.({ offline: false })
        continue
      }
      // 202 pending — or a server hiccup: keep waiting either way.
      options.onPending?.({ offline: poll.status >= 500 })
    }
  }

  // -------------------------------------------------------------- sign out

  /**
   * Forgets the session on this machine, then revokes it on the server (best effort, short
   * timeouts). Rejects only if the keyring entry could not be removed — the local session record
   * is gone either way.
   */
  async logout(): Promise<void> {
    let tokens: StoredTokens | null = null
    try {
      tokens = await this.loadTokens()
    } catch {
      // The keyring is unreadable; the wipe below reports that.
    }
    const fresh =
      tokens !== null && this.now() < (this.session()?.accessExpiresAt ?? 0) - ACCESS_SKEW_MS
    // A rotation of this same refresh token already on the wire: presenting the token again would
    // be reuse to the server, so its answer is used instead (it is dropped, not stored).
    const inFlight = this.refreshing
    let wipeError: unknown
    try {
      await this.wipe()
    } catch (error) {
      wipeError = error
    }
    try {
      let token = fresh ? tokens?.accessToken : undefined
      if (!token && inFlight) {
        token = await inFlight.then(
          () => undefined,
          (error: unknown) =>
            error instanceof SessionMovedError ? error.orphanAccessToken : undefined
        )
      } else if (!token && tokens) {
        // An expired access token cannot revoke; one last rotation can.
        const response = await this.deps.http.request({
          method: 'POST',
          path: '/auth/refresh',
          body: { refreshToken: tokens.refreshToken, installId: this.installId() },
          timeoutMs: 5_000
        })
        const body = response.body as Record<string, unknown> | undefined
        if (response.status === 200 && typeof body?.accessToken === 'string') {
          token = body.accessToken
        }
      }
      if (token) {
        await this.deps.http.request({
          method: 'POST',
          path: '/auth/revoke',
          token,
          timeoutMs: 5_000
        })
      }
    } catch {
      // Offline: the session is gone from this machine anyway.
    }
    if (wipeError) throw wipeError
  }
}
