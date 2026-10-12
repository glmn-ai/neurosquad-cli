# The dashboard and keys

`nsq` with no arguments opens the dashboard (and starts the daemon if it is not running). On the
left, a sidebar with your workspaces — one per folder you started agents in — and their agents; on
the right, the agents of the selected workspace as a grid of live terminals. Any agent opens full
screen and goes back to the grid.

Closing the dashboard (**q**, or closing the terminal window) does not stop anything: the daemon
owns the agents. Open `nsq` again from any terminal and everything is where you left it.

## Status at a glance

| Shown         | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| `◐ working`   | a turn is running                                                                          |
| `● NEEDS YOU` | the CLI waits for you — a permission prompt, a question, a plan to approve — with its text |
| `◌ quiet 7m`  | working, but no new output for minutes: something may wait for you (below)                 |
| `✔ finished`  | the turn ended and the answer is on screen                                                 |
| `○ idle`      | at its prompt with nothing new                                                             |
| `✕ exited`    | the process is gone (`r` restarts it on the same session)                                  |

Status comes from each CLI's own hooks, not from reading the screen — see
[agents and harnesses](agents.md). It is never shown by colour alone: every state has its own glyph
and label (ASCII `! * + - x` where the terminal needs it; `?` for quiet). The one exception is
_quiet_, a fallback for what no hook reports: a working agent whose screen has not changed for
`quietAfter` minutes (a turning spinner does not count). The header counts it next to needs-you
(`● 1 needs you · ◌ 1 quiet`), the sidebar shows `quiet 7m` on the agent, and the tile's footer
says what the screen seems to ask. **Enter** opens the agent; anything you type clears it
([details](../status.md#quiet-while-working)).

## Keys

| Key                    |                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ↑ ↓ ← → / h j k l, Tab | select an agent (Tab walks all workspaces)                                                                                                 |
| Enter, double-click    | open the agent full screen — every key goes to it; **Ctrl+]** back to the grid                                                             |
| y / a / n              | answer the selected agent's permission prompt (yes / always / no)                                                                          |
| s / S                  | send a prompt (queued if the agent is busy) / send it when the current turn is done                                                        |
| c                      | start an agent (harness, name, prompt, folder, worktree, provider, model, dangerous mode)                                                  |
| m                      | pick a model: OpenRouter's catalogue (switches the agent to OpenRouter), "default", or — on one of your own servers — that server's models |
| P                      | providers: your own model servers — add, test, models, remove ([providers](providers.md))                                                  |
| i                      | interrupt the current turn (with each CLI's own interrupt key)                                                                             |
| x · X                  | stop · remove                                                                                                                              |
| r · R                  | restart (resumes the session) · rename                                                                                                     |
| d                      | dangerous mode on/off                                                                                                                      |
| v                      | dictate into the agent (also the global hotkey); the text is pasted, never sent                                                            |
| p                      | phones: who is connected; a new pairing token cuts them off                                                                                |
| Q                      | phone panel: the pairing QR, online / LAN, a new token, phone notifications ([phone](phone.md#in-the-dashboard-q))                         |
| U                      | update: install a new release now, or restart onto an installed one ([updates](updates.md))                                                |
| Shift+PgUp / PgDn      | scroll the selected agent's output back / forward (Shift+Home: the oldest line, Shift+End: live again)                                     |
| [ ]                    | previous / next page of tiles                                                                                                              |
| b                      | sidebar on/off                                                                                                                             |
| ?                      | help                                                                                                                                       |
| q                      | quit — agents keep running (`nsq down` stops them)                                                                                         |

Also: on an agent that is not waiting, **n** opens New agent. **Ctrl+C** quits like **q**, **+** works like **c**, **Shift+Tab** walks backwards, **Esc**
closes a dialog. **Enter** on a stopped agent starts it. In the New agent form, **Tab** / **↑ ↓**
move between fields, **← →** pick the harness and the provider (own login, OpenRouter, or one of
[your own servers](providers.md) that fits the harness — the others are listed with the reason),
**Space** toggles a box, and **F2** or **Ctrl+O** picks a model: the chosen server's own models, or
an OpenRouter model (which switches OpenRouter on).

The bottom line always shows the keys that matter right now (for an agent that needs you: y / a /
n first).

**Mouse:** click selects (a click on a workspace selects its first agent), double-click opens. The
wheel over a tile scrolls that agent's output back (3 lines a notch, a page with Shift) — the tile's
bottom line says how far (`↑ 120 lines`), new output doesn't move what you are reading, and
scrolling down to the bottom follows the live screen again. Over the sidebar the wheel moves the
selection through all agents. An agent that asked for the mouse (OpenCode's TUI, for one) gets
the wheel itself and scrolls on its own; in full screen it gets the clicks too.

## Full screen and `nsq attach`

In full screen the agent gets every key, exactly as if you ran the CLI directly. **Ctrl+]** goes
back to the grid (change it with `detachKey` in [config.json](configuration.md)).

**Scrolling back.** nsq keeps the last 1000 lines of each agent. In full screen the mouse wheel
scrolls them (3 lines a notch, a page with Shift), and so do **Shift+PgUp / Shift+PgDn**;
**Shift+Home** goes to the oldest line, **Shift+End** back to the live screen. While you are
scrolled back the bottom line says `↑ 120 lines · End or any key to return`, the agent's new output
doesn't move the view, **PgUp / PgDn / Home / End** keep scrolling, and any other key goes to the
agent and brings the live screen back first. This is for agents on the terminal's normal screen
(Claude Code, Codex): an agent that asked for the mouse (OpenCode) gets the wheel, and a
full-screen TUI on the alternate screen gets the wheel as ↑ ↓ and keeps every key, Shift+PgUp
included — it scrolls itself, as in any terminal.

`nsq attach <agent>` does the same from a plain shell, without the dashboard; **Ctrl+]** detaches.
There the agent's output goes straight to your terminal, so your terminal's own scrollback, wheel
and scroll keys work as usual (the last 500 lines from before you attached are replayed into it).

## The same things from a shell

```sh
nsq ls                          # agents, status, cost
nsq ls --json                   # for scripts
nsq peek api-fix -n 40          # the last 40 lines of its screen
nsq answer api-fix yes          # yes | always | no
nsq send api-fix "now add a test" --when-done
nsq interrupt api-fix
```

## Looks

- **Logos:** the real CLI logos in terminals nsq recognises as able to draw images (kitty, Ghostty,
  iTerm2, WezTerm, foot, mlterm); other terminals (Windows Terminal, VS Code, Konsole…) are asked
  once at start (at most 150 ms, without delaying the first frame) and get them too if they answer;
  two-cell badges elsewhere, neutral badges with `NSQ_LOGOS=none`. Claude Code always gets a
  `CC` monogram on Claude's orange, never a logo (at Anthropic's request).
  Inside tmux, screen or zellij images are off. A `logos` value in
  [config.json](configuration.md) other than `auto` takes precedence over `NSQ_LOGOS`.
- **Animations** (working spinner, needs-you pulse, finish sparkle) run on one shared clock, pause
  while an agent is full screen or the terminal loses focus, and are off over SSH, at 16 colours
  and with `NSQ_NO_ANIMATION=1`.
- **Colour** follows the terminal (truecolor / 256 / 16, `NO_COLOR` respected); force it with
  `NSQ_COLOR`.

The dashboard draws terminal cells directly, repaints only what changed, and at most about 30 times
a second. More settings: [configuration](configuration.md).
