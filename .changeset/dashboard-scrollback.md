---
'neurosquad': patch
'@neurosquad/term-view': patch
---

The dashboard scrolls an agent's output back: the mouse wheel over a tile or a full-screen agent (3 lines a notch, a page with Shift) and Shift+PgUp / PgDn / Home / End. The view stays put while new output arrives and says how far back it is (`↑ 120 lines · End or any key to return`); End or any key for the agent returns to the live screen. Agents that asked for the mouse (OpenCode) or run full screen on the alternate screen still get the wheel and those keys themselves. The wheel over the sidebar keeps moving the selection. term-view: `createScrollback` pins the scrolled view with a marker; `wheelTarget` / `wheelKeys` route a wheel notch.
