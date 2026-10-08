// Every node-pty child must be seen to exit before the host quits.
//
// node-pty (1.1.0) watches each child from a thread of its own (kqueue on
// macOS, waitpid on Linux, the ConPTY process handle on Windows) and reports
// the exit through a `Napi::ThreadSafeFunction` into JS. It is built with
// C++ exceptions (node_addon_api_except): if that report lands after
// `will-quit`, while the runtime is already tearing Node down, calling into JS
// fails, node-addon-api throws `Napi::Error` from a place nothing catches,
// and the process aborts — `libc++abi: terminating due to uncaught exception
// of type Napi::Error` + SIGABRT on macOS ,
// 0xC0000409 (fail fast) on Windows. `killAllPtys` used to kill and move on:
// a shell or a harness that took a moment to die (Claude Code needs ~2 s after
// SIGHUP) exited exactly in that window.
//
// So every local pty is tracked from spawn until its exit event, and the quit
// waits for all of them: first the ordinary signal's grace period, then
// SIGKILL for whatever is left (a process that ignores SIGHUP), then a short
// final wait. Once a pty's JS `exit` fired, its native thread has delivered
// its one call and holds nothing more — nothing can land in the teardown.
import type { IPty } from 'node-pty'

const live = new Map<IPty, Promise<void>>()

/** Tracks a freshly spawned local pty until its process exits. Returns it. */
export function trackPtyExit(pty: IPty): IPty {
  const exited = new Promise<void>((resolve) => {
    pty.onExit(() => {
      live.delete(pty)
      resolve()
    })
  })
  live.set(pty, exited)
  return pty
}

/** Local ptys whose process has not exited yet. */
export function livePtyCount(): number {
  return live.size
}

function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export interface PtyExitWaitResult {
  /** Ptys that were still alive when the wait began. */
  waited: number
  /** Sent SIGKILL (still alive after the grace period). */
  forced: number
  /** Still alive after everything (the quit goes on anyway). */
  stuck: number
  ms: number
}

/**
 * Waits for every tracked pty to exit: `graceMs`, then SIGKILL (on Windows a
 * second plain kill — ConPTY takes no signals) and `forceMs` more. Bounded:
 * the quit never hangs on a process that will not die.
 */
export async function waitForPtyExits(
  graceMs: number,
  forceMs: number,
  platform: NodeJS.Platform = process.platform
): Promise<PtyExitWaitResult> {
  const started = Date.now()
  const entries = [...live.entries()]
  const all = Promise.all(entries.map(([, exited]) => exited))
  const result = { waited: entries.length, forced: 0, stuck: 0, ms: 0 }
  if (entries.length && !(await settledWithin(all, graceMs))) {
    for (const [pty] of entries) {
      if (!live.has(pty)) continue
      try {
        if (platform === 'win32') pty.kill()
        else pty.kill('SIGKILL')
        result.forced++
      } catch {
        // Already gone between the check and the kill.
      }
    }
    await settledWithin(all, forceMs)
    result.stuck = entries.filter(([pty]) => live.has(pty)).length
  }
  result.ms = Date.now() - started
  return result
}
