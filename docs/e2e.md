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

| Check      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hello      | a turn goes working → finished, the answer is on screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| perm       | a permission prompt shows as "needs you" with the question; `nsq answer <agent> yes` approves it, the turn finishes and the command ran                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| resume     | `nsq down` / `nsq up`: the agent comes back on its own session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| cost       | `nsq cost` matches the usage the fake reported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| openrouter | an agent on `--provider openrouter` (pointed at the fake through `NSQ_OPENROUTER_BASE_URL`): every request carries `HTTP-Referer: https://neurosquad.ai/`, `X-OpenRouter-Title`/`X-Title: NeuroSquad`, `X-OpenRouter-Categories: cli-agent,programming-app`, and no `X-OpenRouter-App-Visibility`                                                                                                                                                                                                                                                                                                                                 |
| models     | the model picker's path: an OpenRouter slug without `--provider openrouter` is refused with the fix; picking one (model and provider together, what **m** sends) restarts an idle agent at once on the same session, a working one when its turn ends (a prompt queued meanwhile runs on the new model); an agent saved with a slug and no provider is moved to OpenRouter at start; "default" goes back to the CLI's own login and model. On the wire: the path, the key (fingerprint), the slug unchanged, attribution, the earlier turns in the request. Real slugs from OpenRouter's list (OpenCode: one its catalogue lacks) |
| worktree   | `--worktree` runs the agent in its own checkout; `nsq rm --worktree` deletes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`scripts/e2e/probe.mjs <harness> "<prompt>"` starts one agent in a sandbox and prints its screen —
for debugging a harness's start-up.

The work folder (default: `../.nsq-e2e/` next to the repository — outside it, because harnesses
treat a folder inside a git repository as part of that repository) holds the fake's request log
(`fake-requests.jsonl`, credentials reduced to their last 4 characters) and `checks.json`.

## In CI, on every OS

`.github/workflows/e2e-live.yml` runs the same checks with the real CLIs on macOS arm64 and x64,
Linux and Windows (`scripts/e2e-ci/`): pull requests that touch the CLI run the pinned CLI versions
of `scripts/e2e-ci/clis.json`, the nightly run the newest of each line, and a manual run can test
any ref. Per OS it runs `run.mjs` for Claude Code, Codex, OpenCode 1.x and 2.x plus `extra.mjs`
(interrupt, a question as "needs you"), records the dashboard in a real pty with three agents
(`tui-record.mjs`: grid, full screen and back, BEL + OSC 9 ring, answering from the dashboard; on
Linux first without any X display) and runs dictation from OS-synthesised speech through Whisper
tiny.en (`dictation.mjs`). The run summary has a check × OS table; the `tui-recordings` artifact
has a GIF, an MP4 and PNG screenshots per OS. Checks failing because of an open nsq issue are
listed in `scripts/e2e-ci/known.json` and shown as ⚠️ with the issue instead of failing the job.
