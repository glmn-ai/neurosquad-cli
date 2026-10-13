# neurosquad

## 0.5.3

### Patch Changes

- [#74](https://github.com/glmn-ai/neurosquad-cli/pull/74) [`b70076e`](https://github.com/glmn-ai/neurosquad-cli/commit/b70076e9d305f47b61273f5e2b10aaeca7a831fb) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Prices GPT-6 Astra, GPT-6 Sol, GPT-6.1 Sol and GPT-6 Luna (OpenAI's list prices, with their rates above 272K prompt tokens). Codex's `codex-auto-review` and `gpt-5.3-codex-spark` have no published price and stay "no price". The price table is now dated 2026-10-13.
- Updated dependencies [[`b70076e`](https://github.com/glmn-ai/neurosquad-cli/commit/b70076e9d305f47b61273f5e2b10aaeca7a831fb)]:
  - @neurosquad/core@0.4.2

## 0.5.2

### Patch Changes

- [#72](https://github.com/glmn-ai/neurosquad-cli/pull/72) [`ccb686f`](https://github.com/glmn-ai/neurosquad-cli/commit/ccb686f7b84617c35ec4cf3e9d50d28e0e7ae774) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Prices Claude Sonnet 5.5 and Haiku 5.5 (Haiku 5.5 by prompt length: higher prices over 100,000 prompt tokens). The price table is now dated 2026-10-12.
- Updated dependencies [[`ccb686f`](https://github.com/glmn-ai/neurosquad-cli/commit/ccb686f7b84617c35ec4cf3e9d50d28e0e7ae774)]:
  - @neurosquad/core@0.4.1

## 0.5.1

### Patch Changes

- [#70](https://github.com/glmn-ai/neurosquad-cli/pull/70) [`8d8373f`](https://github.com/glmn-ai/neurosquad-cli/commit/8d8373f208d86cc6c43c925d516bb9e25fa5e2b0) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Quiet while working: every way input reaches an agent now ends a quiet episode — typing, a paste, `nsq send` and a prompt from the phone, a queued or first prompt, an interrupt, and an answer's y/a/n keys (the dashboard, `nsq answer`, the phone), which before went in without restarting the quiet clock. They all go through one path in the daemon, so a new one cannot miss it. remote: `PhoneHost.submit` gets the caller, as `answer` and `interrupt` do.
- Updated dependencies [[`8d8373f`](https://github.com/glmn-ai/neurosquad-cli/commit/8d8373f208d86cc6c43c925d516bb9e25fa5e2b0)]:
  - @neurosquad/remote@0.5.1

## 0.5.0

### Minor Changes

- [#68](https://github.com/glmn-ai/neurosquad-cli/pull/68) [`3c14b5c`](https://github.com/glmn-ai/neurosquad-cli/commit/3c14b5c731d4cd220fdb2e3b69e8cf016f9b6834) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Quiet while working: some prompts come from tools that never fire a hook — git asking for a password or a passphrase, an installer's `[y/N]`, `sudo`, ssh's host-key question — or a command simply hangs. When a working agent's screen has not changed for `quietAfter` minutes (default 5, `0` = off, `nsq config set quietAfter 10`; per agent `nsq set <agent> --quiet-after <min>`), nsq flags it **quiet**: `quiet 7m — check it` in the tile, the sidebar and the header counter (`1 needs you · 1 quiet`), in `nsq ls` (and the `quiet` field of `--json`) and on the phone page, with the same desktop notification, terminal bell and ntfy push as "needs you" (`<agent> has been quiet for 7 min` plus the last screen line, secrets masked, at most 300 characters) — but no y/a/n keys. When the last lines look like a prompt (`Password:`, `[y/N]`, `(yes/no)`, a passphrase…) it says so: _looks like it's asking: Password for 'https://github.com':_. New output, typing or pasting into the agent, a sent prompt, an interrupt or a hook clears it; a turning spinner, a rotating verb or a counting timer does not count as output. Quiet episodes go into the approvals log (`"kind": "quiet"`, start, end and what ended it). core: `QuietWatch`, `screenChanged`, `quietPromptHint`; remote: `PhoneAgentSummary.quiet` and the `quiet` attention kind; tui-theme: the `quiet` role.

### Patch Changes

- Updated dependencies [[`3c14b5c`](https://github.com/glmn-ai/neurosquad-cli/commit/3c14b5c731d4cd220fdb2e3b69e8cf016f9b6834)]:
  - @neurosquad/core@0.4.0
  - @neurosquad/remote@0.5.0
  - @neurosquad/tui-theme@0.2.0

## 0.4.2

### Patch Changes

- [#65](https://github.com/glmn-ai/neurosquad-cli/pull/65) [`146e508`](https://github.com/glmn-ai/neurosquad-cli/commit/146e508c4296b9945ab606ea063dc1be8146a77c) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The dashboard scrolls an agent's output back: the mouse wheel over a tile or a full-screen agent (3 lines a notch, a page with Shift) and Shift+PgUp / PgDn / Home / End. The view stays put while new output arrives and says how far back it is (`↑ 120 lines · End or any key to return`); End or any key for the agent returns to the live screen. Agents that asked for the mouse (OpenCode) or run full screen on the alternate screen still get the wheel and those keys themselves. The wheel over the sidebar keeps moving the selection. term-view: `createScrollback` pins the scrolled view with a marker; `wheelTarget` / `wheelKeys` route a wheel notch.

- [#67](https://github.com/glmn-ai/neurosquad-cli/pull/67) [`5082c6d`](https://github.com/glmn-ai/neurosquad-cli/commit/5082c6d6cd6d0211c18e8590d1690a2444e42b57) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq update` and `nsq doctor` no longer list themselves as "1 nsq window is open" among the things holding the restart onto an installed update.
- Updated dependencies [[`146e508`](https://github.com/glmn-ai/neurosquad-cli/commit/146e508c4296b9945ab606ea063dc1be8146a77c)]:
  - @neurosquad/term-view@0.1.1

## 0.4.1

### Patch Changes

- [#63](https://github.com/glmn-ai/neurosquad-cli/pull/63) [`3c06fb8`](https://github.com/glmn-ai/neurosquad-cli/commit/3c06fb876c8b31c3befa1c8302dd4c8190ed9a1f) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - A newer nsq on an older running daemon (the hand-over waits while agents are busy) no longer shows a bare "unknown request". The daemon's hello now lists what it can do (`capabilities`) and its "unknown request" reply carries its version; clients check before they ask (older daemons by their version). The dashboard, its phone panel and every command say which daemon runs and what the request needs — "Press U to restart it now (agents resume their sessions), or it restarts by itself when agents are free" in the dashboard, `nsq down && nsq up` on the command line. The phone panel's Notifications tab explains it instead of failing on `s`, and offers U right there: the daemon restarts on this nsq and the panel opens again on the same tab. U in the dashboard also offers that restart whenever the daemon is older, not only while a hand-over waits.

## 0.4.0

### Minor Changes

- [#60](https://github.com/glmn-ai/neurosquad-cli/pull/60) [`c29f94a`](https://github.com/glmn-ai/neurosquad-cli/commit/c29f94a5b31e335aa076feb2f527d4d1546b58f3) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Phone panel in the dashboard (Q): the pairing QR code right in the terminal (half-block characters, black on white so a phone camera reads it off the monitor), with the link, the mode (this computer / local network / ONLINE through a quick or named tunnel), when the token expires and who is connected; go online / offline, LAN on / off and a new token from the panel, with the cloudflared download and errors shown in it. Going online with O opens it. Its Notifications tab sets up ntfy push in one key (a new random topic, kept in the OS keyring) and shows the QR that subscribes the phone — `ntfy://` for the Android app, the topic's https address and name for an iPhone — then sends a test and shows the last push result. The pairing link and the topic are shown only in this panel.

- [#61](https://github.com/glmn-ai/neurosquad-cli/pull/61) [`79d1d86`](https://github.com/glmn-ai/neurosquad-cli/commit/79d1d862dd9f40635d64267a6e9ab4484d631ac5) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The phone page shows the agent's screen as a real terminal view instead of plain text: colours (16, 256 and truecolor, in nsq's palette), bold, italic, underline, dim, inverse and strikethrough, the cursor, box drawing and wide characters (CJK, emoji), fitted to the phone's width with pinch to zoom. The daemon sends the screen as styled runs from its headless terminal (`/api/agent/<id>/screen?format=styled`, with `since=<version>` for an unchanged screen and gzip), and the page builds it from DOM nodes — agent output is never treated as HTML. The daemon's screens now measure character widths like the dashboard (Unicode graphemes: emoji and CJK two cells).

### Patch Changes

- Updated dependencies [[`79d1d86`](https://github.com/glmn-ai/neurosquad-cli/commit/79d1d862dd9f40635d64267a6e9ab4484d631ac5)]:
  - @neurosquad/remote@0.4.0

## 0.3.0

### Minor Changes

- [#56](https://github.com/glmn-ai/neurosquad-cli/pull/56) [`764aa00`](https://github.com/glmn-ai/neurosquad-cli/commit/764aa00df79fc6f3656a064e62a7cf897a97ce76) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - An approvals log: every "needs you" question, across all agents, and how it ended goes into `~/.neurosquad-cli/logs/approvals.jsonl` — the agent, its CLI and folder, the question as the CLI put it (tool, command / path / url, its text), the answer (yes / always / no) and who gave it from where: the dashboard, `nsq answer`, the phone (this machine, the Wi-Fi or the internet tunnel, and the device), the agent's own terminal, or that the CLI went on by itself, the turn ended, it was interrupted or the agent exited. No environment, tokens or prompts; secret-looking parts of commands are masked, long text cut; rotated at 10 MB. `nsq log approvals [--agent x] [--since 2h] [--json]` prints it; `nsq config set approvalsLog false` turns it off. The phone server tells its host who answered or interrupted (`PhoneCaller`: origin and device label).

- [#57](https://github.com/glmn-ai/neurosquad-cli/pull/57) [`ac1765a`](https://github.com/glmn-ai/neurosquad-cli/commit/ac1765a36b1f4aa4048521de05bdc3be991c3a29) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Agents that support the herdr status protocol (Crush, Kiro CLI, Command Code…) work out of the box with `nsq run -- <agent>`: they report working, needs you (with their message) and finished themselves, their session id is recorded, and a resume command they report brings them back on `nsq restart` and after a daemon restart.

- [#59](https://github.com/glmn-ai/neurosquad-cli/pull/59) [`4c7c248`](https://github.com/glmn-ai/neurosquad-cli/commit/4c7c24861230ef4f424de5512724e6bc05910473) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq run -- claude|codex|opencode …` runs that CLI as its agent (hooks, status, session tracking and resume) instead of a plain command, with its own flags passed through; its prompt, model and dangerous-mode flags become nsq's own. `nsq run --raw -- …` keeps the plain command.

### Patch Changes

- Updated dependencies [[`764aa00`](https://github.com/glmn-ai/neurosquad-cli/commit/764aa00df79fc6f3656a064e62a7cf897a97ce76), [`ac1765a`](https://github.com/glmn-ai/neurosquad-cli/commit/ac1765a36b1f4aa4048521de05bdc3be991c3a29), [`4c7c248`](https://github.com/glmn-ai/neurosquad-cli/commit/4c7c24861230ef4f424de5512724e6bc05910473)]:
  - @neurosquad/remote@0.3.0
  - @neurosquad/core@0.3.0

## 0.2.1

### Patch Changes

- [#50](https://github.com/glmn-ai/neurosquad-cli/pull/50) [`7ffd718`](https://github.com/glmn-ai/neurosquad-cli/commit/7ffd718d40f31089c94f4bd1fbc95c54499f237c) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - A newer nsq no longer leaves an older daemon running. Upgrading the package (npx picking a new release, `npm i -g`) did not replace a daemon that was already running, so its agents kept the old code: a model picked later was stored but the running process still used the previous one ("There's an issue with the selected model (…)"). Now the first command of a newer nsq (the dashboard, `nsq ls`, `nsq attach`…) restarts the daemon on itself the way an update does — the new daemon starts first and the agents resume on their sessions with the model and provider their records hold. Never while an agent is working, needs you or has prompts queued: it says so and happens once they are free (**U** in the dashboard: now). `nsq doctor` reports a version mismatch.

- [#48](https://github.com/glmn-ai/neurosquad-cli/pull/48) [`dae33a1`](https://github.com/glmn-ai/neurosquad-cli/commit/dae33a1ac74e8c2b97d128c3c0f1cc100a601fc7) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - On Windows, `nsq down` now returns only after the daemon process has exited, not as soon as its socket closes. The nsq home can be deleted or replaced right after it.

- [#51](https://github.com/glmn-ai/neurosquad-cli/pull/51) [`1848bfa`](https://github.com/glmn-ai/neurosquad-cli/commit/1848bfaeae115fa18e0c54a24cc64a0e98b54254) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - OpenCode agents now start one at a time. Before, several of them resuming together after `nsq up` or a daemon restart could collide on OpenCode's shared database ("database is locked"). On OpenCode 2 the loser then showed "Standalone server exited before reporting readiness" instead of its session.

- [#50](https://github.com/glmn-ai/neurosquad-cli/pull/50) [`7ffd718`](https://github.com/glmn-ai/neurosquad-cli/commit/7ffd718d40f31089c94f4bd1fbc95c54499f237c) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Claude Code on OpenRouter with a model that is not Claude's (`deepseek/…`, `openai/…`) failed with "API Error: 400 Invalid Anthropic Messages API request": Claude Code sends any model it does not know the full request of a current Claude (adaptive thinking, effort, context management, safeguards, mid-conversation system messages, pre-release betas). For such slugs nsq now runs it with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and `CLAUDE_CODE_MODEL_CAPABILITIES=-adaptive_thinking,-effort,-mid_conv_system` — the plain Messages request; `anthropic/…` models keep every feature. New: `nsq openrouter test <model> [--harness claude|codex|opencode]` sends one small request the way that CLI does through nsq, with the stored key (never printed), and prints OpenRouter's whole answer — for Claude Code also which of its extras OpenRouter refuses.

- [#52](https://github.com/glmn-ai/neurosquad-cli/pull/52) [`94afc1e`](https://github.com/glmn-ai/neurosquad-cli/commit/94afc1e5b7893855224f56f9f732d2b27d809dae) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The dashboard header, the new-agent form's folder, `nsq ls` and `nsq run` show paths under your home folder as `~/…`. You can also type a `~/…` folder in the form.
- Updated dependencies [[`1f806ee`](https://github.com/glmn-ai/neurosquad-cli/commit/1f806ee269a6ed3d682e2dbcdc989abb8d877906), [`7ffd718`](https://github.com/glmn-ai/neurosquad-cli/commit/7ffd718d40f31089c94f4bd1fbc95c54499f237c)]:
  - @neurosquad/core@0.2.1

## 0.2.0

### Minor Changes

- [#36](https://github.com/glmn-ai/neurosquad-cli/pull/36) [`510dea9`](https://github.com/glmn-ai/neurosquad-cli/commit/510dea93dc3593a0016858edab93ec76fdba3c56) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - nsq keeps itself up to date: the daemon checks the npm registry every 6 hours (the package's public metadata only, with an ETag; nothing about you is sent), installs a new release in the background the way nsq was installed (npm into the same prefix, Homebrew, Scoop; npx and other managers get the command to run; never sudo), and restarts onto it once no agent is busy and no dashboard is open — agents resume on their sessions. The dashboard shows the update in its header and **U** installs or applies it now; `nsq update [--check]` and `nsq doctor` show it too, and `nsq --version` in a terminal notes the last known update. Off with `nsq config set autoUpdate false` (or `notify`) or `NSQ_NO_UPDATE=1`; never in CI or from a checkout. New: `nsq config get|set|unset`.

- [#42](https://github.com/glmn-ai/neurosquad-cli/pull/42) [`83027a6`](https://github.com/glmn-ai/neurosquad-cli/commit/83027a6af43a44470d37f2ee63bc0947cfd73008) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Your own model servers: `nsq provider add <name> --url <base>` adds a local server (llama.cpp, Ollama, LM Studio, vLLM, SGLang, Unsloth Studio) or any OpenAI- / Anthropic-compatible API. The connection test lists its models and finds which endpoints it serves; each CLI is offered the server when it can speak to it — Claude Code on Anthropic messages, Codex on responses (or chat completions through a local gateway), OpenCode on either. `nsq run|set --provider <name> --model <id>`, `nsq provider test|list|models|remove`, and in the dashboard a provider choice in New agent (F2 lists the server's models) and a Providers screen (P). The key is optional, asked for without echo or read from stdin, kept in the OS keyring and handed only to the agent's environment; plain http only on this machine or the local network; the served context window reaches each CLI; requests show "no price".

- [#39](https://github.com/glmn-ai/neurosquad-cli/pull/39) [`791c89f`](https://github.com/glmn-ai/neurosquad-cli/commit/791c89f0de9f8bbb34cb99eeea653528da3dae5a) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - `nsq phone on --online`: phone access from anywhere through a Cloudflare quick tunnel (https), an explicit opt-in with a warning, the link and QR printed, `O` in the dashboard to switch it. cloudflared is used from PATH or downloaded once into the nsq home and checked against its published sha256. Through the tunnel, wrong tokens lock an address out (5 → 15 minutes) and plain http is refused; phones that came in from the internet are marked as such. `--expire 12h` makes phones pair again; `nsq phone tunnel-token set` + `--tunnel-token --hostname` use your own named tunnel. `@neurosquad/remote` adds `openTunnelOrigin`, `Lockout`, `ensureCloudflared` and `CloudflareTunnel`.

### Patch Changes

- Updated dependencies [[`83027a6`](https://github.com/glmn-ai/neurosquad-cli/commit/83027a6af43a44470d37f2ee63bc0947cfd73008), [`791c89f`](https://github.com/glmn-ai/neurosquad-cli/commit/791c89f0de9f8bbb34cb99eeea653528da3dae5a)]:
  - @neurosquad/core@0.2.0
  - @neurosquad/remote@0.2.0

## 0.1.2

### Patch Changes

- [#44](https://github.com/glmn-ai/neurosquad-cli/pull/44) [`590ad8d`](https://github.com/glmn-ai/neurosquad-cli/commit/590ad8db4411b24bc2fb65cf04cc442a8f78a7d4) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The Claude Code badge is a `CC` monogram on Claude's orange instead of grey: white on `#d97757` in truecolor, 231 on 173 at 256 colours, and bright white on red at 16 colours (the only badge filled at 16 colours, through a new optional `ansi16` pair on `HarnessLogo`). Still no Claude Code logo; `NSQ_LOGOS=none` stays neutral.

- [#35](https://github.com/glmn-ai/neurosquad-cli/pull/35) [`0393c23`](https://github.com/glmn-ai/neurosquad-cli/commit/0393c23fcd1befc68c310da8e2bdc89bcff5b897) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Claude Code is shown with a `CC` monogram glyph in every logo mode, at Anthropic's request: the Claude Code logo images are no longer shipped, and `logoImage('claude-code', …)` returns `undefined` so the glyph badge stays. The trademark notes now say that harness names are used only to describe which CLI an agent runs.

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
- Updated dependencies [[`590ad8d`](https://github.com/glmn-ai/neurosquad-cli/commit/590ad8db4411b24bc2fb65cf04cc442a8f78a7d4), [`0393c23`](https://github.com/glmn-ai/neurosquad-cli/commit/0393c23fcd1befc68c310da8e2bdc89bcff5b897), [`95095f9`](https://github.com/glmn-ai/neurosquad-cli/commit/95095f9709e042a238c6025a5016dff7e1b4b774)]:
  - @neurosquad/tui-theme@0.1.1
  - @neurosquad/core@0.1.1

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
