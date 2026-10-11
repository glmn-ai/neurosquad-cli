---
'neurosquad': minor
'@neurosquad/remote': minor
---

The phone page shows the agent's screen as a real terminal view instead of plain text: colours (16, 256 and truecolor, in nsq's palette), bold, italic, underline, dim, inverse and strikethrough, the cursor, box drawing and wide characters (CJK, emoji), fitted to the phone's width with pinch to zoom. The daemon sends the screen as styled runs from its headless terminal (`/api/agent/<id>/screen?format=styled`, with `since=<version>` for an unchanged screen and gzip), and the page builds it from DOM nodes — agent output is never treated as HTML. The daemon's screens now measure character widths like the dashboard (Unicode graphemes: emoji and CJK two cells).
