// Reads the tail of each Claude Code agent's transcript for the status machine
// (claudeStatusTranscript.ts says what the entries mean, agentStatusMachine.ts
// what to do about it, agentHooks.ts when to look).
//
// Cheap by construction: the first look at a session reads only its last
// TAIL_BYTES (transcripts here reach 30 MB — the phase of the current turn is
// always in the tail), later looks read only what was appended, and a look at
// an unchanged file is one `stat`. Where the file is comes from the hooks
// themselves: every Claude Code hook payload carries `transcript_path`, which
// also follows `/clear` (a new session id, a new file) and account profiles.
// A path that cannot be read (a agent in an SSH/WSL target — the path is on the
// other machine) switches the reconciliation off for that agent; its hooks and
// the quiet check still work as before.
import { stat } from 'node:fs/promises'
import { readNewLines, type FileCursor } from '../usage/lineReader.js'
import { emptyView, ingestLine, type TranscriptView } from './claudeTranscript.js'

/** How much of an existing transcript the first look reads. */
const TAIL_BYTES = 256 * 1024
/** Appended since the last look beyond this: skip to the tail instead of reading it all. */
const MAX_CATCH_UP_BYTES = 2 * 1024 * 1024

interface Tail {
  path: string
  cursor: FileCursor | null
  view: TranscriptView
  seenSize: number
  seenMtimeMs: number
  /** One read at a time per agent: they share the cursor. */
  queue: Promise<unknown>
  /**
   * Reads that failed in a row (not there yet is not a failure — gone or
   * unreadable after it existed is). One failure is often a moment: Windows
   * answers EBUSY/EPERM while Claude or an antivirus holds the file.
   */
  failures: number
  /** MAX_FAILURES in a row: reconciliation off until a hook names the file again. */
  unreadable?: boolean
}

/** Failed reads in a row before a agent's transcript counts as unreadable. */
const MAX_FAILURES = 5

const tails = new Map<string, Tail>()

/** Only a real JSONL path is ever opened (the payload comes from the harness). */
function plausible(path: string): boolean {
  return /\.jsonl$/i.test(path) && /[\\/]projects[\\/]/.test(path)
}

/** The transcript a hook named for this agent. A different path (after `/clear`) starts over. */
export function noteTranscriptPath(agentId: string, path: unknown): void {
  if (typeof path !== 'string' || !plausible(path)) return
  const current = tails.get(agentId)
  if (current?.path === path) {
    // A hook naming it again: worth another try.
    if (current.unreadable) {
      current.unreadable = false
      current.failures = 0
    }
    return
  }
  tails.set(agentId, {
    path,
    cursor: null,
    view: emptyView(),
    seenSize: -1,
    seenMtimeMs: -1,
    failures: 0,
    queue: Promise.resolve()
  })
}

export function hasTranscript(agentId: string): boolean {
  const tail = tails.get(agentId)
  return Boolean(tail && !tail.unreadable)
}

/** The last view read, without touching the disk. */
export function cachedTranscriptView(agentId: string): TranscriptView | undefined {
  return tails.get(agentId)?.view
}

export function forgetTranscript(agentId: string): void {
  tails.delete(agentId)
}

function failed(tail: Tail): void {
  tail.failures += 1
  if (tail.failures >= MAX_FAILURES) tail.unreadable = true
}

async function readTail(tail: Tail): Promise<TranscriptView | null> {
  let info: { size: number; mtimeMs: number }
  try {
    info = await stat(tail.path)
  } catch {
    // Not written yet (Claude creates it with the first prompt) — or gone.
    if (tail.seenSize >= 0) failed(tail)
    return null
  }
  if (info.size === tail.seenSize && info.mtimeMs === tail.seenMtimeMs) return tail.view
  if (!tail.cursor || info.size - tail.cursor.offset > MAX_CATCH_UP_BYTES) {
    // Start (again) at the tail: the first line read there is a fragment and
    // fails to parse, which is what a malformed line does anyway.
    const offset = Math.max(0, info.size - TAIL_BYTES)
    tail.cursor = { size: offset, offset }
    tail.view = emptyView()
  }
  let view = tail.view
  try {
    await readNewLines(
      tail.path,
      tail.cursor,
      (line) => {
        view = ingestLine(view, line)
      },
      // Rewritten from scratch: everything read before is void.
      () => {
        view = emptyView()
      }
    )
  } catch {
    // The cursor may have moved past lines that were never applied: the next
    // read starts over at the tail.
    tail.cursor = null
    failed(tail)
    return null
  }
  tail.failures = 0
  tail.view = view
  tail.seenSize = info.size
  tail.seenMtimeMs = info.mtimeMs
  return view
}

/** Reads what was appended to this agent's transcript and returns the view (null: none readable). */
export function refreshTranscript(agentId: string): Promise<TranscriptView | null> {
  const tail = tails.get(agentId)
  if (!tail || tail.unreadable) return Promise.resolve(null)
  const next = tail.queue.then(() => readTail(tail))
  tail.queue = next.catch(() => null)
  return next.catch(() => null)
}
