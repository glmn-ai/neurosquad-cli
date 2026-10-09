---
'@neurosquad/tui-theme': patch
'neurosquad': patch
---

Claude Code is shown with a neutral `CC` glyph (light grey on dark grey) in every logo mode, at Anthropic's request: the Claude Code logo images and its brand colour are no longer shipped, and `logoImage('claude-code', …)` returns `undefined` so the glyph badge stays. The trademark notes now say that harness names are used only to describe which CLI an agent runs.
