# Agents and harnesses

An **agent** is one coding CLI (a "harness") running in a terminal that the nsq daemon owns. Start
one with `nsq run` or with **c** in the dashboard.

```sh
nsq run claude "fix the flaky test"            # Claude Code
nsq run codex --name reviewer                   # Codex
nsq run opencode --model anthropic/claude-sonnet-4.5
nsq run --name web -- npm run dev               # any command
nsq run -- claude --effort high "fix the test"  # a CLI's own command line
```

| Option                  |                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `--name <n>`            | the agent's name (default: `claude`, `codex`, `opencode` or the command's name, then `-2`, `-3`…) |
| `--cwd <dir>`           | start in another folder (default: the current one)                                                |
| `--worktree`, `-w`      | its own git branch and checkout ([worktrees](worktrees.md))                                       |
| `--model <id>`          | the model, in the harness's own format (or an OpenRouter slug)                                    |
| `--provider openrouter` | run through OpenRouter ([OpenRouter](openrouter.md)); `--openrouter` is the same                  |
| `--provider <name>`     | run on one of your own servers ([your own model servers](providers.md))                           |
| `--dangerous`           | approve its permission prompts automatically (see below)                                          |
| `--attach`, `-a`        | open it full screen right away                                                                    |
| `--json`                | print the new agent as JSON                                                                       |
| `--raw`                 | with `-- <command…>`: run `claude` / `codex` / `opencode` as a plain command (see below)          |

### Your CLI's own command line

`nsq run -- claude …`, `nsq run -- codex …` and `nsq run -- opencode …` (also by path, e.g.
`./node_modules/.bin/codex`) start that CLI **as its harness**: hooks or plugin, status, session
tracking and resume, exactly like `nsq run claude`. Its own flags are passed through on every start
(`--effort high`, `-c key=value`, `--agent build`…), and nsq reads out what it manages itself:

| The CLI's own                                                                                                  | nsq takes it as                               |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| the prompt (Claude Code, Codex: the positional; OpenCode: `--prompt`)                                          | the first prompt (sent once, not on a resume) |
| `--model` / `-m`                                                                                               | the agent's model (`m` in the dashboard)      |
| `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox` / `--yolo`, OpenCode's `--auto` | dangerous mode (`d`)                          |
| OpenCode's `[project]`                                                                                         | the folder to start in                        |

Not accepted, because nsq keeps the agent's session itself (`nsq restart` resumes it):
`--resume`, `--continue`, `--session-id`, `--fork-session`, `codex resume` / `codex fork`, OpenCode's
`--session`, `--continue` and `--fork`; and what would switch off nsq's status: Claude Code's
`--settings` and `--bare`, OpenCode's `--pure`. A run that is not an interactive session
(`claude -p`, `codex exec`, `opencode run`, `--version`, `mcp`…) runs as a plain command. `--raw`
(`nsq run --raw -- claude …`) runs any of them as a plain command, exactly as written.

Harness names also accept `cc` / `claude-code`, `codex-cli` and `oc`.

The folder you run from (or `--cwd`) is the agent's working directory; agents in the same folder form a
**workspace** in the dashboard's sidebar.

## Supported CLIs

