// Brute-force lockout for requests from the internet (through the tunnel): a few wrong pairing
// tokens from one address within a window lock that address out for a while. Stricter than the
// per-minute throttle the server applies everywhere, because online anyone can try.

export interface LockoutOptions {
  /** Wrong tokens per address within `windowMs` that lock it. Default 5. */
  attempts: number
  /** Default 15 minutes. */
  windowMs: number
  /** How long a locked address stays locked. Default 15 minutes. */
  lockMs: number
  /** Addresses remembered at most (the oldest are forgotten first). Default 10 000. */
  maxEntries: number
}

export const DEFAULT_LOCKOUT: LockoutOptions = {
  attempts: 5,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  maxEntries: 10_000
}

interface Entry {
  failures: number
  windowStart: number
  lockedUntil: number
}

export class Lockout {
  private readonly entries = new Map<string, Entry>()
  private readonly options: LockoutOptions

  constructor(
    options: Partial<LockoutOptions> = {},
    private readonly now: () => number = Date.now
  ) {
    this.options = { ...DEFAULT_LOCKOUT, ...options }
  }

  /** Milliseconds this address stays locked, or 0. */
  remaining(key: string): number {
    const entry = this.entries.get(key)
    if (!entry) return 0
    const left = entry.lockedUntil - this.now()
    return left > 0 ? left : 0
  }

  /** Records a wrong token; true when the address is locked now. */
  fail(key: string): boolean {
    const now = this.now()
    let entry = this.entries.get(key)
    if (!entry || (now - entry.windowStart > this.options.windowMs && entry.lockedUntil <= now)) {
      entry = { failures: 0, windowStart: now, lockedUntil: 0 }
    }
    // Re-inserted so the map stays in least-recently-failed order.
    this.entries.delete(key)
    this.entries.set(key, entry)
    entry.failures += 1
    if (entry.failures >= this.options.attempts) entry.lockedUntil = now + this.options.lockMs
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return entry.lockedUntil > now
  }

  /** A right token: the address starts over. */
  succeed(key: string): void {
    const entry = this.entries.get(key)
    if (entry && entry.lockedUntil <= this.now()) this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
