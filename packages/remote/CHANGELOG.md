# @neurosquad/remote

## 0.5.0

### Minor Changes

- [#68](https://github.com/glmn-ai/neurosquad-cli/pull/68) [`3c14b5c`](https://github.com/glmn-ai/neurosquad-cli/commit/3c14b5c731d4cd220fdb2e3b69e8cf016f9b6834) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Quiet while working: some prompts come from tools that never fire a hook — git asking for a password or a passphrase, an installer's `[y/N]`, `sudo`, ssh's host-key question — or a command simply hangs. When a working agent's screen has not changed for `quietAfter` minutes (default 5, `0` = off, `nsq config set quietAfter 10`; per agent `nsq set <agent> --quiet-after <min>`), nsq flags it **quiet**: `quiet 7m — check it` in the tile, the sidebar and the header counter (`1 needs you · 1 quiet`), in `nsq ls` (and the `quiet` field of `--json`) and on the phone page, with the same desktop notification, terminal bell and ntfy push as "needs you" (`<agent> has been quiet for 7 min` plus the last screen line, secrets masked, at most 300 characters) — but no y/a/n keys. When the last lines look like a prompt (`Password:`, `[y/N]`, `(yes/no)`, a passphrase…) it says so: _looks like it's asking: Password for 'https://github.com':_. New output, typing or pasting into the agent, a sent prompt, an interrupt or a hook clears it; a turning spinner, a rotating verb or a counting timer does not count as output. Quiet episodes go into the approvals log (`"kind": "quiet"`, start, end and what ended it). core: `QuietWatch`, `screenChanged`, `quietPromptHint`; remote: `PhoneAgentSummary.quiet` and the `quiet` attention kind; tui-theme: the `quiet` role.

## 0.4.0

### Minor Changes

- [#61](https://github.com/glmn-ai/neurosquad-cli/pull/61) [`79d1d86`](https://github.com/glmn-ai/neurosquad-cli/commit/79d1d862dd9f40635d64267a6e9ab4484d631ac5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The phone page shows the agent's screen as a real terminal view instead of plain text: colours (16, 256 and truecolor, in nsq's palette), bold, italic, underline, dim, inverse and strikethrough, the cursor, box drawing and wide characters (CJK, emoji), fitted to the phone's width with pinch to zoom. The daemon sends the screen as styled runs from its headless terminal (`/api/agent/<id>/screen?format=styled`, with `since=<version>` for an unchanged screen and gzip), and the page builds it from DOM nodes — agent output is never treated as HTML. The daemon's screens now measure character widths like the dashboard (Unicode graphemes: emoji and CJK two cells).

## 0.3.0

### Minor Changes

- [#56](https://github.com/glmn-ai/neurosquad-cli/pull/56) [`764aa00`](https://github.com/glmn-ai/neurosquad-cli/commit/764aa00df79fc6f3656a064e62a7cf897a97ce76) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - An approvals log: every "needs you" question, across all agents, and how it ended goes into `~/.neurosquad-cli/logs/approvals.jsonl` — the agent, its CLI and folder, the question as the CLI put it (tool, command / path / url, its text), the answer (yes / always / no) and who gave it from where: the dashboard, `nsq answer`, the phone (this machine, the Wi-Fi or the internet tunnel, and the device), the agent's own terminal, or that the CLI went on by itself, the turn ended, it was interrupted or the agent exited. No environment, tokens or prompts; secret-looking parts of commands are masked, long text cut; rotated at 10 MB. `nsq log approvals [--agent x] [--since 2h] [--json]` prints it; `nsq config set approvalsLog false` turns it off. The phone server tells its host who answered or interrupted (`PhoneCaller`: origin and device label).

## 0.2.0

### Minor Changes

- [#39](https://github.com/glmn-ai/neurosquad-cli/pull/39) [`791c89f`](https://github.com/glmn-ai/neurosquad-cli/commit/791c89f0de9f8bbb34cb99eeea653528da3dae5a) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq phone on --online`: phone access from anywhere through a Cloudflare quick tunnel (https), an explicit opt-in with a warning, the link and QR printed, `O` in the dashboard to switch it. cloudflared is used from PATH or downloaded once into the nsq home and checked against its published sha256. Through the tunnel, wrong tokens lock an address out (5 → 15 minutes) and plain http is refused; phones that came in from the internet are marked as such. `--expire 12h` makes phones pair again; `nsq phone tunnel-token set` + `--tunnel-token --hostname` use your own named tunnel. `@neurosquad/remote` adds `openTunnelOrigin`, `Lockout`, `ensureCloudflared` and `CloudflareTunnel`.

## 0.1.0

### Minor Changes

- [#24](https://github.com/glmn-ai/neurosquad-cli/pull/24) [`bb07797`](https://github.com/glmn-ai/neurosquad-cli/commit/bb07797b9e543642dce3796135a233cdcbfcb802) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - First release (preview): nsq, the terminal NeuroSquad — run several AI coding agents (Claude Code, Codex, OpenCode) side by side, see which one needs you, answer from the terminal or the phone.

- [#22](https://github.com/glmn-ai/neurosquad-cli/pull/22) [`558d9a5`](https://github.com/glmn-ai/neurosquad-cli/commit/558d9a5827b88fa1dd44c9296139e4e4f42e6ca5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The phone page: nsq serves a small client for the phone API at / (agents, the question with Yes / Always / No, an agent's screen, a prompt box, interrupt), under a strict CSP, installable to the home screen.

- [#16](https://github.com/glmn-ai/neurosquad-cli/pull/16) [`6d2e9ed`](https://github.com/glmn-ai/neurosquad-cli/commit/6d2e9ed85c16e24eefea3ee832511d6102ae2a84) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - New package: optional NeuroSquad sign-in for nsq (device code, tokens only in the OS keyring) and a token-guarded phone API to watch agents, read their screens, send prompts, answer permission prompts and interrupt.

- [#19](https://github.com/glmn-ai/neurosquad-cli/pull/19) [`a675266`](https://github.com/glmn-ai/neurosquad-cli/commit/a675266940925dac831a187f2f52aaffd11091e5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - PhoneServer.connections(): who is connected (address, a short device label, since, open streams), and onConnectionsChange.
