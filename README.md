# nsq — NeuroSquad CLI

[![CI](https://github.com/glmn-ai/neurosquad-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/glmn-ai/neurosquad-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: in development](https://img.shields.io/badge/status-in%20development-orange.svg)

**Run several AI coding agents in your terminal and stop babysitting them.**

`nsq` is a terminal supervisor for AI coding CLIs (Claude Code, Codex, OpenCode, or any command).
Start several agents, walk away, and get notified _with the question_ when one of them needs you —
answer it from the dashboard without switching windows.

It is the open-source, terminal-only sibling of the [NeuroSquad desktop app](https://neurosquad.ai).

> **Status: in development.** Nothing below is released yet. The list describes what we are
> building; APIs, commands and flags may change. Follow progress in
> [issues](https://github.com/glmn-ai/neurosquad-cli/issues) and
> [pull requests](https://github.com/glmn-ai/neurosquad-cli/pulls).

## Planned features

MVP _(in development)_:

- **Start agents** — `nsq run claude "fix the flaky test"`, `nsq run codex`, `nsq run -- <any command>`.
  Your own `~/.claude`, `~/.codex` or `opencode.json` are never written: everything `nsq` needs lives
  in a per-agent layer (flags, env, its own folder).
- **A daemon that owns the terminals** — agents keep running when you close the dashboard or the
  terminal window.
- **Dashboard** — one row per agent with live status (working / needs you / finished / idle /
  exited), elapsed time and the pending question ("Allow Bash: `npm test`?"). Answer permission
  prompts inline with `y` / `a` / `n`.
- **Attach / detach** — full-screen passthrough to one agent, detach with a prefix key.
- **Notifications and sound** — native OS notification on "needs you" and "finished", plus terminal
  bell / OSC 9 / OSC 777 so it works over SSH.
- **Per-agent git worktree** — `nsq run claude --worktree "task"` gives each agent its own branch.

Later _(planned)_:

- **Cost per agent** from each harness's own transcript (integer tokens; unknown model shows
  "no price", never $0).
- **Phone** — push "needs you / finished" with the question and answer from your phone (optional
  login).
- Prompt queue (`nsq send --when-done`), reviewer on another CLI, resume of all agents after reboot.

Harnesses first: Claude Code, Codex, OpenCode, and a generic mode for any command. More on demand —
[request one](https://github.com/glmn-ai/neurosquad-cli/issues/new?template=harness_request.yml).

## Planned commands

```text
nsq                         dashboard (starts the daemon)
nsq run <harness> [prompt] [--worktree] [--name] [--model]
nsq run -- <any command…>
nsq ls [--json]             nsq attach <name>       nsq send <name> "prompt"
nsq stop|restart|rm <name>  nsq up / nsq down       nsq doctor
```

## Install

> **Coming soon — nothing is published yet.** The commands below start working with the first
> release. Until then, build from source — see [CONTRIBUTING.md](CONTRIBUTING.md).

Requires [Node.js](https://nodejs.org) 22.13 or newer. Targets: Windows (x64, arm64), macOS (Apple
silicon, Intel) and Linux (x64, arm64), each checked in CI from the packed npm tarball. The first
release ships only once every target installs without a compiler (prebuilt native binaries).
Voice dictation is not available on Windows arm64.

```sh
npm install -g neurosquad        # then: nsq
npx neurosquad                   # try it without installing
```

Package managers and one-liners:

```sh
# macOS / Linux — Homebrew
brew install glmn-ai/neurosquad/neurosquad-cli

# macOS / Linux — install script (uses your npm, no sudo)
curl -fsSL https://raw.githubusercontent.com/glmn-ai/neurosquad-cli/main/packaging/install/install.sh | sh
```

```powershell
# Windows — Scoop
scoop bucket add neurosquad https://github.com/glmn-ai/scoop-neurosquad
scoop install neurosquad-cli

# Windows — install script (uses your npm, no admin rights)
irm https://raw.githubusercontent.com/glmn-ai/neurosquad-cli/main/packaging/install/install.ps1 | iex
```

winget comes later (it needs a standalone Windows build). Releases and changelogs:
[GitHub releases](https://github.com/glmn-ai/neurosquad-cli/releases); how we release:
[RELEASING.md](RELEASING.md).

## Privacy

No account is required. Without login, `nsq` sends no telemetry.

## Contributing

Contributions are welcome — every change goes through a pull request. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues:
see [SECURITY.md](SECURITY.md). Questions and ideas: [Discussions](https://github.com/glmn-ai/neurosquad-cli/discussions)
or our [Discord](https://discord.gg/DyKn8cGTc).

## Related

- [neurosquad.ai](https://neurosquad.ai) — the NeuroSquad desktop app: agents as cards with live
  terminals on a canvas.

## License

[MIT](LICENSE) © 2026 Stanislav Gelman and NeuroSquad contributors
