# @neurosquad/remote

## 0.2.0

### Minor Changes

- [#39](https://github.com/glmn-ai/neurosquad-cli/pull/39) [`791c89f`](https://github.com/glmn-ai/neurosquad-cli/commit/791c89f0de9f8bbb34cb99eeea653528da3dae5a) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq phone on --online`: phone access from anywhere through a Cloudflare quick tunnel (https), an explicit opt-in with a warning, the link and QR printed, `O` in the dashboard to switch it. cloudflared is used from PATH or downloaded once into the nsq home and checked against its published sha256. Through the tunnel, wrong tokens lock an address out (5 → 15 minutes) and plain http is refused; phones that came in from the internet are marked as such. `--expire 12h` makes phones pair again; `nsq phone tunnel-token set` + `--tunnel-token --hostname` use your own named tunnel. `@neurosquad/remote` adds `openTunnelOrigin`, `Lockout`, `ensureCloudflared` and `CloudflareTunnel`.

## 0.1.0

### Minor Changes

- [#24](https://github.com/glmn-ai/neurosquad-cli/pull/24) [`bb07797`](https://github.com/glmn-ai/neurosquad-cli/commit/bb07797b9e543642dce3796135a233cdcbfcb802) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - First release (preview): nsq, the terminal NeuroSquad — run several AI coding agents (Claude Code, Codex, OpenCode) side by side, see which one needs you, answer from the terminal or the phone.

- [#22](https://github.com/glmn-ai/neurosquad-cli/pull/22) [`558d9a5`](https://github.com/glmn-ai/neurosquad-cli/commit/558d9a5827b88fa1dd44c9296139e4e4f42e6ca5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The phone page: nsq serves a small client for the phone API at / (agents, the question with Yes / Always / No, an agent's screen, a prompt box, interrupt), under a strict CSP, installable to the home screen.

- [#16](https://github.com/glmn-ai/neurosquad-cli/pull/16) [`6d2e9ed`](https://github.com/glmn-ai/neurosquad-cli/commit/6d2e9ed85c16e24eefea3ee832511d6102ae2a84) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - New package: optional NeuroSquad sign-in for nsq (device code, tokens only in the OS keyring) and a token-guarded phone API to watch agents, read their screens, send prompts, answer permission prompts and interrupt.

- [#19](https://github.com/glmn-ai/neurosquad-cli/pull/19) [`a675266`](https://github.com/glmn-ai/neurosquad-cli/commit/a675266940925dac831a187f2f52aaffd11091e5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - PhoneServer.connections(): who is connected (address, a short device label, since, open streams), and onConnectionsChange.
