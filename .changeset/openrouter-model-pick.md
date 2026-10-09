---
'neurosquad': patch
'@neurosquad/core': patch
---

Fix "model not found" with OpenRouter models. Picking a model with **m** now switches the agent
to OpenRouter with it (before, only the model changed, and the CLI got an OpenRouter slug on its
own login); the first row, "default", goes back to the CLI's own login. The switch restarts the
agent on the same session — at once when it is idle, after the turn when it is working — so the
conversation is kept. `nsq run`/`nsq set` refuse an OpenRouter slug without `--provider openrouter`
(and a native id on OpenRouter) with the fix; the New agent form switches OpenRouter on for a
typed `vendor/model` slug; agents saved with a slug and no provider move to OpenRouter at start
when a key is available. OpenCode on OpenRouter declares the model, so slugs newer than its
catalogue run. Back on the own login, Claude Code and Codex no longer resume on the session's
OpenRouter slug.
