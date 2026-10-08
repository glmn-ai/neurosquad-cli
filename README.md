# nsq — NeuroSquad CLI

[![CI](https://github.com/glmn-ai/neurosquad-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/glmn-ai/neurosquad-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: in development](https://img.shields.io/badge/status-in%20development-orange.svg)

**Run several AI coding agents in your terminal and stop babysitting them.**

`nsq` is a terminal supervisor for AI coding CLIs (Claude Code, Codex, OpenCode, or any command).
Start several agents, walk away, and get notified *with the question* when one of them needs you —
answer it from the dashboard without switching windows.

It is the open-source, terminal-only sibling of the [NeuroSquad desktop app](https://neurosquad.ai).

> **Status: in development.** Nothing below is released yet. The list describes what we are
> building; APIs, commands and flags may change. Follow progress in
> [issues](https://github.com/glmn-ai/neurosquad-cli/issues) and
> [pull requests](https://github.com/glmn-ai/neurosquad-cli/pulls).

## Planned features

MVP *(in development)*:

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

Later *(planned)*:

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

Not published yet. Once the first release is out it will be available via npm
(`npm i -g neurosquad`, binary `nsq`) and package managers. Until then, build from source — see
[CONTRIBUTING.md](CONTRIBUTING.md).

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