| Harness      | Status from                                                                                             | Interrupt    | Dangerous mode                                                |
| ------------ | ------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------- |
| Claude Code  | its hooks + the session transcript                                                                      | Escape       | live — switch on/off at any time                              |
| Codex        | its hooks                                                                                               | Escape       | at launch (restart to change); also turns off Codex's sandbox |
| OpenCode 1.x | an OpenCode plugin                                                                                      | Escape twice | at launch (restart to change)                                 |
| OpenCode 2.x | an OpenCode plugin                                                                                      | Escape twice | live — switch on/off at any time                              |
| any command  | output and silence, or its own reports ([herdr protocol](#agents-that-speak-the-herdr-status-protocol)) | Ctrl+C       | —                                                             |

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
claims "needs you", unless it reports its own state (below). More: [docs/status.md](../status.md).

### Agents that speak the herdr status protocol

Agents that support the herdr status protocol work in nsq out of the box. [herdr](https://herdr.dev)
is a terminal multiplexer for coding agents; it publishes a small protocol an agent uses to report
its own state ([Add Herdr support to your agent](https://herdr.dev/docs/add-herdr-support/)), and several agents
implement it: Crush, Kiro CLI, Command Code, Muse Code, Prime Agent, and more as they add it. nsq
speaks the receiving end of that protocol, so you start such an agent as a plain command:

```sh
nsq run -- crush
```

nsq tells the command it runs in a herdr pane (`HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`,
`HERDR_BIN_PATH`). An agent that speaks the protocol then reports to nsq, and nsq stops guessing
from its output:

| It reports            | nsq shows                                                                       |
| --------------------- | ------------------------------------------------------------------------------- |
| `working`             | working                                                                         |
| `blocked` (+ message) | needs you, with its message ("crush is waiting for your decision" without one)  |
| `idle` after a turn   | finished                                                                        |
| `idle` on start       | idle                                                                            |
| its session id        | recorded, like a harness's own session                                          |
| a resume command      | used by `nsq restart` and after `nsq down` / `nsq up`, instead of starting over |

Answer it in the agent itself (Enter, or `nsq attach`): its permission dialog is its own, so the
dashboard's **y / a / n** keys do not apply. Each agent gets its own pane id, so one agent cannot
report for another. Only the agent state reports are implemented (`pane report-agent`,
`report-agent-session`, `release-agent`); the rest of herdr (splits, waits, events) is herdr's own.
Commands that do not speak the protocol ignore the variables. Thanks to herdr for publishing the
protocol.

## Sessions and resume

Each agent keeps its CLI session. `nsq restart <agent>` (or **r**) and a restart of the daemon
resume it: Claude Code with `--resume`, Codex with `codex resume`, OpenCode with its session id, and
a plain command with the resume command it reported over the herdr status protocol (others start
over). If the session no longer exists, a fresh one starts.

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

## The approvals log

Every "needs you" question, across all agents, and how it ended goes into one append-only file,
`~/.neurosquad-cli/logs/approvals.jsonl` — so after a bad call you can see which agent asked, what
exactly, and who said yes from where.

```sh
nsq log approvals                          # the last 50, newest last
nsq log approvals --agent api-fix --since 2h
nsq log approvals --json                   # every field, for scripts (-n 20: the last 20)
```

```text
TIME            AGENT    HARNESS      ANSWER       BY                             QUESTION
10-11 14:02:07  api-fix  Claude Code  yes          dashboard                      Bash: npm test
10-11 14:05:31  api-fix  Claude Code  always       phone (LAN, iPhone · Safari)   Edit: src/db.ts
10-11 14:09:12  docs     Codex        no           terminal (attach)              Bash: rm -rf dist
10-11 14:12:40  docs     Codex        interrupted  nsq interrupt                  Bash: git push
```

One JSON line per question: when it was asked and when it ended; the agent's id and name, its CLI
and folder (your home shown as `~`); the question as the CLI put it — its text (what the dashboard
shows) and, where the CLI says, the tool and its command, path or url; and the outcome:

| Outcome       | What happened                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answered`    | **yes / always / no** through nsq — `by` says who: the dashboard's key, `nsq answer`, or the phone (`local` / `lan` / `internet`, and the device) |
| `terminal`    | someone typed into the agent's own terminal (the dashboard's full-screen view, `nsq attach`); the answer when the key says it — Escape is "no"    |
| `cli`         | the CLI went on by itself (its own rule, an automatic approval)                                                                                   |
| `ended`       | the turn ended with no answer (the CLI gave up, timed out or failed)                                                                              |
| `interrupted` | an interrupt ended the turn while it waited — `by` says whose                                                                                     |
| `exited`      | the agent stopped, restarted or was removed while it waited                                                                                       |
| `unanswered`  | nsq itself stopped while it waited                                                                                                                |

**Quiet episodes** go into the same file, with `"kind": "quiet"`: a working agent with no new
output for `quietAfter` minutes ([agent status](../status.md#quiet-while-working)). `askedAt` is
when nsq flagged it, `quietSince` when its screen last changed, `question.text` what the screen
showed (`quiet; looks like it's asking: Password for …` or `quiet; last line: …`), and the outcome
says what ended it: `output` (new output), `input` (someone typed, pasted or sent something — `by`
says who), `hook` (the CLI reported progress), `finished`, `needs-input` or `idle` (its status
changed), `setting` (`quietAfter` turned off or raised), `exited` or `unanswered`.

Never in it: the environment, keys or tokens, your prompts — only the question. Secret-looking parts
of a command (`--token …`, `API_KEY=…`, `Authorization: …`, `user:password@`, known key formats)
are masked and long text is cut. The file is readable only by you on macOS/Linux; at 10 MB it moves
to `approvals.1.jsonl` and three old files are kept. Questions dangerous mode approves are not
questions and are not logged. `nsq config set approvalsLog false` stops writing it (what is there
stays); `true` turns it back on — at once, no restart.

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
slug (`vendor/model`) — see [OpenRouter](openrouter.md). With `--provider <name>` (one of
[your own servers](providers.md)) it takes an id from that server's list — such ids often look like
slugs (`qwen/qwen3-coder-30b`) but belong to the server: nsq never moves such an agent to
OpenRouter.

An OpenRouter slug only exists on OpenRouter: on Claude Code's or Codex's own login it is "model
not found". So nsq refuses `nsq run claude --model openai/gpt-5` without `--provider openrouter`
and says so. (OpenCode's own ids are `provider/model` too, so there a slash proves nothing; nsq
does not guess.)

### Changing the model

**m** in the dashboard opens OpenRouter's catalogue (on an agent on one of your own servers: that
server's models, and the agent stays on it). Picking a model **puts the agent on
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
