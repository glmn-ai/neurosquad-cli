---
'neurosquad': patch
'@neurosquad/remote': patch
---

Quiet while working: every way input reaches an agent now ends a quiet episode — typing, a paste, `nsq send` and a prompt from the phone, a queued or first prompt, an interrupt, and an answer's y/a/n keys (the dashboard, `nsq answer`, the phone), which before went in without restarting the quiet clock. They all go through one path in the daemon, so a new one cannot miss it. remote: `PhoneHost.submit` gets the caller, as `answer` and `interrupt` do.
