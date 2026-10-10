---
'neurosquad': patch
---

OpenCode agents now start one at a time. Before, several of them resuming together after `nsq up` or a daemon restart could collide on OpenCode's shared database ("database is locked"). On OpenCode 2 the loser then showed "Standalone server exited before reporting readiness" instead of its session.
