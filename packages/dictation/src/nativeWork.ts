// Tracks native async calls (sherpa-onnx `createAsync` / `decodeAsync`). They
// run as N-API async workers on the libuv thread pool; if one completes while
// Node is tearing the environment down, its completion cannot call back into
// JS and the process aborts (SIGABRT). So every such call is tracked, and
// shutdown first stops new ones and then waits (bounded) for the running ones.

export class NativeWork {
  private readonly inFlight = new Set<Promise<unknown>>()
  private closing = false

  /** Registers a native async call; returns it unchanged. */
  track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work)
    const done = (): void => {
      this.inFlight.delete(work)
    }
    work.then(done, done)
    return work
  }

  /**
   * Starts a native call unless shutdown has begun, and tracks it. Check and
   * start are one step, so nothing can slip in after `close()`.
   */
  start<T>(start: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('dictation is shutting down'))
    return this.track(start())
  }

  get isClosing(): boolean {
    return this.closing
  }

  get count(): number {
    return this.inFlight.size
  }

  /**
   * Stops new work and waits until nothing is running (including work started
   * by work that just finished), at most `timeoutMs`.
   */
  async close(timeoutMs: number): Promise<{ waited: number; idle: boolean; ms: number }> {
    this.closing = true
    const started = Date.now()
    const seen = new Set<Promise<unknown>>()
    while (this.inFlight.size > 0) {
      const left = timeoutMs - (Date.now() - started)
      if (left <= 0) break
      for (const work of this.inFlight) seen.add(work)
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, left)
        })
      ])
      clearTimeout(timer)
      // A `.then` of a finished call may start the next one on this tick.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return { waited: seen.size, idle: this.inFlight.size === 0, ms: Date.now() - started }
  }
}
