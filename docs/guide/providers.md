# Your own model servers

Besides [OpenRouter](openrouter.md), an agent can run on a server of your own: a local one —
**llama.cpp**, **Ollama**, **LM Studio**, **vLLM**, **SGLang**, **Unsloth Studio** — or any remote
API that speaks the **OpenAI** API (chat completions or responses) or the **Anthropic** Messages
API. Per agent, without touching the CLIs' own configuration or logins.

## Add a server

```sh
nsq provider add lmstudio --url http://localhost:1234
nsq provider add box --url http://192.168.1.20:8000 --ask-key     # asks for the key, not shown
echo "$KEY" | nsq provider add work --url https://llm.example.com/v1 --key-stdin
```

`add` tests the server before it stores anything: it lists the models (`GET /v1/models`) and finds
which endpoints the server has — OpenAI `POST /v1/chat/completions`, OpenAI `POST /v1/responses`,
Anthropic `POST /v1/messages`. You never pick the API: each CLI is offered the server when the
endpoint it needs is there, and `add` prints which ones are:

```text
added lmstudio: localhost:1234 — 12 models, endpoints: chat, responses, messages (9 ms)
  Claude Code  yes
  Codex        yes
  OpenCode     yes (chat completions)
```

The address may be pasted with or without `/v1` (or even a whole `…/v1/chat/completions`); a
server under a sub-path keeps it (`https://api.example.com/anthropic`). Without a scheme, a local
address gets `http://` and anything else `https://`.

```sh
nsq provider list                    # address, endpoints, models, whether a key is stored
nsq provider models lmstudio [qwen]  # the server's models now (and the context window it serves)
nsq provider test lmstudio           # test again: new models, an updated server
nsq provider test lmstudio --ask-key # …with a new key (--clear-key forgets it)
nsq provider remove lmstudio
```

## Run an agent on it

```sh
nsq run claude   --provider lmstudio --model qwen/qwen3-coder-30b
nsq run codex    --provider ollama   --model qwen3-coder:30b
nsq run opencode --provider vllm     --model Qwen/Qwen3-Coder-30B-A3B-Instruct
nsq set api-fix --provider lmstudio --model qwen/qwen3-coder-30b   # move an existing agent
nsq set api-fix --provider none --model none                        # back to the CLI's own login
```

The model is an id from the server's own list. A server with one model needs no `--model`.

In the dashboard: **c** (New agent) → **Provider** — **← →** cycles through _own login_,
_OpenRouter_ and each of your servers that fits the chosen CLI (the ones that do not are listed
with the reason) — and **F2** lists that server's models. **m** on an agent lists its server's
models. **P** opens the Providers screen: **a** adds a server (**F2** fills in the default
addresses below, the key field is masked), **t** tests one again, **Enter** shows its models,
**x** removes it.

## Which CLI uses which API

| CLI         | Uses                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Anthropic Messages (`/v1/messages`) only — a server without it is not offered                                                                                                                   |
| Codex       | OpenAI Responses (`/v1/responses`); on a server with chat completions only, nsq runs a local gateway that translates Responses ⇄ chat completions (the key stays with nsq, Codex never sees it) |
| OpenCode    | OpenAI chat completions (`@ai-sdk/openai-compatible`), or the Anthropic Messages API when the server has no chat endpoint (`@ai-sdk/anthropic`)                                                 |

A server with only `/v1/responses` is accepted too; only Codex is offered it.

## Servers

What each server serves today, from its own documentation (checked October 2026) — the connection
test decides for your version:

| Server                     | Default address                                                   | Chat completions | Responses     | Anthropic messages | Context window in its model list | Key by default                   |
| -------------------------- | ----------------------------------------------------------------- | ---------------- | ------------- | ------------------ | -------------------------------- | -------------------------------- |
| llama.cpp (`llama-server`) | `http://127.0.0.1:8080` (`:9931` from build b11521, October 2026) | yes              | yes           | yes                | `meta.n_ctx`                     | no (`--api-key`)                 |
| Ollama                     | `http://localhost:11434`                                          | yes              | yes (0.13.3+) | yes (0.14.0+)      | not listed                       | no                               |
| LM Studio                  | `http://localhost:1234`                                           | yes              | yes (0.3.29+) | yes (0.4.1+)       | not listed                       | no (optional API tokens, 0.4.0+) |
| vLLM (`vllm serve`)        | `http://localhost:8000`                                           | yes              | yes (0.10.0+) | yes (0.11.1+)      | `max_model_len`                  | no (`--api-key`)                 |
| SGLang                     | `http://localhost:30000`                                          | yes              | yes           | yes (0.5.9+)       | `max_model_len`                  | no (`--api-key`)                 |
| Unsloth Studio             | `http://localhost:8888`                                           | yes              | yes           | yes                | `context_length`                 | **yes** (`sk-unsloth-…`)         |

So with a current version of any of them, all three CLIs run directly. Tested end to end with the
real CLIs against llama.cpp (`llama-server` b11524): Claude Code on `/v1/messages`, Codex on
`/v1/responses` and through the gateway on `/v1/chat/completions`, OpenCode on
`/v1/chat/completions`. llama.cpp needs `--jinja` for tool calls.

**Context window.** When the server's model list says how large a context it serves the model with,
each CLI is told — Claude Code (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), Codex (`model_context_window`,
compacting at 85 %), OpenCode (the model's `limit.context`) — so a long session compacts before the
server's window is full instead of failing. Agentic CLIs send long prompts (Claude Code's alone is
well over 10 000 tokens): start the server with a large enough context (`llama-server -c 32768`,
Ollama's `OLLAMA_CONTEXT_LENGTH`, LM Studio's context length setting).

## Key safety

- The key is optional (local servers need none). It is asked for without echo (`--ask-key`) or read
  from stdin (`--key-stdin`) — **never** a command-line argument, which every process on the
  machine can read; `--key <value>` is refused.
- It is kept in the OS keyring (Windows Credential Manager, the macOS Keychain, the Secret Service
  on Linux). Without a keyring, set `NSQ_PROVIDER_KEY_<NAME>` (e.g. `NSQ_PROVIDER_KEY_LMSTUDIO`)
  where the daemon starts instead.
- An agent gets it only through its environment at launch — never in argv, logs or nsq's files
  (`providers.json` holds the address, the endpoints and the model list, no secret). Codex on the
  gateway gets a per-agent credential of the gateway instead of the key.
- Plain `http://` is accepted only for this machine and the local network (with a warning on the
  network: the prompts, your code and the key travel unencrypted). Anything else needs `https://`.
  Redirects are never followed — the key would go wherever they point.
- No OpenRouter attribution header is ever sent to your servers.
- If the server is removed, or no longer has the endpoint the CLI needs, the agent does not start
  instead of falling back to the CLI's own login.
- Claude Code: the server's address and model are also set in the agent's own settings layer, and
  `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` are switched off — so an `ANTHROPIC_BASE_URL`
  or a cloud backend in your environment or `~/.claude/settings.json` does not redirect the agent.
  Nor does an `ANTHROPIC_AUTH_TOKEN` there: the agent's key reaches Claude Code through an
  `apiKeyHelper` that reads it from the agent's environment. Other configuration of the CLIs themselves (a Codex profile, OpenCode plugins) is
  yours and not inspected.

## Cost

nsq does not know what your server charges: every request of an agent on one of your servers shows
**no price** in `nsq cost` and the dashboard — never $0, and never a price guessed from the model's
name. That includes the agent's earlier requests from before it moved to the server (nsq cannot
tell which server answered them).
