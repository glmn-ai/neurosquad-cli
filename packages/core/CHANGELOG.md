# @neurosquad/core

## 0.1.0

### Minor Changes

- [#24](https://github.com/glmn-ai/neurosquad-cli/pull/24) [`bb07797`](https://github.com/glmn-ai/neurosquad-cli/commit/bb07797b9e543642dce3796135a233cdcbfcb802) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - First release (preview): nsq, the terminal NeuroSquad — run several AI coding agents (Claude Code, Codex, OpenCode) side by side, see which one needs you, answer from the terminal or the phone.

### Patch Changes

- [#14](https://github.com/glmn-ai/neurosquad-cli/pull/14) [`49af567`](https://github.com/glmn-ai/neurosquad-cli/commit/49af567e0f40d0d49313eaea1bb36492a7ecb1ba) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - nsq: the daemon that owns the agents' terminals, the client protocol and the commands (run, ls, attach, send, answer, stop/start/restart, rm, set, diff, peek, cost, openrouter, up/down, doctor). Core: node-pty peer range accepts 1.2 prereleases.

- [#32](https://github.com/glmn-ai/neurosquad-cli/pull/32) [`a646e53`](https://github.com/glmn-ai/neurosquad-cli/commit/a646e5316f4e4e1c42e2e1abb4a68024c1921e3d) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq interrupt` (and `i` in the dashboard, Stop on the phone) interrupts OpenCode agents: the two Escapes go out as separate presses 250 ms apart instead of one write OpenCode read as a single key. Core: `interruptKeys()` returns the presses, `PtyHost.interrupt()` sends a list one press per write (`sendPresses`).
