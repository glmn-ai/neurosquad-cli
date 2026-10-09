---
'@neurosquad/dictation': patch
'neurosquad': patch
---

On Linux without an X display (SSH, servers, containers, Wayland-only) the dictation hotkey is skipped instead of taking the dashboard down; the dashboard says so in one line and `v` still dictates.
