---
'@neurosquad/core': minor
'neurosquad': minor
---

Agents that support the herdr status protocol (Crush, Kiro CLI, Command Code…) work out of the box with `nsq run -- <agent>`: they report working, needs you (with their message) and finished themselves, their session id is recorded, and a resume command they report brings them back on `nsq restart` and after a daemon restart.
