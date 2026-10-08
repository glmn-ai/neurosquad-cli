// The HTTP layer under the cloud session (the public NeuroSquad API, `/api/v1`).
//
// Plain `fetch`, no Electron, no proxy magic: the tests drive it against a local fake server.
// Errors are values, not exceptions, except for "the cloud could not be reached at all", which is
// a `CloudNetworkError` — the session treats that (and 5xx) as offline, never as signed out.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const CLOUD_API_PREFIX = '/api/v1'

/** The cloud could not be reached at all (DNS, refused, timeout, TLS). */
export class CloudNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudNetworkError'
  }
}

export interface CloudResponse {
  status: number
  /** Parsed JSON body, or undefined (204, or not JSON). */
  body: unknown
  /** `error.code` of an error body, if any. */
  code?: string
  /** Seconds, from `Retry-After`. */
  retryAfter?: number
}

export interface CloudRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  /** A Bearer token. Only ever sent to `origin`, never logged. */
  token?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

export class CloudHttp {
  /**
   * @param origin the API origin; every request goes here and nowhere else
   * @param webOrigin the web panel; the only place a verify link may point at
   */
  constructor(
    readonly origin: string,
    readonly webOrigin: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly userAgent = 'nsq'
  ) {}

  url(path: string): string {
    return `${this.origin}${CLOUD_API_PREFIX}${path}`
  }

  async request(request: CloudRequest): Promise<CloudResponse> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent
    }
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    if (request.token) headers.authorization = `Bearer ${request.token}`
    let response: Response
    try {
      response = await this.fetchImpl(this.url(request.path), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        // A redirect could carry the Bearer header somewhere else.
        redirect: 'error'
      })
    } catch (error) {
      throw new CloudNetworkError(error instanceof Error ? error.message : String(error))
    }
    let body: unknown
    try {
      const text = await response.text()
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    const code =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { code?: unknown } }).error?.code
        : undefined
    const retryHeader = Number(response.headers.get('retry-after'))
    return {
      status: response.status,
      body,
      ...(typeof code === 'string' ? { code } : {}),
      ...(Number.isFinite(retryHeader) && retryHeader > 0 ? { retryAfter: retryHeader } : {})
    }
  }
}
