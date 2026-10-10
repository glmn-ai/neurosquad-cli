# OpenRouter

[OpenRouter](https://openrouter.ai) gives one API key for models from many providers. nsq can run
Claude Code, Codex and OpenCode through it — per agent, without touching the CLIs' own
configuration or logins.

## Set up

```sh
nsq openrouter set-key          # paste the key (sk-or-…); it is stored in the OS keyring
nsq openrouter status           # is a key available?
nsq openrouter models sonnet    # search the catalogue, with prices per million tokens
```

The keyring is Windows Credential Manager, the macOS Keychain or the Secret Service on Linux. Where
there is no keyring (a headless server, a container), set `OPENROUTER_API_KEY` in the environment
the daemon starts from instead. `nsq openrouter clear-key` removes the stored key.

## Run an agent on OpenRouter

```sh
nsq run claude --provider openrouter --model anthropic/claude-sonnet-4.5
nsq run codex --provider openrouter --model openai/gpt-5
nsq run opencode --provider openrouter --model qwen/qwen3-coder
```

In the dashboard: **c** → OpenRouter (**F2** picks from the catalogue; a typed `vendor/model` slug
switches OpenRouter on by itself). **m** on an existing agent picks a model from the catalogue and
**switches the agent to OpenRouter** with it, restarted on the same session (the conversation is
kept; a working agent switches when its turn ends). The first row, **default**, goes back to the
CLI's own login. The same from the command line:
`nsq set <agent> --provider openrouter --model <slug>`, and back with
`nsq set <agent> --provider none --model none` — see
[Changing the model](agents.md#changing-the-model).

The slug reaches the CLI unchanged: `ANTHROPIC_MODEL` for Claude Code, `--model` for Codex,
`--model openrouter/<slug>` for OpenCode — which nsq also declares on OpenCode's `openrouter`
provider, because OpenCode refuses models its catalogue does not list yet ("Model not found").

Codex treats a few slugs as its own models: `openai/gpt-6-*` gets the tool format of Codex's
GPT-6 models (code mode, tools sent as an `additional_tools` input item) instead of plain function
tools. Whether OpenRouter's Responses endpoint accepts that could not be checked without a key; if
such an agent cannot run commands, pick another OpenAI slug (`openai/gpt-5.5`) for Codex.

### Claude Code with other models

Claude Code takes any model it does not know for a current Claude and sends it everything:
adaptive thinking, `output_config.effort`, `context_management`, `safeguards`, mid-conversation
`role: "system"` messages and a dozen `anthropic-beta` values. OpenRouter answered that, for
other vendors' models, with `400 Invalid Anthropic Messages API request` — which Claude Code does
not recognise as a refused feature, so it never falls back by itself. For a slug that is not
`anthropic/…`, nsq therefore runs Claude Code with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and
`CLAUDE_CODE_MODEL_CAPABILITIES=-adaptive_thinking,-effort,-mid_conv_system`: the plain Messages
request (thinking with a fixed budget, which OpenRouter maps to the model's reasoning; no effort,
context management or pre-release betas; the system reminders inside the user turn). Claude's own
models keep every feature. `nsq openrouter test <slug>` shows what OpenRouter says to either request
([troubleshooting](troubleshooting.md#openrouter-api-error-400--or-theres-an-issue-with-the-selected-model)).

How each CLI is pointed at OpenRouter (environment variables for Claude Code, a session-only
provider for Codex, a config layer for OpenCode) is described in
[docs/harnesses.md](../harnesses.md). Claude Code needs version 2.1.227 or newer for the
attribution headers below.

## Key safety

nsq keeps the key in the OS keyring (or reads `OPENROUTER_API_KEY` from the daemon's environment)
and hands it to an agent **only** through that agent's environment at launch — never in
command-line arguments, logs or nsq's files. Without a key, the OpenRouter recipe is not applied and the agent runs on its CLI's own
login.

## Attribution

Every OpenRouter request an agent makes carries NeuroSquad's app attribution:

```text
HTTP-Referer: https://neurosquad.ai/
X-OpenRouter-Title: NeuroSquad
X-Title: NeuroSquad
X-OpenRouter-Categories: cli-agent,programming-app
```

This lets OpenRouter list the traffic as coming from NeuroSquad. It identifies the app only — not
you, your prompts or your key. No `X-OpenRouter-App-Visibility` header is sent.
