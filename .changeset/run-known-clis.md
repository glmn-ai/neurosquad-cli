---
'@neurosquad/core': minor
'neurosquad': minor
---

`nsq run -- claude|codex|opencode …` runs that CLI as its agent (hooks, status, session tracking and resume) instead of a plain command, with its own flags passed through; its prompt, model and dangerous-mode flags become nsq's own. `nsq run --raw -- …` keeps the plain command.
