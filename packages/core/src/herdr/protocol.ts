// The herdr agent status protocol, from the host's side.
//
// herdr (https://herdr.dev, Apache-2.0) is a terminal multiplexer for coding
// agents. It publishes a small protocol an agent uses to report its own state
// (https://herdr.dev/docs/add-herdr-support/): every process in a pane gets
// `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` and `HERDR_BIN_PATH`,
// and reports `idle` / `working` / `blocked` (with a message), its session id
// and the command that resumes that session — through `"$HERDR_BIN_PATH" pane
// report-agent …` or as one newline-delimited JSON request per connection to
// the socket (`pane.report_agent`, `pane.report_agent_session`,
// `pane.release_agent`). Agents that implement it (Crush, Kiro CLI, Command
// Code…) need no integration of their own in a host that speaks it.
//
// This module is the protocol only: parsing a request line, the reply shapes,
// the resume command rules and the pane-id tokens. Written from the public
// documentation and the request/response shapes of herdr's socket API; no
// herdr code is copied.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const HERDR_ENV = 'HERDR_ENV'
export const HERDR_PANE_ID = 'HERDR_PANE_ID'
export const HERDR_SOCKET_PATH = 'HERDR_SOCKET_PATH'
export const HERDR_BIN_PATH = 'HERDR_BIN_PATH'

/** The states an agent reports (herdr's `PaneAgentState`). */
export type HerdrState = 'idle' | 'working' | 'blocked' | 'unknown'

export const HERDR_REPORT_METHODS = [
  'pane.report_agent',
  'pane.report_agent_session',
  'pane.release_agent'
] as const
export type HerdrReportMethod = (typeof HERDR_REPORT_METHODS)[number]

/** One state report, session report or release, as the agent sent it. */
export interface HerdrReport {
  method: HerdrReportMethod
  paneId: string
  /** The reporting integration (`crush`, `custom:my-agent`…). */
  source: string
  /** The agent's name as people see it. */
  agent: string
  /** `pane.report_agent` only. */
  state?: HerdrState
  /** Why the agent is blocked (or any status text that came with the state). */
  message?: string
  /** A u64 (agents seed it from the clock in nanoseconds: beyond a double's precision). */
  seq?: bigint
  /** The agent's own session id. */
  sessionId?: string
  /** The command that reopens the current session (`resume_argv`). */
  resumeArgv?: string[]
}

export interface HerdrRequest {
  /** The request id to echo ('' when the line had none). */
  id: string
  method: string
  /** Set for the three report methods when their params are well-formed. */
  report?: HerdrReport
  /** Why a report method's params were rejected: an error code and message. */
  invalid?: { code: string; message: string }
}

/** herdr's resume command limits. */
export const MAX_RESUME_ARGS = 64
export const MAX_RESUME_ARGV_BYTES = 8 * 1024

/**
 * herdr's rules for a resume command (null = acceptable): a plain command name
 * first (looked up on PATH — not a path), at most 64 arguments and 8 KiB, no
 * control characters and no apostrophes (it is quoted POSIX-style on restore).
 */
export function resumeArgvProblem(argv: readonly string[]): string | null {
  const command = argv[0]
  if (command === undefined) return 'resume_argv must not be empty'
  if (argv.length > MAX_RESUME_ARGS)
    return `resume_argv allows at most ${MAX_RESUME_ARGS} arguments`
  if (argv.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0) > MAX_RESUME_ARGV_BYTES)
    return `resume_argv allows at most ${MAX_RESUME_ARGV_BYTES} bytes`
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  if (argv.some((arg) => /[\u0000-\u001f\u007f-\u009f]/.test(arg)))
    return 'resume_argv must not contain control characters'
  if (argv.some((arg) => arg.includes("'"))) return 'resume_argv must not contain apostrophes'
  if (!/^[A-Za-z0-9_.-]+$/.test(command) || command.startsWith('-'))
    return 'resume_argv must start with a plain command name, not a path'
  return null
}

const STATES: readonly HerdrState[] = ['idle', 'working', 'blocked', 'unknown']

/** herdr's seq is a u64. */
export const MAX_HERDR_SEQ = 2n ** 64n - 1n

/**
 * JSON.parse that keeps every integer `seq` exact (a bigint): Crush seeds its
 * seq from the clock in nanoseconds (~1.8e18), where neighbouring values are
 * the same double.
 */
function parseKeepingSeq(line: string): unknown {
  const reviver = (key: string, value: unknown, context?: { source?: string }): unknown =>
    key === 'seq' && typeof value === 'number' && context?.source && /^\d+$/.test(context.source)
      ? BigInt(context.source)
      : value
  return JSON.parse(line, reviver as (key: string, value: unknown) => unknown)
}

