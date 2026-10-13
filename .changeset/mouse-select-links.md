---
'neurosquad': minor
'@neurosquad/term-view': minor
---

The dashboard selects text and opens links itself. It holds the mouse, so the terminal couldn't do either: now a drag over an agent's text copies it (OSC 52, plus the system clipboard when local) and shows it inverted, and a click on an http(s) link opens it in the browser (copied instead over SSH). term-view gains `linkAt`, `selectionText`, `bufferTop` and a tile `selection` option.
