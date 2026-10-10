---
'@neurosquad/core': patch
---

Claude Code status: a Stop that is decided late (held for a queued prompt, or waiting on a transcript read) no longer marks a turn that started after it as finished. A prompt typed the instant an agent shows `finished` now stays `working`.
