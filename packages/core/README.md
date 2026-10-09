# @neurosquad/core

The integration core shared by [`nsq`](../../README.md) and the NeuroSquad desktop app: how to start
Claude Code, Codex and OpenCode with a per-agent configuration layer, how to learn their exact
status from their own hooks, and how to read what they spent.

Node.js ≥ 22.13, no Electron, no DOM. `node-pty` is an optional peer dependency (only `PtyHost`
needs it).

| Area      | Modules                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch    | `prepareLaunch` → `{ command, args, env, … }` per harness; the user's own CLI config is never written                                                                                                            |
| Status    | `machine` (pure state machine), `hub` (hook payloads, timers, the Claude transcript), `hooks/server` (loopback endpoint with per-agent tokens)                                                                   |
| PTY       | `PtyHost` (spawn with ConPTY on Windows, trust prompt, session-not-found recovery, submit/paste/interrupt), `events`, `screenMirror`                                                                             |
| Providers | OpenRouter recipes and attribution headers; the user's own OpenAI/Anthropic-compatible servers (validation, connection test, model lists, per-harness recipes, a Responses ⇄ chat completions gateway for Codex) |
| Usage     | Claude Code / Codex / OpenCode log readers, exact pricing (`agentCost`)                                                                                                                                          |
| Git       | per-agent worktrees                                                                                                                                                                                              |

See [docs/harnesses.md](../../docs/harnesses.md) and [docs/status.md](../../docs/status.md).

MIT licensed.
