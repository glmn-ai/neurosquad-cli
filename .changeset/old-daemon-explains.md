---
'neurosquad': patch
---

A newer nsq on an older running daemon (the hand-over waits while agents are busy) no longer shows a bare "unknown request". The daemon's hello now lists what it can do (`capabilities`) and its "unknown request" reply carries its version; clients check before they ask (older daemons by their version). The dashboard, its phone panel and every command say which daemon runs and what the request needs — "Press U to restart it now (agents resume their sessions), or it restarts by itself when agents are free" in the dashboard, `nsq down && nsq up` on the command line. The phone panel's Notifications tab explains it instead of failing on `s`, and offers U right there: the daemon restarts on this nsq and the panel opens again on the same tab. U in the dashboard also offers that restart whenever the daemon is older, not only while a hand-over waits.
