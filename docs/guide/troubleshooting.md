# Troubleshooting

Start with:

```sh
nsq doctor
```

It prints the nsq and Node versions, the data folder, whether the daemon runs, where each CLI was
found on `PATH`, whether `curl` and the terminal backend (`node-pty`) work, whether an OpenRouter
key is available, and what your terminal reports. The daemon's log is
`~/.neurosquad-cli/daemon.log`.

## "nsq: command not found" after `npm i -g`

npm's global `bin` folder is not on your `PATH`. `npm prefix -g` shows the prefix; add its `bin`
(macOS/Linux) or the prefix itself (Windows) to `PATH`, or use `npx neurosquad`. The install script
falls back to `~/.local` when npm's global folder is not writable — make sure `~/.local/bin` is on
`PATH`.

## The terminal backend does not load (node-pty)

nsq runs each agent in a pseudo-terminal through a prebuilt `node-pty`; nothing is compiled. If
`nsq doctor` says `node-pty FAILED`:

- Check `node --version` is **22.13 or newer**, and that you run nsq with the same Node you
  installed it with (switching Node versions with nvm/fnm needs a reinstall: `npm i -g neurosquad`).
- Reinstall (`npm i -g neurosquad`) without `--omit=optional`: the prebuilt terminal backend comes
  as an optional per-platform package.
- Open an issue with the `nsq doctor` output.

## Windows: ConPTY

On Windows, agents run in **ConPTY**, the pseudo-console built into Windows 10 (1809 and newer) and
Windows 11.

- **Use Windows Terminal** (or another modern terminal). The legacy console works, but with fewer
  colours and no images; if "Use legacy console" is ticked in its properties, untick it.
- **Ctrl+C closed the CLI:** many CLIs quit on Ctrl+C. Use **i** in the dashboard (or
  `nsq interrupt`): it sends each CLI's own interrupt key (Escape for Claude Code and Codex, Escape
  twice for OpenCode).
- **Codex installed with npm:** nsq starts the `codex.exe` behind npm's `codex.cmd` directly; if it
  is not found, reinstall Codex.

## An agent never shows "needs you" or "finished"

- **`curl` missing:** Claude Code and Codex report their status through hooks that call `curl`.
  `nsq doctor` checks it.
- **Old CLI version:** update the CLI. OpenCode 1.x and 2.x are both supported.
- **A command started with `nsq run --`** has no hooks: it shows working while it prints and
  finished after 2.5 s of silence, and never "needs you". That is by design.
- Check `~/.neurosquad-cli/daemon.log` and `nsq peek <agent>`.

## Notifications do not appear

- **macOS:** install `terminal-notifier` (`brew install terminal-notifier`), or allow notifications
  for **Script Editor** in System Settings → Notifications. Check Focus modes.
- **Linux:** a notification daemon must be running on the D-Bus session bus (most desktops have one).
- **Windows:** check Focus assist / Do not disturb.
- **Over SSH / no desktop:** notifications go to the dashboard's terminal (bell and OSC 9) —
  keep the dashboard open. See [notifications](notifications.md).
- **No bell at all:** `"notifications": false` or `NSQ_NO_NOTIFY=1` silences the bell too.

## Error messages

- **"the dashboard needs an interactive terminal (try `nsq ls`)"**: `nsq` was run with its output
  piped or without a terminal. Use `nsq ls` and the other commands in scripts.
- **"no OS keyring is available here; set the value in the environment instead"**: on a headless
  machine, `nsq openrouter set-key` and `nsq phone push ntfy` cannot store secrets. Set
  `OPENROUTER_API_KEY`, or `NSQ_NTFY_URL` / `NSQ_NTFY_TOKEN`, where the daemon starts.
- **"could not create a worktree on branch nsq/<name>"**: the branch is left over from an earlier
  agent with that name. `git branch -D nsq/<name>`, or use another `--name`.
- **"dictation is not installed (npm i -g @neurosquad/dictation next to nsq)"**: the optional
  dictation package was not installed; install it as the message says.

## The dashboard looks wrong

- **Broken borders in a CJK terminal:** `NSQ_AMBIGUOUS_WIDE=1`.
- **Strange characters or colours:** try `NSQ_GLYPHS=ascii` or `NSQ_COLOR=256`.
- **Images or logos misbehave:** `NSQ_IMAGES=0` or `NSQ_LOGOS=glyphs`.
- **Slow over a remote link:** animations are already off over SSH; `NSQ_NO_ANIMATION=1` turns them
  off anywhere.

## OpenRouter

- `nsq openrouter status` says whether a key is available. On a server without a keyring, set
  `OPENROUTER_API_KEY` before the daemon starts (`nsq down`, then `nsq up`).
- Claude Code needs 2.1.227 or newer for the attribution headers.

## Dictation

- `nsq dictation status` shows the model and hotkey; `nsq dictation test file.wav` checks the
  model without a microphone.
- **macOS:** Microphone and Accessibility / Input Monitoring permissions for your terminal app.
- **Linux without X (SSH, server, Wayland-only):** no global hotkey — the dashboard shows a one-line
  notice; use **v** in the dashboard.
- Not available on Windows arm64.

## Start clean

```sh
nsq down                        # stop the daemon and the agents
nsq up                          # start again; agents resume
```

To try nsq without your existing agents, point it at another folder: `NSQ_HOME=/tmp/nsq-test nsq`.

Still stuck? [Open an issue](https://github.com/glmn-ai/neurosquad-cli/issues/new/choose) with the
`nsq doctor` output, or ask in [Discussions](https://github.com/glmn-ai/neurosquad-cli/discussions).
