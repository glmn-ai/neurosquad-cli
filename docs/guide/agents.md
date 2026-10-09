# Agents and harnesses

An **agent** is one coding CLI (a "harness") running in a terminal that the nsq daemon owns. Start
one with `nsq run` or with **c** in the dashboard.

```sh
nsq run claude "fix the flaky test"            # Claude Code
nsq run codex --name reviewer                   # Codex
nsq run opencode --model anthropic/claude-sonnet-4.5
nsq run --name web -- npm run dev               # any command
```

| Option                  |                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `--name <n>`            | the agent's name (default: `claude`, `codex`, `opencode` or the command's name, then `-2`, `-3`…) |
| `--cwd <dir>`           | start in another folder (default: the current one)                                                |
| `--worktree`, `-w`      | its own git branch and checkout ([worktrees](worktrees.md))                                       |
| `--model <id>`          | the model, in the harness's own format (or an OpenRouter slug)                                    |
| `--provider openrouter` | run through OpenRouter ([OpenRouter](openrouter.md)); `--openrouter` is the same                  |
| `--dangerous`           | approve its permission prompts automatically (see below)                                          |
| `--attach`, `-a`        | open it full screen right away                                                                    |
| `--json`                | print the new agent as JSON                                                                       |

Harness names also accept `cc` / `claude-code`, `codex-cli` and `oc`.

The folder you run from (or `--cwd`) is the agent's working directory; agents in the same folder form a
**workspace** in the dashboard's sidebar.

## Supported CLIs

| Harness      | Status from                        | Interrupt    | Dangerous mode                                                |
| ------------ | ---------------------------------- | ------------ | ------------------------------------------------------------- |
| Claude Code  | its hooks + the session transcript | Escape       | live — switch on/off at any time                              |
| Codex        | its hooks                          | Escape       | at launch (restart to change); also turns off Codex's sandbox |
| OpenCode 1.x | an OpenCode plugin                 | Escape twice | at launch (restart to change)                                 |
| OpenCode 2.x | an OpenCode plugin                 | Escape twice | live — switch on/off at any time                              |
| any command  | output and silence                 | Ctrl+C       | —                                                             |

nsq tells OpenCode 1.x and 2.x apart by `opencode --version`. The technical details for each CLI —
flags, environment, hook events — are in [docs/harnesses.md](../harnesses.md).

**Your configuration is never written.** `~/.claude`, `~/.codex/config.toml` and `opencode.json`
stay as they are: hooks, plugins and settings nsq needs are passed per agent (command-line flags,
environment variables, files under `~/.neurosquad-cli/layers/`). Your own settings, skills and MCP
servers keep working.

### Status

| State     | When                                                                                         |
| --------- | -------------------------------------------------------------------------------------------- |
| working   | a turn is running                                                                            |
| needs you | the CLI is blocked on you: a permission prompt, a question, a plan — with the CLI's own text |
| finished  | the turn ended                                                                               |
| idle      | at its prompt with nothing new (you dismissed a question, interrupted, or it restarted)      |
| exited    | the process is gone                                                                          |

These are facts from the CLI's own hooks, not guesses from the screen. A command started with
`nsq run --` has no hooks: output means working, 2.5 seconds of silence means finished, and it never
claims "needs you". More: [docs/status.md](../status.md).

## Sessions and resume

Each agent keeps its CLI session. `nsq restart <agent>` (or **r**) and a restart of the daemon
resume it: Claude Code with `--resume`, Codex with `codex resume`, OpenCode with its session id. If
the session no longer exists, a fresh one starts.

`nsq down` stops the daemon and its agents; `nsq up` — or simply `nsq` — starts it again and every
agent that was running comes back on its own session. That includes after a reboot.

## Sending prompts and answering

```sh
nsq send api-fix "also update the changelog"              # now (pasted and submitted)
nsq send api-fix "run the full test suite" --when-done    # when the current turn finishes
nsq answer api-fix yes                                    # yes | always | no
nsq interrupt api-fix
```

