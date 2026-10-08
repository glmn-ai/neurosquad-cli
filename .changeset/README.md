# Changesets

Every pull request that changes a published package (`@neurosquad/core`, the `nsq` CLI, the helper
packages) adds a changeset: run `npx changeset`, pick the packages and the bump (patch / minor /
major), and write one or two lines for the changelog — what changed for the user, not how.
Docs-, CI- and test-only PRs need none.

On merge to `main`, the release workflow collects the changesets into the "Version Packages" pull
request; merging that PR publishes to npm. Full process: [RELEASING.md](../RELEASING.md).
Changesets docs: <https://changesets.dev>.
