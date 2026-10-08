// Plain text of raw pty output, for the marker scans in ptyManager.ts (trust
// dialogs, "session not found", update prompts, hints). See the long comment
// above `stripAnsi`'s use in ptyManager.ts for why escape sequences are
// stripped at all.

// eslint-disable-next-line no-control-regex -- \x1b/\x07 are the real ESC/BEL bytes an ANSI stripper has to match, not accidental
const ANSI_ESCAPE_PATTERN = /\x1b(?:][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g

// Cursor positioning — forward (`ESC [ n C`), to a column (`ESC [ n G`), to a
// cell (`ESC [ r ; c H` / `f`) — stands for the cells it skips. **Found by the
// macOS e2e**: in a pty on macOS (no ConPTY re-rendering the screen into
// plain runs, as on Windows) Claude Code draws only the cells that changed,
// jumping over the blank ones between the words of its folder-trust dialog;
// stripping those jumps to nothing gave "Quicksafetycheck", the trust marker
// never matched and every new agent in a new folder sat on the dialog. A
// space keeps the words apart (collapseWhitespace squeezes the extras).
// eslint-disable-next-line no-control-regex -- the real ESC byte
const CURSOR_MOVE_PATTERN = /\x1b\[[\d;]*[CGHf]/g

export function stripAnsi(text: string): string {
  return text.replace(CURSOR_MOVE_PATTERN, ' ').replace(ANSI_ESCAPE_PATTERN, '')
}
