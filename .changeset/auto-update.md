---
'neurosquad': minor
---

nsq keeps itself up to date: the daemon checks the npm registry every 6 hours (the package's public metadata only, with an ETag; nothing about you is sent), installs a new release in the background the way nsq was installed (npm into the same prefix, Homebrew, Scoop; npx and other managers get the command to run; never sudo), and restarts onto it once no agent is busy and no dashboard is open — agents resume on their sessions. The dashboard shows the update in its header and **U** installs or applies it now; `nsq update [--check]`, `nsq --version` and `nsq doctor` show it too. Off with `nsq config set autoUpdate false` (or `notify`) or `NSQ_NO_UPDATE=1`; never in CI or from a checkout. New: `nsq config get|set|unset`.
