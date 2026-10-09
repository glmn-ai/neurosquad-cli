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
| `✔ finished`  | the turn ended and the answer is on screen                                                 |
| `○ idle`      | at its prompt with nothing new                                                             |
| `✕ exited`    | the process is gone (`r` restarts it on the same session)                                  |

Status comes from each CLI's own hooks, not from reading the screen — see
[agents and harnesses](agents.md). It is never shown by colour alone: every state has its own glyph
and label (ASCII `! * + - x` where the terminal needs it).

## Keys

| Key                    |                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| ↑ ↓ ← → / h j k l, Tab | select an agent (Tab walks all workspaces)                                                  |
| Enter, double-click    | open the agent full screen — every key goes to it; **Ctrl+]** back to the grid              |
| y / a / n              | answer the selected agent's permission prompt (yes / always / no)                           |
| s / S                  | send a prompt / send it when the current turn is done                                       |
| c                      | start an agent (harness, name, prompt, folder, worktree, OpenRouter, model, dangerous mode) |
| m                      | pick a model (OpenRouter's catalogue)                                                       |
| i                      | interrupt the current turn (with each CLI's own interrupt key)                              |
| x · X                  | stop · remove                                                                               |
| r · R                  | restart (resumes the session) · rename                                                      |
| d                      | dangerous mode on/off                                                                       |
| v                      | dictate into the agent (also the global hotkey); the text is pasted, never sent             |
| p                      | phones: who is connected; a new pairing token cuts them off                                 |
| [ ]                    | previous / next page of tiles                                                               |
| b                      | sidebar on/off                                                                              |
| ?                      | help                                                                                        |
| q                      | quit — agents keep running (`nsq down` stops them)                                          |

The bottom line always shows the keys that matter right now (for an agent that needs you: y / a /
n first).

**Mouse:** click selects, double-click opens, the wheel moves the selection; in a full-screen agent
that asked for the mouse, clicks go to it.

## Full screen and `nsq attach`

In full screen the agent gets every key, exactly as if you ran the CLI directly. **Ctrl+]** is the
only key nsq keeps (change it with `detachKey` in [config.json](configuration.md)).

`nsq attach <agent>` does the same from a plain shell, without the dashboard; **Ctrl+]** detaches.

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

- **Logos:** the real CLI logos where the terminal can draw images (kitty, Ghostty, iTerm2,
  WezTerm, foot and other sixel terminals; Windows Terminal 1.22+, VS Code, Konsole and xterm are
  asked at start-up), two-cell badges elsewhere, neutral badges with `NSQ_LOGOS=none`. Inside tmux,
  screen or zellij images are off.
- **Animations** (working spinner, needs-you pulse, finish sparkle) run on one shared clock, pause
  while an agent is full screen or the terminal loses focus, and are off over SSH, at 16 colours
  and with `NSQ_NO_ANIMATION=1`.
- **Colour** follows the terminal (truecolor / 256 / 16, `NO_COLOR` respected); force it with
  `NSQ_COLOR`.

The dashboard draws terminal cells directly, repaints only what changed, and at most about 30 times
a second. More settings: [configuration](configuration.md).
