// What a chunk written into a pty (writeToPty — keys, pastes, programmatic
// text) does to the harness's input line, judged from the bytes alone.

import { stripAnsi } from './plainText.js'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** The chunk with every bracketed paste's content cut out (an unclosed one runs to the end). */
function outsidePastes(data: string): string {
  let rest = data
  let out = ''
  for (;;) {
    const start = rest.indexOf(PASTE_START)
    if (start < 0) return out + rest
    out += rest.slice(0, start)
    const end = rest.indexOf(PASTE_END, start + PASTE_START.length)
    if (end < 0) return out
    rest = rest.slice(end + PASTE_END.length)
  }
}

/**
 * Does this chunk submit the input (an Enter)? A line break *inside* a
 * bracketed paste is part of the pasted text — the harness keeps it in its
 * input box (a hand-off seed, a multi-line paste) — not a submit.
 */
export function submitsInput(data: string): boolean {
  return /[\r\n]/.test(outsidePastes(data))
}

/**
 * Might this chunk leave something in the harness's input box: typed or
 * pasted text, an edit key (Backspace — there was something to edit), or an
 * interrupt key (Escape / Ctrl+C — several harnesses put an interrupted
 * prompt back into the input). Terminal replies and cursor/focus sequences
 * (CSI, OSC) do not. Conservative: when unsure, yes.
 */
export function mayLeaveDraft(data: string): boolean {
  if (data === '\x1b' || data === '\x03') return true
  const plain = stripAnsi(data.replaceAll(PASTE_START, '').replaceAll(PASTE_END, ''))
  // eslint-disable-next-line no-control-regex -- printable text, DEL and Backspace
  return /[^\x00-\x07\x09-\x1f]/.test(plain)
}
