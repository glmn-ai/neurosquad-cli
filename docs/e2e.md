# End-to-end checks with real harnesses

`scripts/e2e/` runs nsq with the real Claude Code, Codex and OpenCode CLIs against a **fake model**
(`fake-model.mjs`: Anthropic Messages, OpenAI Responses and Chat Completions, scripted by
`[nsq:<scenario>]` markers in the prompt), in a **sandbox** (`sandbox.mjs`) with its own `HOME`,
nsq home and harness config folders — the user's own logins, keys and settings are never read or
written.

```sh
# Install the CLIs into a folder of your choice, e.g.
npm i --prefix /tmp/clis @anthropic-ai/claude-code @openai/codex opencode-ai
npm run build
node scripts/e2e/run.mjs --harness claude,codex,opencode --bin /tmp/clis/node_modules/.bin
```

Per harness it checks:

| Check      | What                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hello      | a turn goes working → finished, the answer is on screen                                                                                                                                                                                                                                           |
| perm       | a permission prompt shows as "needs you" with the question; `nsq answer <agent> yes` approves it, the turn finishes and the command ran                                                                                                                                                           |
| resume     | `nsq down` / `nsq up`: the agent comes back on its own session                                                                                                                                                                                                                                    |
| cost       | `nsq cost` matches the usage the fake reported                                                                                                                                                                                                                                                    |
| openrouter | an agent on `--provider openrouter` (pointed at the fake through `NSQ_OPENROUTER_BASE_URL`): every request carries `HTTP-Referer: https://neurosquad.ai/`, `X-OpenRouter-Title`/`X-Title: NeuroSquad`, `X-OpenRouter-Categories: cli-agent,programming-app`, and no `X-OpenRouter-App-Visibility` |
| worktree   | `--worktree` runs the agent in its own checkout; `nsq rm --worktree` deletes it                                                                                                                                                                                                                   |

`scripts/e2e/probe.mjs <harness> "<prompt>"` starts one agent in a sandbox and prints its screen —
for debugging a harness's start-up.

The work folder (default: `../.nsq-e2e/` next to the repository — outside it, because harnesses
treat a folder inside a git repository as part of that repository) holds the fake's request log
(`fake-requests.jsonl`, credentials reduced to their last 4 characters) and `checks.json`.
