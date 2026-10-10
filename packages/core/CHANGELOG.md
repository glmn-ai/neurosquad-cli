# @neurosquad/core

## 0.2.1

### Patch Changes

- [#49](https://github.com/glmn-ai/neurosquad-cli/pull/49) [`1f806ee`](https://github.com/glmn-ai/neurosquad-cli/commit/1f806ee269a6ed3d682e2dbcdc989abb8d877906) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Claude Code status: a Stop that is decided late (held for a queued prompt, or waiting on a transcript read) no longer marks a turn that started after it as finished. A prompt typed the instant an agent shows `finished` now stays `working`.

- [#50](https://github.com/glmn-ai/neurosquad-cli/pull/50) [`7ffd718`](https://github.com/glmn-ai/neurosquad-cli/commit/7ffd718d40f31089c94f4bd1fbc95c54499f237c) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Claude Code on OpenRouter with a model that is not Claude's (`deepseek/…`, `openai/…`) failed with "API Error: 400 Invalid Anthropic Messages API request": Claude Code sends any model it does not know the full request of a current Claude (adaptive thinking, effort, context management, safeguards, mid-conversation system messages, pre-release betas). For such slugs nsq now runs it with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and `CLAUDE_CODE_MODEL_CAPABILITIES=-adaptive_thinking,-effort,-mid_conv_system` — the plain Messages request; `anthropic/…` models keep every feature. New: `nsq openrouter test <model> [--harness claude|codex|opencode]` sends one small request the way that CLI does through nsq, with the stored key (never printed), and prints OpenRouter's whole answer — for Claude Code also which of its extras OpenRouter refuses.

## 0.2.0

### Minor Changes

- [#42](https://github.com/glmn-ai/neurosquad-cli/pull/42) [`83027a6`](https://github.com/glmn-ai/neurosquad-cli/commit/83027a6af43a44470d37f2ee63bc0947cfd73008) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Your own model servers: `nsq provider add <name> --url <base>` adds a local server (llama.cpp, Ollama, LM Studio, vLLM, SGLang, Unsloth Studio) or any OpenAI- / Anthropic-compatible API. The connection test lists its models and finds which endpoints it serves; each CLI is offered the server when it can speak to it — Claude Code on Anthropic messages, Codex on responses (or chat completions through a local gateway), OpenCode on either. `nsq run|set --provider <name> --model <id>`, `nsq provider test|list|models|remove`, and in the dashboard a provider choice in New agent (F2 lists the server's models) and a Providers screen (P). The key is optional, asked for without echo or read from stdin, kept in the OS keyring and handed only to the agent's environment; plain http only on this machine or the local network; the served context window reaches each CLI; requests show "no price".

## 0.1.1

### Patch Changes

- [#41](https://github.com/glmn-ai/neurosquad-cli/pull/41) [`95095f9`](https://github.com/glmn-ai/neurosquad-cli/commit/95095f9709e042a238c6025a5016dff7e1b4b774) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Fix "model not found" with OpenRouter models. Picking a model with **m** now switches the agent
  to OpenRouter with it (before, only the model changed, and the CLI got an OpenRouter slug on its
  own login); the first row, "default", goes back to the CLI's own login. The switch restarts the
  agent on the same session — once the agent is idle and you have stopped typing for 3 s, after the turn when it is working — so the
  conversation is kept. `nsq run`/`nsq set` refuse an OpenRouter slug without `--provider openrouter`
  (and a native id on OpenRouter) with the fix; the New agent form switches OpenRouter on for a
  typed `vendor/model` slug; agents saved with a slug and no provider move to OpenRouter at start
  when a key is available. OpenCode on OpenRouter declares the model, so slugs newer than its
  catalogue run. Back on the own login, Claude Code and Codex no longer resume on the session's
  OpenRouter slug.

## 0.1.0

### Minor Changes

- [#24](https://github.com/glmn-ai/neurosquad-cli/pull/24) [`bb07797`](https://github.com/glmn-ai/neurosquad-cli/commit/bb07797b9e543642dce3796135a233cdcbfcb802) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - First release (preview): nsq, the terminal NeuroSquad — run several AI coding agents (Claude Code, Codex, OpenCode) side by side, see which one needs you, answer from the terminal or the phone.

### Patch Changes

- [#14](https://github.com/glmn-ai/neurosquad-cli/pull/14) [`49af567`](https://github.com/glmn-ai/neurosquad-cli/commit/49af567e0f40d0d49313eaea1bb36492a7ecb1ba) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - nsq: the daemon that owns the agents' terminals, the client protocol and the commands (run, ls, attach, send, answer, stop/start/restart, rm, set, diff, peek, cost, openrouter, up/down, doctor). Core: node-pty peer range accepts 1.2 prereleases.

- [#32](https://github.com/glmn-ai/neurosquad-cli/pull/32) [`a646e53`](https://github.com/glmn-ai/neurosquad-cli/commit/a646e5316f4e4e1c42e2e1abb4a68024c1921e3d) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq interrupt` (and `i` in the dashboard, Stop on the phone) interrupts OpenCode agents: the two Escapes go out as separate presses 250 ms apart instead of one write OpenCode read as a single key. Core: `interruptKeys()` returns the presses, `PtyHost.interrupt()` sends a list one press per write (`sendPresses`).
