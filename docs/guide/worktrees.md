# A git worktree per agent

Several agents in one checkout edit the same files and step on each other's changes. With
`--worktree` an agent gets its own [git worktree](https://git-scm.com/docs/git-worktree): a separate
checkout of the same repository, on its own branch.

```sh
cd ~/code/my-app
nsq run claude "fix the flaky checkout test" --worktree --name flaky-test
nsq run codex "update the API docs" --worktree --name api-docs
```

In the dashboard: **c** → worktree.

## What nsq creates

- A new branch **`nsq/<agent name>`**, started from the current `HEAD` of the repository you ran
  `nsq run` in (e.g. `nsq/flaky-test`).
- A checkout of it in **`~/.neurosquad-cli/worktrees/<repo>-<id>`** (by default; under `NSQ_HOME`
  if you set it) — outside your repository unless you point `NSQ_HOME` inside it, so it does not
  show up in your own `git status`.
- The agent runs in that checkout, at the repository root even if you ran `nsq run` from a
  subfolder. `nsq ls` shows its branch.

`--worktree` needs the folder to be inside a git repository. If a branch `nsq/<name>` already
exists (for example from an agent you removed), creating the worktree fails with "could not create
a worktree on branch nsq/<name>": delete the old branch or pick another `--name`.

## Reviewing and merging

```sh
nsq diff flaky-test                 # uncommitted changes in the agent's checkout
git -C ~/code/my-app log -p HEAD..nsq/flaky-test   # what it committed
git -C ~/code/my-app merge nsq/flaky-test
```

The branch lives in your repository like any other, so you can also push it and open a pull
request, or check it out yourself. Commit (or ask the agent to commit) before you remove the agent.

## Removing

```sh
nsq rm flaky-test                   # removes the agent, keeps the checkout and the branch
nsq rm flaky-test --worktree        # also deletes the checkout
```

`--worktree` deletes the checkout folder, **including uncommitted changes in it**. The branch
`nsq/<name>` itself stays in your repository — delete it with `git branch -D nsq/<name>` when you
no longer need it. nsq only ever deletes checkouts inside its own `worktrees` folder.
