# @neurosquad/core

## 0.1.1

### Patch Changes

- [#41](https://github.com/glmn-ai/neurosquad-cli/pull/41) [`95095f9`](https://github.com/glmn-ai/neurosquad-cli/commit/95095f9709e042a238c6025a5016dff7e1b4b774) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Fix "model not found" with OpenRouter models. Picking a model with **m** now switches the agent
  to OpenRouter with it (before, only the model changed, and the CLI got an OpenRouter slug on its
  own login); the first row, "default", goes back to the CLI's own login. The switch restarts the
  agent on the same session — at once when it is idle, after the turn when it is working — so the
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
