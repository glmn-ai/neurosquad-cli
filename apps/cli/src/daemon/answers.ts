// The keys each harness's own approval dialog takes — what the person would
// press. Sent as the person's input, so the status machine moves the agent
// on at once.
import type { HarnessId } from '@neurosquad/core'

export type AnswerKey = 'yes' | 'always' | 'no'

const KEYS: Partial<Record<HarnessId, Record<AnswerKey, string>>> = {
  // "1. Yes / 2. Yes, and don't ask again … / 3. No, and tell Claude what to do differently (esc)"
  'claude-code': { yes: '1', always: '2', no: '3' },
  // "Yes, proceed (y) / Yes, and don't ask again … (a) / No, and tell Codex what to do differently (esc)"
  'codex-cli': { yes: 'y', always: 'a', no: '\x1b' },
  // "Allow once / Allow always / Reject": Enter on the first option, `a`, Escape.
  opencode: { yes: '\r', always: 'a', no: '\x1b' }
}

export function answerKeys(harness: HarnessId, key: AnswerKey): string | null {
  return KEYS[harness]?.[key] ?? null
}
