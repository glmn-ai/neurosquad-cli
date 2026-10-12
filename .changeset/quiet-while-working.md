---
'neurosquad': minor
'@neurosquad/core': minor
'@neurosquad/remote': minor
'@neurosquad/tui-theme': minor
---

Quiet while working: some prompts come from tools that never fire a hook — git asking for a password or a passphrase, an installer's `[y/N]`, `sudo`, ssh's host-key question — or a command simply hangs. When a working agent's screen has not changed for `quietAfter` minutes (default 5, `0` = off, `nsq config set quietAfter 10`; per agent `nsq set <agent> --quiet-after <min>`), nsq flags it **quiet**: `quiet 7m — check it` in the tile, the sidebar and the header counter (`1 needs you · 1 quiet`), in `nsq ls` (and the `quiet` field of `--json`) and on the phone page, with the same desktop notification, terminal bell and ntfy push as "needs you" (`<agent> has been quiet for 7 min` plus the last screen line, secrets masked, at most 300 characters) — but no y/a/n keys. When the last lines look like a prompt (`Password:`, `[y/N]`, `(yes/no)`, a passphrase…) it says so: _looks like it's asking: Password for 'https://github.com':_. New output, any input or a hook clears it; a turning spinner, a rotating verb or a counting timer does not count as output. Quiet episodes go into the approvals log (`"kind": "quiet"`, start, end and what ended it). core: `QuietWatch`, `screenChanged`, `quietPromptHint`; remote: `PhoneAgentSummary.quiet` and the `quiet` attention kind; tui-theme: the `quiet` role.
