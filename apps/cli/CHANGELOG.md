# neurosquad

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