/** A request object as one line, with bigint values written as JSON numbers. */
export function encodeHerdrRequest(request: object): string {
  const json = JSON.stringify(request, (_key, value: unknown) =>
    typeof value === 'bigint' ? `__nsq_u64__:${value.toString()}` : value
  )
  return `${json.replace(/"__nsq_u64__:(\d+)"/g, '$1')}\n`
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

/**
 * One request line. Null when the line is not a JSON object with a string
 * `method` (nothing to answer but a generic error). A report method with
 * missing or malformed params comes back with `invalid` set.
 */
export function parseHerdrRequest(line: string): HerdrRequest | null {
  let parsed: unknown
  try {
    parsed = parseKeepingSeq(line.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const { id, method, params } = parsed as { id?: unknown; method?: unknown; params?: unknown }
  if (typeof method !== 'string') return null
  const request: HerdrRequest = { id: typeof id === 'string' ? id : '', method }
  if (!(HERDR_REPORT_METHODS as readonly string[]).includes(method)) return request
  const invalid = (message: string): HerdrRequest => ({
    ...request,
    invalid: { code: 'invalid_request', message }
  })
  if (!params || typeof params !== 'object' || Array.isArray(params))
    return invalid('params must be an object')
  const p = params as Record<string, unknown>
  const paneId = text(p.pane_id)
  if (!paneId) return invalid('pane_id is required')
  const source = text(p.source)?.trim()
  if (!source) return invalid('source is required')
  const agent = text(p.agent)?.trim()
  if (!agent)
    return {
      ...request,
      invalid: { code: 'invalid_agent', message: 'agent label must not be empty' }
    }
  let state: HerdrState | undefined
  if (method === 'pane.report_agent') {
    state = STATES.find((known) => known === p.state)
    if (!state) return invalid('state must be idle, working, blocked or unknown')
  }
  let seq: bigint | undefined
  if (p.seq !== undefined && p.seq !== null) {
    const value =
      typeof p.seq === 'bigint'
        ? p.seq
        : typeof p.seq === 'number' && Number.isSafeInteger(p.seq)
          ? BigInt(p.seq)
          : undefined
    if (value === undefined || value < 0n || value > MAX_HERDR_SEQ)
      return invalid('seq must be an unsigned 64-bit integer')
    seq = value
  }
  let resumeArgv: string[] | undefined
  if (method !== 'pane.release_agent' && p.resume_argv !== undefined && p.resume_argv !== null) {
    if (!Array.isArray(p.resume_argv) || p.resume_argv.some((arg) => typeof arg !== 'string'))
      return invalid('resume_argv must be an array of strings')
    const argv = p.resume_argv as string[]
    const problem = resumeArgvProblem(argv)
    if (problem) return { ...request, invalid: { code: 'invalid_resume_argv', message: problem } }
    resumeArgv = argv
  }
  const message = method === 'pane.report_agent' ? text(p.message) : undefined
  const sessionId = method === 'pane.release_agent' ? undefined : text(p.agent_session_id)
  return {
    ...request,
    report: {
      method: method as HerdrReportMethod,
      paneId,
      source,
      agent,
      ...(state ? { state } : {}),
      ...(message ? { message } : {}),
      ...(seq !== undefined ? { seq } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(resumeArgv ? { resumeArgv } : {})
    }
  }
}

/** The id of a request line that did not parse, when one can still be read. */
export function requestIdOf(line: string): string {
  try {
    const id = (JSON.parse(line) as { id?: unknown }).id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/** A success reply line (herdr's `{"type":"ok"}` result). */
export function herdrOk(id: string): string {
  return `${JSON.stringify({ id, result: { type: 'ok' } })}\n`
}

/** An error reply line. */
export function herdrError(id: string, code: string, message: string): string {
  return `${JSON.stringify({ id, error: { code, message } })}\n`
}

/** What nsq answers for the rest of herdr's API (splits, waits, events…). */
export function herdrUnsupported(id: string, method: string): string {
  return herdrError(
    id,
    'unknown_method',
    `unknown method: ${method} (this host implements only the agent state reports of the herdr protocol)`
  )
}

/**
 * On Windows herdr's socket is a named pipe whose name is the socket path
 * (`\\.\pipe\` + the path); a marker file sits at the path itself.
 */
export function herdrPipeName(socketPath: string): string {
  return `\\\\.\\pipe\\${socketPath}`
}

/**
 * Pane ids that name an agent: `<agentId>.<HMAC(secret, agentId)>`. An agent
 * learns only its own (it is in its environment), so it cannot report for
 * another one; the secret is the host's, per run.
 */
export interface HerdrPanes {
  paneIdFor(agentId: string): string
  /** The agent a pane id names, or null unless it carries the right HMAC. */
  agentOf(paneId: string): string | null
}

export function createHerdrPanes(secret: string | Buffer): HerdrPanes {
  const paneIdFor = (agentId: string): string =>
    `${agentId}.${createHmac('sha256', secret).update(`herdr-pane:${agentId}`).digest('hex').slice(0, 32)}`
  return {
    paneIdFor,
    agentOf(paneId) {
      const dot = paneId.lastIndexOf('.')
      if (dot <= 0) return null
      const agentId = paneId.slice(0, dot)
      const want = Buffer.from(paneIdFor(agentId))
      const got = Buffer.from(paneId)
      return want.length === got.length && timingSafeEqual(want, got) ? agentId : null
    }
  }
}
