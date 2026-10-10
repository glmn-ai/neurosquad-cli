---
'neurosquad': patch
---

`nsq down` returns only once the daemon process has exited, not as soon as its socket closes — so the nsq home can be deleted or replaced right after it, on Windows too.
