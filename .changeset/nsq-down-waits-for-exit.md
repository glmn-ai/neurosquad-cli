---
'neurosquad': patch
---

On Windows, `nsq down` now returns only after the daemon process has exited, not as soon as its socket closes. The nsq home can be deleted or replaced right after it.
