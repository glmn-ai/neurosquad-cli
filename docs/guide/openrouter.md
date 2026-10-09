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

In the dashboard: **c** → OpenRouter, and **m** picks a model from the catalogue. To move an
existing agent: `nsq set <agent> --provider openrouter --model <slug>` (applies on its next start;
`--provider none` goes back to the CLI's own login).

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
