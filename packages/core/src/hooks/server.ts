// The loopback endpoint harness hooks post to:
// `POST http://127.0.0.1:<port>/hook/<token>/<agentId>/<event>`.
//
// The token is per agent — HMAC(run secret, agentId) — so a token opens one
// agent's path and nothing else, and is compared in constant time. It is in
// the path rather than a header because the caller is often a `curl` line
// inside a settings file some shell will re-parse; a URL with no spaces
// survives that everywhere. The server listens on 127.0.0.1 only.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A hook's JSON is usually small; a PermissionRequest can carry a whole file being written. */
export const MAX_HOOK_BODY = 16 * 1024 * 1024

export interface AgentTokens {
  tokenFor(agentId: string): string
  matches(given: string | undefined, agentId: string): boolean
}

export function createAgentTokens(secret: string): AgentTokens {
  const tokenFor = (agentId: string): string =>
    createHmac('sha256', secret).update(`agent:${agentId.toLowerCase()}`).digest('hex')
  return {
    tokenFor,
    matches(given, agentId) {
      if (typeof given !== 'string') return false
      const want = Buffer.from(tokenFor(agentId))
      const got = Buffer.from(given)
      return got.length === want.length && timingSafeEqual(got, want)
    }
  }
}

export interface HookServerOptions {
  /** Whether an agent exists (unknown agents get 404, like a wrong token). */
  knows(agentId: string): boolean
  /**
   * Called before the body is read (the process life the request arrived in)
   * and with it; returns the response body.
   */
  arrive(agentId: string): number
  handle(agentId: string, event: string, body: string, arrivedIn: number): string | Promise<string>
  /** Secret for the tokens; random when omitted. */
  secret?: string
  /** Port to listen on (0 = any free one). */
  port?: number
}

export interface HookServer {
  readonly port: number
  /** `http://127.0.0.1:<port>/hook/<token>/<agentId>` */
  baseFor(agentId: string): string
  close(): Promise<void>
}

const HOOK_PATH = /^\/hook\/([0-9a-f]{16,128})\/([0-9a-f-]{36})\/([A-Za-z]+)\/?$/

function collect(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) {
      req.resume()
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > max) {
        done = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolve(null)
    })
  })
}

export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
  const tokens = createAgentTokens(options.secret ?? randomBytes(32).toString('hex'))
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      route(req, res)
    } catch (error) {
      console.error('hooks: request failed (non-fatal)', error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  const route = (req: IncomingMessage, res: ServerResponse): void => {
    const match = req.method === 'POST' ? HOOK_PATH.exec(req.url ?? '') : null
    if (!match) {
      res.writeHead(404).end()
      return
    }
    const [, token, agentId, event] = match
    if (!tokens.matches(token, agentId) || !options.knows(agentId)) {
      res.writeHead(404).end()
      return
    }
    const life = options.arrive(agentId)
    void collect(req, MAX_HOOK_BODY).then(async (body) => {
      if (body === null) {
        res.writeHead(413).end()
        return
      }
      let reply = '{}'
      try {
        reply = await options.handle(agentId, event, body, life)
      } catch (error) {
        console.error('hooks: handler failed (non-fatal)', error)
      }
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(reply)
    })
  }
  server.keepAliveTimeout = 1000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    baseFor: (agentId) => `http://127.0.0.1:${port}/hook/${tokens.tokenFor(agentId)}/${agentId}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
  }
}
