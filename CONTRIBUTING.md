# Contributing to nsq

Thanks for helping! This project is fully open source (MIT) and is developed in the open through
issues and pull requests.

## Ground rules

- **Every change goes through a pull request** — including the maintainers' own. Direct pushes to
  `main` are blocked; `main` is protected and only accepts squash-merged PRs.
- Every PR needs an approving review from a code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS))
  and green CI. All review conversations must be resolved before merge.
- An AI review bot (CodeRabbit) comments on every PR. Treat its comments as suggestions: fix what is
  right, reply to what is not. It does not replace the maintainer review.
- Be kind — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- For anything bigger than a small fix, open an issue (or a Discussion) first so we can agree on
  the approach before you spend time on it.

## Development setup

Requirements: Node.js LTS (22 or newer), npm, git. On Windows, building the native terminal addon
may need the "Desktop development with C++" workload of Visual Studio Build Tools; on macOS, Xcode
Command Line Tools; on Linux, `build-essential` and `python3`.

```sh
git clone https://github.com/glmn-ai/neurosquad-cli.git
cd neurosquad-cli
npm ci
npm run lint
npm run typecheck
npm test
```

> The code base is being bootstrapped. If a script above does not exist yet, it will soon — check
> the latest `package.json`.

To try `nsq` with a real harness (Claude Code, Codex, OpenCode), install that CLI yourself. Use a
throwaway folder outside this repository as the agents' working directory.

## Branches

Create a branch from the latest `main`:

| Prefix      | For                                  | Example                         |
| ----------- | ------------------------------------ | ------------------------------- |
| `feat/`     | new features                         | `feat/dashboard-inline-answers` |
| `fix/`      | bug fixes                            | `fix/windows-resize`            |
| `docs/`     | documentation only                   | `docs/install-linux`            |
| `refactor/` | code changes without behavior change | `refactor/status-machine`       |
| `test/`     | tests only                           | `test/codex-hooks`              |
| `chore/`    | tooling, CI, dependencies            | `chore/ci-node-24`              |

## Commits and PR titles: Conventional Commits

We squash-merge, so the **PR title becomes the commit message on `main`** and must follow
[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <summary in imperative mood>
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
Scopes (suggested): `core`, `cli`, `tui`, `daemon`, `pty`, `claude`, `codex`, `opencode`, `notify`,
`worktree`. Breaking changes: `feat(core)!: …` and a `BREAKING CHANGE:` paragraph in the PR body.

Examples: `feat(tui): answer permission prompts inline`, `fix(pty): keep Ctrl+C in attach mode on Windows`.

## Pull request checklist

- [ ] One logical change per PR; small PRs get reviewed faster.
- [ ] A changeset (`npx changeset`) if a published package changes for its users — see
      [`.changeset/README.md`](.changeset/README.md) and [RELEASING.md](RELEASING.md).
- [ ] Tests added or updated for the change; `npm test` passes.
- [ ] `npm run lint` and `npm run typecheck` pass.
- [ ] Cross-platform: think about Windows (ConPTY, paths, `.cmd` shims), macOS and Linux. Say in
      the PR which OS you tested on.
- [ ] We never write the user's own harness config (`~/.claude`, `~/.codex`, `opencode.json`, …);
      everything of ours lives in a per-agent layer.
- [ ] No secrets, tokens or keys in code, logs, argv or test fixtures.
- [ ] Docs/README updated if user-visible behavior changed.
- [ ] PR title follows Conventional Commits.

## Tests

- Unit tests live next to the code (`*.test.ts`). Prefer pure, deterministic tests; fake the
  harness (a small script that prints what the real CLI would) instead of calling a real model.
- Never run tests against your real `~/.claude` / `~/.codex` logins — point the harness at a
  temporary home directory.
- CI runs on Ubuntu, Windows and macOS for every PR.

## AI-assisted contributions

AI-assisted contributions are welcome. You are the author: you must have **reviewed, understood and
tested** everything you submit and be able to explain and change it during review. Low-effort
generated PRs that the author cannot explain will be closed.

## Reporting bugs and asking for features

Use the [issue forms](https://github.com/glmn-ai/neurosquad-cli/issues/new/choose). Security
problems — **not** in public issues; see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
