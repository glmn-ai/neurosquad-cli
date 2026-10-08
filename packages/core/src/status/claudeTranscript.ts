// What the tail of a Claude Code transcript says the session is doing — the
// ground truth the status machine reconciles its hooks against
// (agentStatusMachine.ts `transcript` signal, claudeStatusReconciler.ts).
//
// Hooks are the fast path, but some turn endings send none (measured on
// 2.1.287 with the fake model, scripts/status-e2e and the discovery runs in
// docs/status.md):
//
//   - Escape / Ctrl+C mid-stream: `assistant` (stop_reason null,
//     isAbortedMidStream) + `user` "[Request interrupted by user]". No hook.
//   - Escape mid-tool / "No" on a permission prompt: `tool_result`
//     (toolDenialKind user-rejected) + "[Request interrupted by user for tool
//     use]" (+ `system` turn_duration). No hook.
//   - An API error (429, 529, 400…): a synthetic `assistant` with
//     isApiErrorMessage + turn_duration. No Stop (StopFailure only, which
//     older builds refuse in a settings file).
//   - A prompt typed while a turn runs is queued (`queue-operation`
//     enqueue); UserPromptSubmit fires at the *enqueue*, and the dequeued
//     turn that follows the Stop sends none.
//
// Every turn that ran to its end writes `system` turn_duration right after
// the Stop hooks; an interrupt writes its marker at once. A turn start is a
// `user` entry that is neither a tool result, a CLI-logged slash command
// (`<command-name>`, `<local-command-stdout>`, `!` bash mode…), a meta line
// nor a compaction summary — a typed prompt, a dequeued one, a
// `<task-notification>` (a background task or subagent finished), a
// `<command-message>` slash command that runs the model.
//
// Pure: entries in, a view out. Only entry *types* are looked at — never what
// anyone wrote (the trace and the logs carry none of it).

/** The phase of the latest turn, as far as the transcript tail shows. */
export type TranscriptPhase =
  /** A turn is running: a prompt, a tool call, a tool result the model has not answered yet. */
  | 'busy'
  /** The model answered (end_turn) — the turn end (`ended`) normally follows in milliseconds. */
  | 'answered'
  /** The turn ran to its end (turn_duration). */
  | 'ended'
  /** The person interrupted it (Escape / Ctrl+C / "No" on a prompt). */
  | 'interrupted'
  /** An API error stopped it. */
  | 'error'
  /** Nothing seen yet. */
  | 'unknown'

export interface TranscriptView {
  phase: TranscriptPhase
  /** When the entry that set the phase was written (epoch ms, Claude's own timestamp). */
  at: number
  /** When the latest turn started. */
  turnStartedAt?: number
  /** When the model last wrote a (main-chain, non-error) assistant message. */
  assistantAt?: number
  /** Prompts queued while a turn ran and not taken yet. */
  queued: number
  /** For `error`: the API error's kind (`rate_limit`, `server_error`, `unknown`…) or HTTP status. */
  errorKind?: string
}

export const emptyView = (): TranscriptView => ({ phase: 'unknown', at: 0, queued: 0 })

interface Block {
  type?: string
  text?: string
  content?: unknown
}

export interface Entry {
  type?: string
  subtype?: string
  operation?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isApiErrorMessage?: boolean
  error?: unknown
  apiErrorStatus?: unknown
  timestamp?: string
  message?: { content?: string | Block[]; stop_reason?: string | null }
}

const INTERRUPT = /^\s*\[Request interrupted by user/
/** What the CLI itself logs for slash commands and `!` bash mode — not a turn of the model. */
const CLI_LOGGED =
  /^\s*<(command-name|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/

const SLASH_COMMAND = /^\s*\/[a-z][\w:-]*(\s|$)/i

function textOf(content: string | Block[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** One transcript entry applied to the view. Returns the same object when nothing changed. */
export function ingestEntry(view: TranscriptView, entry: Entry): TranscriptView {
  if (!entry || typeof entry !== 'object') return view
  // A subagent's own conversation: its turns are not the session's.
  if (entry.isSidechain) return view
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : NaN
  const at = Number.isNaN(parsed) ? view.at : parsed
  switch (entry.type) {
    case 'queue-operation': {
      if (entry.operation === 'enqueue') return { ...view, queued: view.queued + 1 }
      if (entry.operation === 'dequeue' || entry.operation === 'remove') {
        return view.queued > 0 ? { ...view, queued: view.queued - 1 } : view
      }
      return view
    }
    case 'system': {
      if (entry.subtype !== 'turn_duration') return view
      // An interrupt or an error is already the end, and says more.
      if (view.phase === 'interrupted' || view.phase === 'error') return view
      return { ...view, phase: 'ended', at }
    }
    case 'assistant': {
      if (entry.isApiErrorMessage) {
        const kind =
          typeof entry.error === 'string'
            ? entry.error
            : typeof entry.apiErrorStatus === 'number'
              ? String(entry.apiErrorStatus)
              : undefined
        return { ...view, phase: 'error', at, ...(kind ? { errorKind: kind } : {}) }
      }
      const content = entry.message?.content
      const usesTool = Array.isArray(content) && content.some((block) => block?.type === 'tool_use')
      const stop = entry.message?.stop_reason
      const phase: TranscriptPhase =
        !usesTool && (stop === 'end_turn' || stop === 'stop_sequence') ? 'answered' : 'busy'
      return { ...view, phase, at, assistantAt: at, errorKind: undefined }
    }
    case 'user': {
      if (entry.isMeta || entry.isCompactSummary) return view
      const content = entry.message?.content
      const text = textOf(content)
      if (INTERRUPT.test(text)) return { ...view, phase: 'interrupted', at, errorKind: undefined }
      if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
        const interrupted = content.some(
          (block) =>
            block?.type === 'tool_result' &&
            typeof block.content === 'string' &&
            INTERRUPT.test(block.content)
        )
        if (interrupted) return { ...view, phase: 'interrupted', at, errorKind: undefined }
        return { ...view, phase: 'busy', at, errorKind: undefined }
      }
      if (CLI_LOGGED.test(text)) return view
      // A slash command as typed ("/compact" is logged like this before the
      // compaction, and no turn follows it — measured). One that runs the
      // model shows as `<command-message>` and assistant entries.
      if (typeof content === 'string' && SLASH_COMMAND.test(content)) return view
      if (!text.trim() && !Array.isArray(content)) return view
      return { ...view, phase: 'busy', at, turnStartedAt: at, errorKind: undefined }
    }
    default:
      return view
  }
}

/** A JSONL line applied to the view; a malformed line changes nothing. */
export function ingestLine(view: TranscriptView, line: string): TranscriptView {
  if (!line.trim()) return view
  try {
    return ingestEntry(view, JSON.parse(line) as Entry)
  } catch {
    return view
  }
}
