# @neurosquad/term-view

Live agent terminals as tiles. Each agent's pty output feeds a headless
[xterm.js](https://xtermjs.org/) screen (`@xterm/headless`); a diff renderer
paints that screen into any rectangle of the host terminal, sending only the
cells that changed. Framework-agnostic: it writes ANSI strings, so it can sit
next to an Ink UI, a hand-written TUI or nothing at all.

```ts
import { createCompositor, createTermView } from '@neurosquad/term-view'

const view = createTermView({ cols: 120, rows: 40, owner: true })
pty.onData((data) => view.write(data))
view.onReply((answer) => pty.write(answer)) // DA / CPR / OSC 10/11 answers — owner only

const compositor = createCompositor({
  write: (frame) => process.stdout.write(frame),
  fps: 30,
  hostSize: { cols: process.stdout.columns, rows: process.stdout.rows }
})
const tile = compositor.addTile(view, { x: 0, y: 1, width: 60, height: 20 })
```

## Pieces

| Export                                                               | What it does                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTermView({ cols, rows, scrollback, owner, unicode, colors })` | One agent's screen. `write(data)`, `resize(cols, rows)` (no-op when unchanged), `snapshot(into?)` → `Grid`, `serialize()`, `recentLines(n)`, `modes()`, `onChange`, `onReply`, `onTitle`, `onBell`, `respawn()`, `setOwner()`.                                                                       |
| `Grid`                                                               | Flat cell arrays: `chars` (graphemes, combining marks, ZWJ clusters), `widths` (1, 2, 0 for the right half of a wide char), packed `fg`/`bg` (default, 256-palette or truecolor — see `color.ts`), `attrs` (`ATTR_BOLD`, `ATTR_ITALIC`, `ATTR_UNDERLINE`, `ATTR_INVERSE`, …), `cursor`, `alternate`. |
| `createTileRenderer({ rect, fit, depth, downgrade, hostSize })`      | The diff renderer for one rectangle: `render(grid)` returns the ANSI that brings the rect up to date.                                                                                                                                                                                                |
| `createCompositor({ write, fps, colors, hostSize })`                 | Many tiles, one frame per tick at most `fps`, wrapped in synchronized output and save/restore cursor.                                                                                                                                                                                                |
| `encodePaste`, `encodeFocus`, `hostModeChanges`                      | Input for attach mode: bracketed paste / focus events only when the agent asked, host input modes mirrored from the agent.                                                                                                                                                                           |
| `attachReplay(view)`, `detachReset(view)`                            | Raw attach (`nsq attach`): the bytes to write before streaming the pty, and on detach.                                                                                                                                                                                                               |
| `parseCast`, `formatCast`                                            | asciicast v2, the format of the recorded sample streams.                                                                                                                                                                                                                                             |

## Rules the engine keeps

- **One owner per agent answers terminal queries.** A program asks the
  terminal for device attributes, the cursor position or its colours and
  reads the answer from stdin. Every view of that pty parses the question;
  only the view created with `owner: true` (or given `setOwner(true)`) emits
  answers through `onReply`. Mirrors stay silent — a second answer lands in
  the agent's input box as literal text. `respawn()` drops answers to
  questions from a process that has been replaced. The owner's size must be
  the pty's size.
- **Tiles never resize the agent.** A tile smaller than the agent's screen
  shows a window onto it (`fit`): `'follow'` (default) keeps the cursor and
  the newest lines in view, bottom-aligned, and only moves sideways for a
  visible cursor past the right edge; `'top-left'`, `'bottom-left'`,
  `'bottom-right'` clip from a corner. No reflow.
- **Resize only on change.** `view.resize()` returns false and does nothing
  for the same cols/rows; forward the pty resize only when it returns true.
- **Only changed cells are sent.** The renderer keeps what it last painted;
  per frame it emits a cursor move only when the next changed cell is not
  where the host cursor already is (`CUF` inside a row, `CUP` otherwise), an
  SGR only when the pen changes (as a delta), then the characters. No clears,
  so no flicker; an unchanged screen costs zero bytes.
- **Unicode widths.** `unicode: 'graphemes'` (default) measures like Windows
  Terminal 1.22+, iTerm2, WezTerm, kitty, Ghostty; `'11'` like terminals that
  measure per code point. After a wide or clustered cell the renderer
  positions the next cell absolutely, so a host that measures one character
  differently misdraws that cell only. A wide character cut by a tile edge is
  drawn as a blank. `resync: 'non-ascii'` re-anchors after every non-ASCII
  character, for hosts that draw ambiguous-width characters wide.
- **Alternate screen.** Full-screen TUIs (OpenCode, `htop`) are shown from
  the alternate buffer while they own it; the normal screen and scrollback
  come back when they leave.
- **Agent frames are not torn.** While an agent is inside its own
  synchronized update (`CSI ? 2026 h`), its tile is held back (up to
  `SYNC_TIMEOUT_MS`).
- **Colour depth.** `depth: 'truecolor' | 256 | 16 | 'none'`; colours are
  mapped by `downgrade(color, depth, layer)` — `defaultDowngrade` (nearest
  xterm palette entry) unless the caller passes its own (the theme package's
  helpers plug in here).

## Mounting tiles in a TUI (for `apps/cli`)

1. Keep one `TermView` per agent for the agent's lifetime, fed with the
   daemon's output frames. Create it with the agent's pty size; call
   `view.resize()` when the daemon reports a new pty size. Decide who owns
   the replies: if the daemon answers queries itself, every client view is a
   mirror (`owner: false`, the default).
2. One `Compositor` for the screen. Lay out with Ink as usual, leaving each
   tile's area empty (a fixed-size `Box`), and give the compositor the
   absolute rects (`tile.setRect`) and the host size (`setHostSize` on
   `SIGWINCH` / `process.stdout.on('resize')`).
3. Whenever Ink (or anything else) redraws over a tile's area, call
   `tile.invalidate()` (or `compositor.invalidateAll()` after a full Ink
   repaint). Frames save and restore the host cursor, so Ink's own cursor
   bookkeeping is undisturbed; pass `paused: true` and call
   `compositor.renderFrame()` yourself to write frames in step with Ink.
4. The expanded tile: `addTile(view, fullRect, { showCursor: true,
syncInputModes: true })` — the host cursor sits on the agent's cursor and
   the host's input modes follow the agent's, so keys, bracketed pastes,
   focus events and mouse reports go to the pty in the form it expects.
   Before leaving, write `compositor.restoreInputModes()`.
5. Raw attach (`nsq attach`): pause the compositor, resize the pty to the
   host, write `attachReplay(view)`, then stream pty output straight to
   stdout; on detach write `detachReset(view)`, resume and `invalidateAll()`.

## Benchmark

`npm run build && node packages/term-view/bench/bench.mjs` replays the
recorded sample streams (`fixtures/*.cast.gz`, made by
`fixtures/fake-harness.mjs` — no real CLI, login or network) into 9 tiles.
Options: `--fps`, `--speed` (replay faster), `--cols/--rows` (host size),
`--depth`, `--async` (xterm's normal asynchronous parse: measures latency
instead of CPU), `--tty` (paint into this terminal in real time — run it in
Windows Terminal to watch), `--json`, `--out`.
Re-record the streams with `node packages/term-view/fixtures/record.mjs`.
