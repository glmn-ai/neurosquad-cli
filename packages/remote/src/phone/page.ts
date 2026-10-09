// The phone page (web/): a small client for this API, served from the same origin so it needs no
// CORS and no third party. Static files only — they carry no data; everything the page shows comes
// from /api with the pairing token.
import { readFileSync } from 'node:fs'

/** Locked to this origin: no inline script or style, no eval, no frames, nothing external. */
export const PHONE_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** The API's own answers: never rendered as a document. */
export const PHONE_API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox"

const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' }
}

const cache = new Map<string, Buffer>()

export interface PageFile {
  body: Buffer
  type: string
}

/** The file for a request path, or null (only the listed paths exist). */
export function phonePageFile(path: string): PageFile | null {
  const entry = Object.hasOwn(FILES, path) ? FILES[path] : undefined
  if (!entry) return null
  let body = cache.get(entry.file)
  if (!body) {
    body = readFileSync(new URL(`./web/${entry.file}`, import.meta.url))
    cache.set(entry.file, body)
  }
  return { body, type: entry.type }
}
