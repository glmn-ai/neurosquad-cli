// The pairing token: the one secret that guards the phone API.
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 24 random bytes, as 48 hex characters — the same strength as the desktop's pairing token. */
export const PAIRING_TOKEN_BYTES = 24

export function generatePairingToken(): string {
  return randomBytes(PAIRING_TOKEN_BYTES).toString('hex')
}

/** A plausible pairing token (what a host should accept when reading one back from its config). */
export function isPairingToken(value: unknown): value is string {
  return (
    typeof value === 'string' && new RegExp(`^[0-9a-f]{${PAIRING_TOKEN_BYTES * 2}}$`).test(value)
  )
}

/**
 * Constant-time compare. `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal, so a mismatch is answered with a dummy compare of equal length.
 */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || b.length === 0) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}
