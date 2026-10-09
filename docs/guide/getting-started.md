# Getting started

> nsq **0.1.0 preview** — commands and keys may still change before 1.0.

## Requirements

- [Node.js](https://nodejs.org) **22.13 or newer** (with npm).
- Windows 10/11 (x64, arm64), macOS (Apple silicon, Intel) or Linux (x64, arm64). Native parts
  ship prebuilt — no compiler, no build tools.
- At least one coding CLI, installed and signed in the usual way: Claude Code, Codex or OpenCode.
  Or none: any command can run as an agent.
- `curl` on `PATH` — Claude Code and Codex hooks use it (Windows 10/11, macOS and most Linux
  distributions have it).

## Install

```sh
npm install -g neurosquad      # installs the `nsq` command
npx neurosquad                 # or try it without installing
```

Other channels follow the npm release (Homebrew a day later):

```sh
# macOS / Linux — Homebrew
brew install glmn-ai/neurosquad/neurosquad-cli

# macOS / Linux — install script (uses your npm, never sudo)
curl -fsSL https://raw.githubusercontent.com/glmn-ai/neurosquad-cli/main/packaging/install/install.sh | sh
```

```powershell
# Windows — Scoop
scoop bucket add neurosquad https://github.com/glmn-ai/scoop-neurosquad
scoop install neurosquad-cli

# Windows — install script (uses your npm, no admin rights)
irm https://raw.githubusercontent.com/glmn-ai/neurosquad-cli/main/packaging/install/install.ps1 | iex
```

Both install scripts accept `NSQ_VERSION` (e.g. `0.1.0`, default `latest`); `install.sh` also
takes `NSQ_PREFIX`, the npm global prefix to install into.

Check the install:

```sh
nsq --version
nsq doctor        # finds your CLIs, curl, the terminal backend, the OpenRouter key
```

## Your first agents

```sh
cd ~/code/my-app
nsq run claude "fix the flaky checkout test" --worktree
nsq run codex --name reviewer
nsq run -- npm run dev
nsq
```

1. `nsq run` starts the daemon if needed and starts the agent in the current folder. The prompt is
   optional; `--worktree` gives the agent its own branch and checkout ([worktrees](worktrees.md)).
2. `nsq` opens the dashboard: workspaces (folders) and their agents on the left, live terminals on
   the right ([dashboard and keys](dashboard.md)).
3. Select an agent and press **Enter** to work in it full screen; **Ctrl+]** goes back.
4. When an agent needs you, its tile and sidebar entry light up with the question, and you get a
   desktop notification. Press **y** / **a** / **n** to answer a permission prompt in place.
5. Press **q** to close the dashboard. The agents keep running; `nsq` brings the dashboard back.

You can also start agents from the dashboard: press **c**.

## Next

- [Agents and harnesses](agents.md) — what each CLI supports, sessions, dangerous mode, cost.
- [OpenRouter](openrouter.md) — any model through one key.
- [Notifications](notifications.md), [Phone](phone.md), [Dictation](dictation.md).
- [Configuration](configuration.md), [Troubleshooting](troubleshooting.md),
  [Uninstall](uninstall.md).
