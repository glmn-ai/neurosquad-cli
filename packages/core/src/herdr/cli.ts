// The herdr CLI's three reporting subcommands, as the shim at HERDR_BIN_PATH
// implements them (`"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID"
// --source x --agent x --state working [--message …] [--seq N]
// [--agent-session-id …] -- <resume command…>`, `pane report-agent-session`,
// `pane release-agent`). Same arguments and exit codes as herdr's own CLI: 0
// done, 1 the host refused the report, 2 a usage error. Anything else of
// herdr's CLI is refused with a clear message.

export type HerdrCliResult =
  | { request: { id: string; method: string; params: Record<string, unknown> } }
  | { exit: number; stdout?: string; stderr?: string }

const UNSUPPORTED =
  'this is nsq, not herdr: it implements only the agent state reports of the herdr protocol ' +
  '(pane report-agent, pane report-agent-session, pane release-agent)'

interface Spec {
  method: string
  usage: string
  options: readonly string[]
  required: readonly string[]
  resume: boolean
}

const SPECS: Record<string, Spec> = {
  'report-agent': {
    method: 'pane.report_agent',
    usage:
      'usage: herdr pane report-agent <pane_id> --source ID --agent LABEL --state idle|working|blocked|unknown [--message TEXT] [--seq N] [--agent-session-id ID] [--agent-session-path PATH] [-- <resume-command...>]',
    options: [
      'source',
      'agent',
      'state',
      'message',
      'seq',
      'agent-session-id',
      'agent-session-path'
    ],
    required: ['source', 'agent', 'state'],
    resume: true
  },
  'report-agent-session': {
    method: 'pane.report_agent_session',
    usage:
      'usage: herdr pane report-agent-session <pane_id> --source ID --agent LABEL [--seq N] [--agent-session-id ID] [--agent-session-path PATH] [--session-start-source SOURCE] [-- <resume-command...>]',
    options: [
      'source',
      'agent',
      'seq',
      'agent-session-id',
      'agent-session-path',
      'session-start-source'
    ],
    required: ['source', 'agent'],
    resume: true
  },
  'release-agent': {
    method: 'pane.release_agent',
    usage: 'usage: herdr pane release-agent <pane_id> --source ID --agent LABEL [--seq N]',
    options: ['source', 'agent', 'seq'],
    required: ['source', 'agent'],
    resume: false
  }
}

import { MAX_HERDR_SEQ } from './protocol.js'

const STATES = new Set(['idle', 'working', 'blocked', 'unknown'])

export function parseHerdrCli(argv: readonly string[]): HerdrCliResult {
  const [group, sub, ...rest] = argv
  if (group === '--version' || group === '-V' || group === 'version') {
    return { exit: 0, stdout: 'nsq herdr-protocol shim (agent state reports only)\n' }
  }
  const spec = group === 'pane' && sub ? SPECS[sub] : undefined
  if (!spec) return { exit: 1, stderr: `${UNSUPPORTED}\n` }
  const separator = spec.resume ? rest.indexOf('--') : -1
  const args = separator >= 0 ? rest.slice(0, separator) : rest
  const resume = separator >= 0 ? rest.slice(separator + 1) : undefined
  const values = new Map<string, string>()
  let paneId: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
      if (!spec.options.includes(name)) return { exit: 2, stderr: `unknown option: ${arg}\n` }
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i]
      if (value === undefined) return { exit: 2, stderr: `missing value for --${name}\n` }
      values.set(name, value)
      continue
    }
    if (arg.startsWith('-')) return { exit: 2, stderr: `unknown option: ${arg}\n` }
    if (paneId !== undefined) return { exit: 2, stderr: `unexpected argument: ${arg}\n` }
    paneId = arg
  }
  if (paneId === undefined) return { exit: 2, stderr: `${spec.usage}\n` }
  for (const name of spec.required) {
    const value = values.get(name)
    if (value === undefined || (name === 'source' && !value.trim()))
      return { exit: 2, stderr: `missing required --${name}\n` }
  }
  const state = values.get('state')
  if (state !== undefined && !STATES.has(state)) {
    return {
      exit: 2,
      stderr: `invalid pane agent state: ${state} (expected idle, working, blocked, or unknown)\n`
    }
  }
  const seqText = values.get('seq')
  let seq: bigint | undefined
  if (seqText !== undefined) {
    seq = /^\d{1,20}$/.test(seqText) ? BigInt(seqText) : undefined
    if (seq === undefined || seq > MAX_HERDR_SEQ)
      return { exit: 2, stderr: `invalid value for --seq: ${seqText}\n` }
  }
  const params: Record<string, unknown> = {
    pane_id: paneId,
    source: values.get('source')!.trim(),
    agent: values.get('agent')
  }
  if (state !== undefined) params.state = state
  for (const [option, key] of [
    ['message', 'message'],
    ['agent-session-id', 'agent_session_id'],
    ['agent-session-path', 'agent_session_path'],
    ['session-start-source', 'session_start_source']
  ] as const) {
    const value = values.get(option)
    if (value !== undefined) params[key] = value
  }
  if (seq !== undefined) params.seq = seq
  if (resume !== undefined) params.resume_argv = resume
  return { request: { id: 'cli:request', method: spec.method, params } }
}

/** The shim's exit code for the host's reply line (herdr prints an error reply and exits 1). */
export function herdrCliReply(reply: string): { exit: number; stderr?: string } {
  try {
    const parsed = JSON.parse(reply) as { error?: unknown }
    if (parsed && typeof parsed === 'object' && parsed.error !== undefined)
      return { exit: 1, stderr: `${reply.trim()}\n` }
    return { exit: 0 }
  } catch {
    return { exit: 1, stderr: 'herdr: no valid reply from the host\n' }
  }
}
