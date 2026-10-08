// The keys each harness's own approval dialog takes — what the person would
// press. Sent as the person's input, so the status machine moves the agent
// on at once.
import type { HarnessId } from '@neurosquad/core'

export type AnswerKey = 'yes' | 'always' | 'no'

/** Keys as separate presses: a dialog may not take a burst (an arrow and Enter in one write). */
const KEYS: Partial<Record<HarnessId, Record<AnswerKey, readonly string[]>>> = {
  // "1. Yes / 2. Yes, and don't ask again … / 3. No, and tell Claude what to do differently (esc)"
  'claude-code': { yes: ['1'], always: ['2'], no: ['3'] },
  // "Yes, proceed (y) / Yes, and don't ask again … (a) / No, and tell Codex what to do differently (esc)"
  // (0.162: "Yes, and don't ask again for commands that start with … (p)")
  'codex-cli': { yes: ['y'], always: ['p'], no: ['\x1b'] },
  // "Allow once / Allow always / Reject": Enter on the first option, Right then Enter, Escape.
  // (1.18: "Allow once  Allow always  Reject — ⇆ select · enter confirm")
  // "Allow always" asks once more ("Always allow … Confirm / Cancel"): Enter confirms.
  opencode: { yes: ['\r'], always: ['\x1b[C', '\r', '\r'], no: ['\x1b'] }
}

/** Pause between two presses of one answer. */
export const KEY_GAP_MS = 400

export function answerKeys(harness: HarnessId, key: AnswerKey): readonly string[] | null {
  return KEYS[harness]?.[key] ?? null
}
