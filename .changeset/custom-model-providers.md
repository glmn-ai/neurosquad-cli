---
'neurosquad': minor
'@neurosquad/core': minor
---

Your own model servers: `nsq provider add <name> --url <base>` adds a local server (llama.cpp, Ollama, LM Studio, vLLM, SGLang, Unsloth Studio) or any OpenAI- / Anthropic-compatible API. The connection test lists its models and finds which endpoints it serves; each CLI is offered the server when it can speak to it — Claude Code on Anthropic messages, Codex on responses (or chat completions through a local gateway), OpenCode on either. `nsq run|set --provider <name> --model <id>`, `nsq provider test|list|models|remove`, and in the dashboard a provider choice in New agent (F2 lists the server's models) and a Providers screen (P). The key is optional, asked for without echo or read from stdin, kept in the OS keyring and handed only to the agent's environment; plain http only on this machine or the local network; the served context window reaches each CLI; requests show "no price".