In the dashboard: **s** / **S** and **y** / **a** / **n**. "Always" is the CLI's own "don't ask
again" choice, so it follows that CLI's rules.

## Dangerous mode

Dangerous mode approves an agent's permission prompts for you. Use it only where the agent cannot
do harm you can't undo.

- **Claude Code:** live. nsq answers Claude Code's permission requests with "allow" while the mode
  is on, and switching it takes effect at once; your deny rules still apply.
- **OpenCode 2.x:** live as well. nsq's OpenCode plugin asks nsq on every permission check.
- **Codex, OpenCode 1.x:** applied at launch. After a change, `nsq restart <agent>` (or **r**)
  restarts it on the same session. For Codex it is `--dangerously-bypass-approvals-and-sandbox`, so
  it also turns off Codex's sandbox.

```sh
nsq run claude --dangerous "refactor the parser"
nsq set api-fix --dangerous off        # or press d in the dashboard
```

## Models

`--model <id>` passes the harness's own model id (`claude-opus-5-5`, `gpt-5.5`,
`anthropic/claude-sonnet-4-5` for OpenCode). With `--provider openrouter` it takes an OpenRouter
slug (`vendor/model`) — see [OpenRouter](openrouter.md).

An OpenRouter slug only exists on OpenRouter: on Claude Code's or Codex's own login it is "model
not found". So nsq refuses `nsq run claude --model openai/gpt-5` without `--provider openrouter`
and says so. (OpenCode's own ids are `provider/model` too, so there a slash proves nothing; nsq
does not guess.)

### Changing the model

**m** in the dashboard opens OpenRouter's catalogue. Picking a model **puts the agent on
OpenRouter with it**; the first row, **default**, puts it back on the CLI's own login and its
default model. From the command line:

```sh
nsq set api-fix --provider openrouter --model openai/gpt-6-sol   # what m does
nsq set api-fix --provider none --model none                      # what "default" does
nsq set api-fix --provider none --model claude-opus-5-5           # one of its own models
```

None of the three CLIs can switch safely inside a running session, so nsq restarts the agent **on
the same session** — the conversation is kept:

| Agent is…                         | The switch happens                                                              |
| --------------------------------- | ------------------------------------------------------------------------------- |
| idle or finished                  | now (after you stop typing into it for a few seconds)                           |
| working, or waiting for an answer | when the turn ends; prompts queued with `--when-done` then run on the new model |
| stopped                           | on its next start                                                               |

Why not in the session: Claude Code's `/model <id>` does accept an id, but it asks to confirm the
switch and **writes the model into your `~/.claude/settings.json`** — every later `claude` you run
would start on an OpenRouter slug and fail. Codex's `/model` and OpenCode's `/models` are pickers
that take no id. And a provider change (own login ↔ OpenRouter) needs new environment variables
(key, base URL) that a running process cannot get. Codex resumes a session on its last turn's
model, so going back from OpenRouter nsq passes your configured Codex model (or the session's last
own one) explicitly.

## Cost

```sh
nsq cost                 # per agent, all time
nsq cost --since 7d      # 7d, 12h, 30m…
nsq cost --json
```

nsq reads usage from each CLI's own logs (Claude Code's session transcripts, Codex's rollout files,
OpenCode's database — read-only). Tokens are counted exactly; a model without a known price shows
"no price", never $0. `nsq ls` shows the running total per agent. Commands started with `--` have
no cost.

## Managing agents

```sh
nsq ls                        # name, harness, status, branch, cost
nsq stop api-fix              # stop the process (the agent stays in the list)
nsq start api-fix             # start it again (resumes)
nsq rm api-fix                # remove it; its worktree is kept unless you add --worktree
nsq diff api-fix              # uncommitted changes in its folder (git diff HEAD)
nsq peek api-fix -n 20        # the last lines of its screen
```
