# Agent status

While its process runs, an agent is in one of four states (`AgentStatusKind`):

| State                       | Meaning                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `working`                   | a turn is running                                                                                                      |
| `needs-input` ("needs you") | the harness is blocked on the person: a permission prompt, a question, a plan to approve — with the harness's own text |
| `finished`                  | the turn ended and the answer is on screen                                                                             |
| `idle`                      | at its prompt with nothing new to say (the person dismissed a question, interrupted, or the process restarted)         |

When the process is gone the machine publishes nothing more and `agentStatusSnapshot` returns
`null`; hosts show that as "exited" (nsq does).

## Where facts come from

1. **Hooks** — each harness's own lifecycle reports ([harnesses.md](harnesses.md)). A hook is a
   fact, not a guess: no screen scraping decides "needs you".
2. **The person's keys** — an answer key (Enter, a digit, `y`/`n`/`a`) typed into a waiting agent
   moves it to `working` at once; Escape / Ctrl+C moves it to `idle`. Both are confirmed by the
   next hook, or by `QUIET_MS` (3 s) of silent output.
3. **The pty** — a spawn clears whatever the previous process said; facts between an exit and the
   next spawn are dropped; a hook sent by a previous process is dropped.
4. **The Claude Code transcript** — interrupts, API errors, lost hooks and queued prompts are read
   from the session transcript's tail (only entries newer than the current state count). A Stop
   with a queued prompt behind it is held for a moment. A Stop decided late never ends a turn that
   started after the Stop arrived: a prompt typed the instant the agent showed `finished` stays
   `working`.
5. **Subagents** — while a subagent runs inside an agent, the parent's own turn end is held.
6. **herdr status reports** — a plain command that speaks the herdr status protocol reports
   `working`, `blocked` and `idle` itself ([harnesses.md](harnesses.md#the-herdr-status-protocol)).
   An `idle` with no turn open (its first report, as it registers) is the `ready` signal: idle,
   never a turn end, so nothing rings. An `idle` after `working` or `blocked` ends the turn:
   `finished`.

The rules live in `packages/core/src/status/machine.ts` (pure, fully unit-tested) and the wiring in
`packages/core/src/status/hub.ts`.

## Quiet while working

Hooks only report what the harness itself asks. A **tool inside a command the agent runs** fires
no hook at all: git asking for a password or a passphrase, an installer's `Continue? [y/N]`,
`sudo`, ssh's "Are you sure you want to continue connecting", a dev server that waits — and
neither does a command or a CLI that simply hangs. The agent stays `working`, and nothing calls
you.

So nsq watches the screen as a fallback: an agent that is `working` and whose screen has not
changed **meaningfully** for `quietAfter` minutes (default **5**; `0` = off; per agent
`nsq set <agent> --quiet-after <min>`, see [configuration](guide/configuration.md)) is flagged
**quiet**. It is not a fifth status — the agent is still `working` (`AgentView.quiet` carries the
episode: when the screen last changed, when it was flagged, its last non-empty line and, when that
line looks like a prompt, the prompt). Quiet sits next to needs-you everywhere: an amber, distinct
`quiet 7m — check it` in the tile, the sidebar and the header counter (`1 needs you · 1 quiet`),
`nsq ls` (and its `--json` field `quiet`), the phone page; the same desktop notification, terminal
bell and ntfy push as needs-you ("api has been quiet for 7 min" with the last screen line), but
**no y/a/n keys** — nsq does not know what the tool waits for. Open the agent to see its screen.

It ends — back to plain `working` — on any new output, on any input (keys typed into the agent,
a paste, a prompt sent, an interrupt), and on any hook (the harness reporting progress). It never
fires while the agent is `idle`, `finished` or needs you, and leaving `working` ends it.

**What counts as output.** A waiting TUI is not still: Claude Code's spinner turns, its verb
changes and its timer counts. So the visible screen is compared as text, against the last
meaningful screen (`packages/core/src/status/quietWatch.ts`):

- spinner glyphs (braille, stars, circles, a lone `| / - \`) and elapsed times (`12s`, `4m 05s`,
  `1:02:03`) are taken out first;
- a change confined to at most 2 non-empty lines of at most 12 cells each, with no digit in it, is
  animation (a rotating verb, a growing row of dots);
- anything else is output: new lines (the screen scrolls), text on an empty row, a number that
  moves (tokens streaming, a percentage), a different screen.

It is tested against the recorded harness streams in `packages/term-view/fixtures` (Claude Code's
live region redrawn ~12×/s is animation, every history entry is output).

**The hint.** While quiet, the last three non-empty lines are checked for what tools ask on a
terminal — `[y/N]`, `(yes/no)`, `Password:`, a passphrase, `[sudo]`, ssh's host-key question,
`Press Enter` — and the newest match is shown: _looks like it's asking: Password for
'https://github.com':_. It is only a hint; nsq never types anything.

**Limits.** An agent that thinks for longer than the threshold with nothing moving on screen (no
token counter, no output) is flagged too — raise `quietAfter` if that is normal for your work. A
plain command (`nsq run -- …`) that does not speak the herdr protocol goes `idle` after a few
seconds of silence anyway, so it is never quiet.
