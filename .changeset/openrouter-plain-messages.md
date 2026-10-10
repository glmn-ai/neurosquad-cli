---
'@neurosquad/core': patch
'neurosquad': patch
---

Claude Code on OpenRouter with a model that is not Claude's (`deepseek/…`, `openai/…`) failed with "API Error: 400 Invalid Anthropic Messages API request": Claude Code sends any model it does not know the full request of a current Claude (adaptive thinking, effort, context management, safeguards, mid-conversation system messages, pre-release betas). For such slugs nsq now runs it with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and `CLAUDE_CODE_MODEL_CAPABILITIES=-adaptive_thinking,-effort,-mid_conv_system` — the plain Messages request; `anthropic/…` models keep every feature. New: `nsq openrouter test <model> [--harness claude|codex|opencode]` sends one small request the way that CLI does through nsq, with the stored key (never printed), and prints OpenRouter's whole answer — for Claude Code also which of its extras OpenRouter refuses.
