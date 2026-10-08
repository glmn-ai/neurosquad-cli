// Which cloud the CLI talks to.
//
// Production by default. `NSQ_CLOUD_URL` / `NSQ_CLOUD_WEB_URL` exist for development and for tests
// against a fake server; they accept https anywhere and plain http only on loopback, so a stray
// environment variable cannot send a Bearer token in clear text across a network. Tokens are kept
// per API origin (see vault.ts), so a session obtained from one origin is never presented to another.

export const DEFAULT_CLOUD_ORIGIN = 'https://api.neurosquad.ai'
export const DEFAULT_CLOUD_WEB_ORIGIN = 'https://app.neurosquad.ai'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** An origin from an override, or undefined when the override is absent or not acceptable. */
export function acceptableOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:') return url.origin
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.origin
    return undefined
  } catch {
    return undefined
  }
}

export interface CloudOrigins {
  api: string
  web: string
}

export function resolveCloudOrigins(env: NodeJS.ProcessEnv = process.env): CloudOrigins {
  const api = acceptableOrigin(env.NSQ_CLOUD_URL)
  const web = acceptableOrigin(env.NSQ_CLOUD_WEB_URL)
  return {
    api: api ?? DEFAULT_CLOUD_ORIGIN,
    // A custom API without a custom web origin keeps verify links on the production panel only
    // when the API is production too; otherwise the API's own origin is the best guess.
    web: web ?? (api ? api : DEFAULT_CLOUD_WEB_ORIGIN)
  }
}

/**
 * The verify link is shown and opened as the API returns it, with a guard: https, or plain http
 * to this machine (a dev or fake server). Never `file:`, a custom protocol or anything else.
 */
export function safeVerifyUrl(raw: string, webOrigin: string): string | undefined {
  try {
    const url = new URL(raw, webOrigin)
    if (url.protocol === 'https:') return url.toString()
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.toString()
    return undefined
  } catch {
    return undefined
  }
}
