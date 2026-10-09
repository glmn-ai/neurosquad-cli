# nsq — NeuroSquad CLI

> **Preview (0.1).** Works day to day on Windows, macOS and Linux with Claude Code, Codex and
> OpenCode; commands and the on-disk format may still change before 1.0.

Run several AI coding agents in your terminal and stop babysitting them: `nsq` starts Claude Code,
Codex, OpenCode or any command, keeps them running in a background daemon, and tells you — with
the question — when one needs you.

```sh
nsq run claude "fix the flaky checkout test" --worktree
nsq run codex --name reviewer
nsq run -- npm run dev          # any command
nsq                             # the dashboard
```

## Commands

| Command                                                                        |                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nsq`                                                                          | the dashboard (starts the daemon)                                                                                                                                      |
| `nsq run <claude\|codex\|opencode> [prompt]`                                   | start an agent: `--name`, `--worktree` (own branch and checkout), `--model <id>`, `--provider openrouter`, `--dangerous` (approves its permission prompts), `--attach` |
| `nsq run -- <command…>`                                                        | any command as an agent                                                                                                                                                |
| `nsq ls [--json]`                                                              | agents, status, cost                                                                                                                                                   |
| `nsq attach <agent>`                                                           | full-screen terminal; **Ctrl+]** detaches                                                                                                                              |
| `nsq send <agent> "prompt" [--when-done]`                                      | send a prompt now, or when the current turn finishes                                                                                                                   |
| `nsq answer <agent> yes\|always\|no`                                           | answer a permission prompt                                                                                                                                             |
| `nsq interrupt\|stop\|start\|restart <agent>`                                  | the agent's process (restart resumes its session)                                                                                                                      |
| `nsq rm <agent> [--worktree]`                                                  | remove it (and its worktree)                                                                                                                                           |
| `nsq set <agent> --dangerous on\|off --model <id> --provider openrouter\|none` | change it                                                                                                                                                              |
| `nsq diff <agent>` · `nsq peek <agent>`                                        | its git diff · the last lines of its screen                                                                                                                            |
| `nsq cost [--since 7d] [--json]`                                               | what each agent spent, from the harness's own logs                                                                                                                     |
| `nsq openrouter set-key\|clear-key\|models [query]\|status`                    | OpenRouter                                                                                                                                                             |
| `nsq phone on [--lan] [--port n]\|off\|pair\|rotate\|status`                   | phone access (below)                                                                                                                                                   |
| `nsq login` · `logout` · `whoami`                                              | the optional NeuroSquad account                                                                                                                                        |
| `nsq up` · `nsq down`                                                          | start / stop the daemon (agents resume on `up`)                                                                                                                        |
| `nsq doctor`                                                                   | check the harnesses, hooks, terminal                                                                                                                                   |

## How it knows

Status comes from each CLI's own hooks (Claude Code hooks, Codex hooks, an OpenCode plugin), set up
in a per-agent layer — your `~/.claude`, `~/.codex` and `opencode.json` are never written. See
[docs/harnesses.md](../../docs/harnesses.md).

## OpenRouter

`nsq openrouter set-key` stores the key in the OS keyring (or set `OPENROUTER_API_KEY`); it is only
ever put in the agent's environment. `nsq run claude --provider openrouter --model anthropic/claude-sonnet-4.5`.
Requests carry NeuroSquad's OpenRouter app attribution headers.

## Phone

`nsq phone on --lan` lets a phone on the same network see the agents, read their screens, send a
prompt (a busy agent gets it when its turn ends), answer a permission prompt and interrupt. It is off
by default, and without `--lan` it listens on this machine only. `nsq phone pair` prints the link
and a QR code; the link carries the pairing token, so treat it as a password. `nsq phone rotate`
replaces the token and disconnects every paired phone. The phone cannot start agents, change
settings or type arbitrary keys. The API is `@neurosquad/remote`'s
([docs/remote-proposal.md](../../docs/remote-proposal.md)); a phone UI for it is not part of nsq yet.

## Account

`nsq login` signs in to a NeuroSquad account with a code you confirm in the browser; tokens live in
the OS keyring. Nothing in nsq needs it.

## Data

Everything lives in `~/.neurosquad-cli` (`NSQ_HOME` to move it). No telemetry; the account is optional.

MIT licensed. Harness names and logos are trademarks of their owners, used only to identify which
CLI an agent runs.
