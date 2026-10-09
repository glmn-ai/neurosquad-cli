# @neurosquad/tui-theme

## 0.1.1

### Patch Changes

- [#44](https://github.com/glmn-ai/neurosquad-cli/pull/44) [`590ad8d`](https://github.com/glmn-ai/neurosquad-cli/commit/590ad8db4411b24bc2fb65cf04cc442a8f78a7d4) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - The Claude Code badge is a `CC` monogram on Claude's orange instead of grey: white on `#d97757` in truecolor, 231 on 173 at 256 colours, and bright white on red at 16 colours (the only badge filled at 16 colours, through a new optional `ansi16` pair on `HarnessLogo`). Still no Claude Code logo; `NSQ_LOGOS=none` stays neutral.

- [#35](https://github.com/glmn-ai/neurosquad-cli/pull/35) [`0393c23`](https://github.com/glmn-ai/neurosquad-cli/commit/0393c23fcd1befc68c310da8e2bdc89bcff5b897) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - Claude Code is shown with a `CC` monogram glyph in every logo mode, at Anthropic's request: the Claude Code logo images are no longer shipped, and `logoImage('claude-code', …)` returns `undefined` so the glyph badge stays. The trademark notes now say that harness names are used only to describe which CLI an agent runs.

## 0.1.0

### Minor Changes

- [#24](https://github.com/glmn-ai/neurosquad-cli/pull/24) [`bb07797`](https://github.com/glmn-ai/neurosquad-cli/commit/bb07797b9e543642dce3796135a233cdcbfcb802) Thanks [@neurosquad-dev-bot](https://github.com/apps/neurosquad-dev-bot)! - First release (preview): nsq, the terminal NeuroSquad — run several AI coding agents (Claude Code, Codex, OpenCode) side by side, see which one needs you, answer from the terminal or the phone.
