---
'neurosquad': patch
---

A newer nsq no longer leaves an older daemon running. Upgrading the package (npx picking a new release, `npm i -g`) did not replace a daemon that was already running, so its agents kept the old code: a model picked later was stored but the running process still used the previous one ("There's an issue with the selected model (…)"). Now the first command of a newer nsq (the dashboard, `nsq ls`, `nsq attach`…) restarts the daemon on itself the way an update does — the new daemon starts first and the agents resume on their sessions with the model and provider their records hold. Never while an agent is working, needs you or has prompts queued: it says so and happens once they are free (**U** in the dashboard: now). `nsq doctor` reports a version mismatch.
