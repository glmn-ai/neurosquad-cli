# neurosquad

## 0.1.1

### Patch Changes

- [#23](https://github.com/glmn-ai/neurosquad-cli/pull/23) [`f02fd51`](https://github.com/glmn-ai/neurosquad-cli/commit/f02fd512340ed14d44f10dc6e043bb20a4e494ff) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Push to the phone through ntfy (`nsq phone push ntfy [--url] [--token] | test | show | status | off`): when an agent needs you, its name and question, nothing else; topic URL and token in the OS keyring, your own topic URL and the token asked for or piped in (never on the command line); the server must use https, except plain http to this machine or a local network address, and an access token is sent only over https or to this machine (plain http on the local network is readable by anyone watching that network).

- [#34](https://github.com/glmn-ai/neurosquad-cli/pull/34) [`8e458ce`](https://github.com/glmn-ai/neurosquad-cli/commit/8e458ce8debf9aae4e4bd814534096c1ef354c06) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq phone` with an unknown subcommand now shows the push syntax that shipped: `push ntfy [--url] [--token] | off | test | show | status`.

## 0.1.0

### Minor Changes

- [#24](https://github.com/glmn-ai/neurosquad-cli/pull/24) [`bb07797`](https://github.com/glmn-ai/neurosquad-cli/commit/bb07797b9e543642dce3796135a233cdcbfcb802) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - First release (preview): nsq, the terminal NeuroSquad — run several AI coding agents (Claude Code, Codex, OpenCode) side by side, see which one needs you, answer from the terminal or the phone.

- [#14](https://github.com/glmn-ai/neurosquad-cli/pull/14) [`49af567`](https://github.com/glmn-ai/neurosquad-cli/commit/49af567e0f40d0d49313eaea1bb36492a7ecb1ba) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - nsq: the daemon that owns the agents' terminals, the client protocol and the commands (run, ls, attach, send, answer, stop/start/restart, rm, set, diff, peek, cost, openrouter, up/down, doctor). Core: node-pty peer range accepts 1.2 prereleases.

- [#18](https://github.com/glmn-ai/neurosquad-cli/pull/18) [`346f6ba`](https://github.com/glmn-ai/neurosquad-cli/commit/346f6ba622fb5a060cbd67170ea4e1f9e1f2058b) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The dashboard: a sidebar of workspaces and agents, a grid of live terminals, full screen per agent; inline answers, new agents, the OpenRouter model picker, dictation, terminal notifications when the desktop has none.

- [#19](https://github.com/glmn-ai/neurosquad-cli/pull/19) [`a675266`](https://github.com/glmn-ai/neurosquad-cli/commit/a675266940925dac831a187f2f52aaffd11091e5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Phone access (nsq phone on|off|pair|rotate|status) through @neurosquad/remote's phone API, and the optional account (nsq login|logout|whoami).

- [#22](https://github.com/glmn-ai/neurosquad-cli/pull/22) [`558d9a5`](https://github.com/glmn-ai/neurosquad-cli/commit/558d9a5827b88fa1dd44c9296139e4e4f42e6ca5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The phone page: nsq serves a small client for the phone API at / (agents, the question with Yes / Always / No, an agent's screen, a prompt box, interrupt), under a strict CSP, installable to the home screen.

### Patch Changes

- [#31](https://github.com/glmn-ai/neurosquad-cli/pull/31) [`51c3280`](https://github.com/glmn-ai/neurosquad-cli/commit/51c32807d69d859829365bd579dcabe991ad5b47) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - On Linux without an X display (SSH, servers, containers, Wayland-only) the dictation hotkey is skipped instead of taking the dashboard down; the dashboard says so in one line and `v` still dictates.

- [#19](https://github.com/glmn-ai/neurosquad-cli/pull/19) [`a675266`](https://github.com/glmn-ai/neurosquad-cli/commit/a675266940925dac831a187f2f52aaffd11091e5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Notifications switched off (`notifications: false` or `NSQ_NO_NOTIFY=1`) also silence the dashboard's terminal bell; `nsq set --dangerous` switches OpenCode 2.x agents live, without a restart; the dashboard asks terminals it does not recognise (Windows Terminal, VS Code, Konsole…) whether they draw images, so they get the real logos.

- [#32](https://github.com/glmn-ai/neurosquad-cli/pull/32) [`a646e53`](https://github.com/glmn-ai/neurosquad-cli/commit/a646e5316f4e4e1c42e2e1abb4a68024c1921e3d) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq interrupt` (and `i` in the dashboard, Stop on the phone) interrupts OpenCode agents: the two Escapes go out as separate presses 250 ms apart instead of one write OpenCode read as a single key. Core: `interruptKeys()` returns the presses, `PtyHost.interrupt()` sends a list one press per write (`sendPresses`).
- Updated dependencies [[`bb07797`](https://github.com/glmn-ai/neurosquad-cli/commit/bb07797b9e543642dce3796135a233cdcbfcb802), [`49af567`](https://github.com/glmn-ai/neurosquad-cli/commit/49af567e0f40d0d49313eaea1bb36492a7ecb1ba), [`a646e53`](https://github.com/glmn-ai/neurosquad-cli/commit/a646e5316f4e4e1c42e2e1abb4a68024c1921e3d), [`558d9a5`](https://github.com/glmn-ai/neurosquad-cli/commit/558d9a5827b88fa1dd44c9296139e4e4f42e6ca5), [`6d2e9ed`](https://github.com/glmn-ai/neurosquad-cli/commit/6d2e9ed85c16e24eefea3ee832511d6102ae2a84), [`a675266`](https://github.com/glmn-ai/neurosquad-cli/commit/a675266940925dac831a187f2f52aaffd11091e5)]:
  - @neurosquad/core@0.1.0
  - @neurosquad/notify@0.1.0
  - @neurosquad/remote@0.1.0
  - @neurosquad/term-view@0.1.0
  - @neurosquad/tui-theme@0.1.0
