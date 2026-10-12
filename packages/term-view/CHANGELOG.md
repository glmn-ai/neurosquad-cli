# @neurosquad/term-view

## 0.1.1

### Patch Changes

- [#65](https://github.com/glmn-ai/neurosquad-cli/pull/65) [`146e508`](https://github.com/glmn-ai/neurosquad-cli/commit/146e508c4296b9945ab606ea063dc1be8146a77c) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The dashboard scrolls an agent's output back: the mouse wheel over a tile or a full-screen agent (3 lines a notch, a page with Shift) and Shift+PgUp / PgDn / Home / End. The view stays put while new output arrives and says how far back it is (`↑ 120 lines · End or any key to return`); End or any key for the agent returns to the live screen. Agents that asked for the mouse (OpenCode) or run full screen on the alternate screen still get the wheel and those keys themselves. The wheel over the sidebar keeps moving the selection. term-view: `createScrollback` pins the scrolled view with a marker; `wheelTarget` / `wheelKeys` route a wheel notch.

## 0.1.0

### Minor Changes

- [#24](https://github.com/glmn-ai/neurosquad-cli/pull/24) [`bb07797`](https://github.com/glmn-ai/neurosquad-cli/commit/bb07797b9e543642dce3796135a233cdcbfcb802) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - First release (preview): nsq, the terminal NeuroSquad — run several AI coding agents (Claude Code, Codex, OpenCode) side by side, see which one needs you, answer from the terminal or the phone.
