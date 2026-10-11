// What one agent's herdr reports mean, given what it reported before. Pure:
// the status hub (../status/hub.ts) keeps one PaneState per agent process and
// acts on the effects.
//
// herdr's own rules, kept here so an agent behaves the same in nsq as in
// herdr: a report whose `seq` is not above the last one from its source is
// stale and ignored (still answered ok); a resume command is accepted only
// from the source that holds the pane through a state report; a release
// clears the holder and its resume command.
import type { HerdrReport } from './protocol.js'

export interface HerdrPaneState {
  /** The last accepted seq per source. */
  seqs: Record<string, bigint>
  /** Who holds the pane: the source and agent of the last state report. */
  holder?: { source: string; agent: string }
  /** A turn was reported working (or blocked) and has not ended yet. */
  open?: boolean
}

/**
 * What the report means for the agent's status: a hook fact, or `ready` —
 * the agent is at its prompt with nothing new to say (its first report after
 * it started, or a block that resolved with no turn running).
 */
export type HerdrFact =
  | { kind: 'working' }
  | { kind: 'needs-input'; detail: string }
  | { kind: 'finished' }
  | { kind: 'ready' }

export interface HerdrEffects {
  state: HerdrPaneState
  /** False when the report was stale (an older seq): nothing else is set. */
  applied: boolean
  /** Answer with this error instead of ok (nothing else is set). */
  error?: { code: string; message: string }
  fact?: HerdrFact
  /** The agent's session id. */
  sessionId?: string
  /** A resume command to keep, or null to forget the one kept (a release). */
  resume?: string[] | null
  /** The agent released the pane (it is quitting). */
  released?: boolean
  /** The agent's name, from a state report. */
  agent?: string
}

export function emptyHerdrPane(): HerdrPaneState {
  return { seqs: {} }
}

function isNewer(state: HerdrPaneState, source: string, seq: bigint | undefined): boolean {
  const last = state.seqs[source]
  return seq !== undefined ? last === undefined || seq > last : last === undefined
}

export function applyHerdrReport(state: HerdrPaneState, report: HerdrReport): HerdrEffects {
  const { source, agent, seq } = report
  const holds = state.holder?.source === source && state.holder.agent === agent
  if (report.method === 'pane.report_agent_session' && report.resumeArgv && !holds) {
    return {
      state,
      applied: false,
      error: {
        code: 'resume_not_accepted',
        message:
          'resume_argv requires the reporter to hold the pane; report its state with pane.report_agent first'
      }
    }
  }
  if (!isNewer(state, source, seq)) return { state, applied: false }
  const seqs = seq !== undefined ? { ...state.seqs, [source]: seq } : state.seqs
  const session = report.sessionId ? { sessionId: report.sessionId } : {}
  switch (report.method) {
    case 'pane.release_agent': {
      if (!holds) return { state: { ...state, seqs }, applied: true }
      return { state: { seqs }, applied: true, resume: null, released: true }
    }
    case 'pane.report_agent_session':
      return {
        state: { ...state, seqs },
        applied: true,
        ...session,
        ...(report.resumeArgv ? { resume: report.resumeArgv } : {})
      }
    case 'pane.report_agent': {
      const next: HerdrPaneState = { ...state, seqs, holder: { source, agent } }
      let fact: HerdrFact | undefined
      switch (report.state) {
        case 'working':
          next.open = true
          fact = { kind: 'working' }
          break
        case 'blocked':
          next.open = true
          // herdr's `--message` explains the block; without one (Crush), at least who waits.
          fact = {
            kind: 'needs-input',
            detail: report.message ?? `${agent} is waiting for your decision`
          }
          break
        case 'idle':
          // The first report of every process is `idle` (it registers); only the end of a
          // turn that was seen to start is "finished".
          fact = state.open ? { kind: 'finished' } : { kind: 'ready' }
          delete next.open
          break
        default:
          break
      }
      return {
        state: next,
        applied: true,
        agent,
        ...(fact ? { fact } : {}),
        ...session,
        ...(report.resumeArgv ? { resume: report.resumeArgv } : {})
      }
    }
  }
}
