# Harness integrations

How `@neurosquad/core` starts each supported coding CLI and learns its status. One rule holds for
every harness: **the user's own configuration is never written.** Everything an agent needs lives
in a per-agent layer — command-line flags, environment variables, and files in a directory the host
owns (`~/.neurosquad-cli/layers/<harness>/` for `nsq`).

Status facts arrive on a loopback HTTP endpoint, `POST http://127.0.0.1:<port>/hook/<token>/<agentId>/<event>`,
where the token is an HMAC of the agent id with a per-run secret (compared in constant time). The
facts pass through the state machine described in [status.md](status.md).

## Claude Code

| What           | How                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks          | `--settings <file>` (merged over the user's settings): command hooks `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStart`, `SubagentStop` (a `curl` that posts the hook's stdin), `http` hooks `PostToolUse` and `PermissionRequest` |
| Session        | `--session-id <agentId>` on the first start, `--resume <agentId>` afterwards; "No conversation found with session ID" → a fresh session                                                                                                     |
| Needs you      | `Notification` with a blocking `notification_type` (`permission_prompt`, `elicitation_dialog`, `worker_permission_prompt`); the text comes from the `PermissionRequest` payload ("Claude wants to run: npm test")                           |
| Ground truth   | the session transcript named in every hook payload (`transcript_path`): interrupts, API errors and queued prompts send no hook and are read from its tail                                                                                   |
| Dangerous mode | live: the `PermissionRequest` hook answers `allow` while the agent's dangerous mode is on, `{}` (show the dialog) otherwise. Deny rules never reach the hook                                                                                |
| Folder trust   | the "Quick safety check" prompt is answered (the user picked the folder)                                                                                                                                                                    |
| Interrupt      | Escape                                                                                                                                                                                                                                      |
| OpenRouter     | `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_API_KEY=` (empty), `ANTHROPIC_MODEL` and the default-model variables, attribution in `ANTHROPIC_CUSTOM_HEADERS` (Claude Code ≥ 2.1.227)            |
| Usage          | `~/.claude/projects/**/<session>.jsonl` (`CLAUDE_CONFIG_DIR` respected)                                                                                                                                                                     |

## Codex CLI

| What           | How                                                                                                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks          | `-c hooks={…}` (the session-flags layer, merged over `~/.codex/config.toml`): `UserPromptSubmit`, `Stop`, `PermissionRequest`, `Interrupt`, `PreToolUse`/`PostToolUse` for `request_user_input`. Each hook is `curl -K <file>`; the per-agent URL (with its token) lives in that curl config file, never in argv |
| Hook trust     | each hook's trust record (`hooks.state.<key>.trusted_hash`) is passed in the same layer: SHA-256 of the canonical JSON of the hook, as Codex computes it. A repository's own hooks are not trusted by this                                                                                                       |
| Session        | Codex picks its ids; the first hook of a turn reports it and the next start is `codex resume <id>`                                                                                                                                                                                                               |
| Failed turns   | Codex runs no Stop for a turn that ends in an error; its "■ …" error line ends the turn                                                                                                                                                                                                                          |
| Folder trust   | `projects.<cwd>.trust_level="trusted"` in the same layer                                                                                                                                                                                                                                                         |
| Dangerous mode | `--dangerously-bypass-approvals-and-sandbox` at launch                                                                                                                                                                                                                                                           |
| Interrupt      | Escape (Ctrl+C on an idle Codex quits it)                                                                                                                                                                                                                                                                        |
| Windows        | npm's `codex.cmd` is bypassed: the `codex.exe` behind it is spawned directly                                                                                                                                                                                                                                     |
| OpenRouter     | `-c model_provider=openrouter` plus the `openrouter` provider (`base_url`, `env_key=OPENROUTER_API_KEY`, `wire_api=responses`, attribution in `http_headers`); the key in the child's env                                                                                                                        |
| Usage          | `~/.codex/sessions/**/rollout-*.jsonl` (`CODEX_HOME` respected)                                                                                                                                                                                                                                                  |

## OpenCode

OpenCode 1.x (npm `opencode-ai`) and OpenCode 2 (npm `@opencode/cli`) are told apart by
`opencode --version`.

| What           | 1.x                                                                                                                                                                                                                          | 2.x                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Layer          | `OPENCODE_CONFIG=<file>` with the plugin by file URL                                                                                                                                                                         | the same variable; the plugin is a directory (`plugins: [<dir>]`)                       |
| Facts          | plugin `event` hook: `session.status` busy/idle, `permission.asked`/`replied`, `question.*`                                                                                                                                  | plugin `ctx.event.subscribe()`: `session.execution.*`, `permission.*`, `form.*`         |
| Session        | reported by the plugin, resumed with `--session <id>`                                                                                                                                                                        | chosen by the host: `--standalone --session ses_…`                                      |
| Dangerous mode | `--auto` at launch                                                                                                                                                                                                           | live: `permission.evaluate` asks the host and turns "ask" into "allow"                  |
| Model          | `--model provider/model` (pinned on resume by the plugin)                                                                                                                                                                    | moved into `OPENCODE_CONFIG_CONTENT` (`--model` is not an option of the full-screen UI) |
| OpenRouter     | `--model openrouter/<slug>`, key in env, attribution and the model's declaration (`provider.openrouter.models[<slug>]`, for slugs newer than OpenCode's catalogue) in `OPENCODE_CONFIG_CONTENT`, the plugin's `chat.headers` | the same key and config, attribution by the plugin's `model.request` hook               |
| Interrupt      | Escape twice                                                                                                                                                                                                                 | Escape twice                                                                            |
| Usage          | `opencode.db` (read-only, `node:sqlite`)                                                                                                                                                                                     | the same file, 2.x tables                                                               |

## Any command

`nsq run -- <command…>` runs anything in a terminal. It has no hooks: output marks it working, and
`GENERIC_QUIET_MS` (2.5 s) of silence marks it finished. It never claims "needs you".

## OpenRouter attribution

Every OpenRouter request an agent makes carries:

```text
HTTP-Referer: https://neurosquad.ai/
X-OpenRouter-Title: NeuroSquad
X-Title: NeuroSquad
X-OpenRouter-Categories: cli-agent,programming-app
```

No `X-OpenRouter-App-Visibility` header is sent. The key is read from the OS keyring (or
`OPENROUTER_API_KEY`) and goes into the agent's environment only — never argv, logs or files.
Without a key the recipe is not applied and the harness runs on its own login.
