# Releasing nsq

Releases are driven by [Changesets](https://changesets.dev) and GitHub Actions. Nobody publishes
from a laptop: npm packages are published by `.github/workflows/release.yml` with **npm trusted
publishing** (OpenID Connect — there is no npm token anywhere) and carry
[provenance](https://docs.npmjs.com/generating-provenance-statements).

| Package              | Path            | npm                                            |
| -------------------- | --------------- | ---------------------------------------------- |
| `neurosquad` (`nsq`) | `apps/cli`      | `npm i -g neurosquad` / `npx neurosquad`       |
| `@neurosquad/core`   | `packages/core` | library shared with the NeuroSquad desktop app |
| helper packages      | `packages/*`    | published when not `"private": true`           |

Each package is versioned independently (semver; `0.x` while in development). Internal dependents
are bumped automatically.

## Day to day: changesets

Every PR that changes what a published package does adds a changeset:

```sh
npx changeset          # pick packages + bump, write 1–2 user-facing lines
```

This writes `.changeset/<random-name>.md`; commit it with the PR. Docs/CI/test-only PRs need none.

## The release, step by step

1. **PRs with changesets merge into `main`.** The release workflow then opens (or updates) the
   **"chore(release): version packages"** PR, authored by the NeuroSquad Dev Bot: versions bumped,
   `CHANGELOG.md` per package written, changesets consumed, `package-lock.json` updated. CI runs on
   it like on any PR.
2. **Review the Version PR**: versions and changelog wording. To add more to the release, merge
   more PRs with changesets — the bot updates the same PR.
3. **Merge the Version PR.** The release workflow sees versions that are not on npm and:
   1. runs the **pack smoke** on every OS/arch (Windows, macOS, Linux × x64/arm64, Node 22/24):
      packs the packages, installs the tarballs in a clean folder with and without install
      scripts, runs `nsq --version`, imports every package and loads every native addon from its
      prebuild (`scripts/release/pack-smoke.mjs`). Any failure stops the release here;
   2. packs the packages once (`changesets/action/pack`);
   3. publishes them from the `npm` environment (`changesets/action/publish`: OIDC, provenance),
      pushes the tags (`neurosquad@x.y.z`, `@neurosquad/core@x.y.z`) and creates the GitHub
      releases from the changelogs.
4. **Check**: `npm view neurosquad version`, the provenance badge on npmjs.com, the GitHub releases,
   and `npx neurosquad@<version> --version` on a clean machine.
5. **Install channels** (run by a maintainer, signed in to `gh` with write access to the tap and
   bucket — tokens never in argv or files):
   - **Homebrew** — wait one day after the npm release (Homebrew installs npm dependencies only
     after a 1-day cooldown, `--min-release-age`), then
     `node scripts/release/channels.mjs homebrew --pr` → PR to `glmn-ai/homebrew-neurosquad`
     (`Formula/neurosquad-cli.rb`; version and sha256 from the registry, integrity verified).
     Users: `brew install glmn-ai/neurosquad/neurosquad-cli`.
   - **Scoop** — the first time: `node scripts/release/channels.mjs scoop --pr` → PR to
     `glmn-ai/scoop-neurosquad` (`bucket/neurosquad-cli.json`). After that the bucket's Excavator
     follows npm by itself (`checkver` + `autoupdate`); to run it now:
     `gh workflow run excavator.yml -R glmn-ai/scoop-neurosquad`.
     Users: `scoop bucket add neurosquad https://github.com/glmn-ai/scoop-neurosquad` +
     `scoop install neurosquad-cli`.
   - **winget** — see [winget](#winget) (needs the standalone Windows build first).
   - **Install scripts** need nothing: `packaging/install/install.sh` / `install.ps1` install the
     latest npm version.
6. **Announce** (X + Discord) with a link to the GitHub release.

Prereleases: `npx changeset pre enter next` on a branch, merge, release as usual (published under
the `next` dist-tag), `npx changeset pre exit` when done.

## One-time setup

### Repository (owner/coordinator)

1. **Bot secrets** for the Version PR (the NeuroSquad Dev Bot GitHub App; a PR made with
   `GITHUB_TOKEN` would get no CI). From the NeuroSquad repo checkout, with `gh` signed in as an
   admin of `glmn-ai/neurosquad-cli`:

   ```sh
   node -e "process.stdout.write(String(require('./secrets/neurosquad-cli-bot/app.json').appId))" \
     | gh secret set NSQ_BOT_APP_ID -R glmn-ai/neurosquad-cli
   gh secret set NSQ_BOT_PRIVATE_KEY -R glmn-ai/neurosquad-cli < secrets/neurosquad-cli-bot/private-key.pem
   gh secret list -R glmn-ai/neurosquad-cli      # both listed; values are never shown
   ```

   Both read from stdin — the key never appears in argv, shell history or logs. The App needs
   (and has) Contents: write and Pull requests: write on this repository; the workflow narrows its
   token to exactly those two.

2. **Environment `npm`**: Settings → Environments → New environment → `npm` (the workflow creates it
   on first use otherwise). Recommended: _Deployment branches and tags_ → selected branches →
   `main`; optionally _Required reviewers_ → the owner, to approve every publish by hand.

3. Settings → Actions → General → _Workflow permissions_: leave "Read repository contents"; the
   workflow asks for more per job. (_Allow GitHub Actions to create pull requests_ is **not**
   needed — the bot App opens the Version PR.)

4. Keep publishing **off** until the first release is ready: the repository variable
   `NPM_PUBLISH_ENABLED` must be unset (or not `true`). With it off, merging a Version PR creates
   no npm release and the run shows a notice.

### npm (owner, once per package)

npm attaches a trusted publisher only to a package that already exists, and **a new trusted
publisher expires if it has not published within 2 days**. So reserve the names any time, and set
up trust right before the first release.

Prerequisites: npm ≥ 11.15 (`npm -v`; `npm i -g npm@^11.15.0`), 2FA enabled on the npm account,
membership with publish rights in the [`@neurosquad`](https://www.npmjs.com/org/neurosquad) org
(it exists; it already holds `@neurosquad/card-sdk`).

1. **Reserve the names** — publishes an empty `0.0.0` placeholder for every public package not yet
   on npm (`@neurosquad/core`, `neurosquad`, the helpers). In this repo:

   ```sh
   npm login                                             # browser + 2FA
   node scripts/release/npm-bootstrap.mjs reserve        # dry run: lists what it would publish
   node scripts/release/npm-bootstrap.mjs reserve --apply
   ```

   If npm rejects an unscoped name as too similar to an existing package, use the scoped fallback
   `@neurosquad/cli` (change `name` in `apps/cli/package.json`, the install scripts' default, the
   templates in `packaging/` take it from there).

2. **First release** (within 2 days after this step):

   ```sh
   node scripts/release/npm-bootstrap.mjs trust --apply  # npm trust github <pkg> --file release.yml
                                                         #   --repo glmn-ai/neurosquad-cli --env npm --allow-publish
   node scripts/release/npm-bootstrap.mjs status         # each package: trusted publisher listed
   gh variable set NPM_PUBLISH_ENABLED -R glmn-ai/neurosquad-cli --body true
   ```

   Then merge the Version PR (or re-run the latest _Release_ run on `main`).

   The same in the web UI: npmjs.com → the package → Settings → Trusted publishing → GitHub
   Actions: organization `glmn-ai`, repository `neurosquad-cli`, workflow `release.yml`,
   environment `npm`, allow `npm publish`.

3. **Lock it down** after the first successful publish, per package: Settings → Publishing access →
   _Require two-factor authentication and disallow tokens_ (trusted publishing keeps working).
   Then `node scripts/release/npm-bootstrap.mjs deprecate-placeholders --apply`.

## Native addons

`nsq` loads native addons: `node-pty` (terminals), `@napi-rs/keyring` (OS keychain), and for
dictation `sherpa-onnx-node`, `uiohook-napi`, `@picovoice/pvrecorder-node`. Users must never need
a compiler: npm is moving to blocking install scripts by default for `npm i -g` / `npx`, and
Homebrew and Scoop install with `--ignore-scripts`. Every addon must therefore load from a
prebuild, which the pack smoke checks per target in its `ignore-scripts` mode.

| Addon                        | win x64 | win arm64 | mac x64 | mac arm64 |     linux x64     |    linux arm64    |
| ---------------------------- | :-----: | :-------: | :-----: | :-------: | :---------------: | :---------------: |
| `node-pty` 1.1.0             |   ✅    |    ✅     |   ✅    |    ✅     |     ❌ source     |     ❌ source     |
| `@napi-rs/keyring`           |   ✅    |    ✅     |   ✅    |    ✅     |    ✅ (+musl)     |    ✅ (+musl)     |
| `uiohook-napi`               |   ✅    |    ✅     |   ✅    |    ✅     | ✅ needs X11 libs | ✅ needs X11 libs |
| `sherpa-onnx-node`           |   ✅    |    ❌     |   ✅    |    ✅     |        ✅         |        ✅         |
| `@picovoice/pvrecorder-node` |   ✅    |    ✅     |   ✅    |    ✅     |        ✅         | Raspberry Pi only |

- **node-pty has no Linux prebuilds** — it compiles with node-gyp, which fails without a toolchain
  and never runs with `--ignore-scripts`. Fix (owner of `apps/cli`/`packages/core`):
  `"node-pty": "npm:@lydell/node-pty@<version>"` — the same API with per-platform prebuilt packages
  (incl. Linux x64/arm64 and Windows' `conpty.dll`) and no install script (Gemini CLI uses it);
  long-term option: our own prebuilt package built in CI.
- **sherpa-onnx has no Windows arm64 build**: dictation must load lazily and degrade there.
- Linux musl (Alpine) is not covered by node-pty prebuilds of either flavour.

## winget

winget has no npm installer type and its portable installs need an `.exe`, so it needs a
self-contained Windows build (`nsq-<version>-win-x64.zip` / `-win-arm64.zip` holding `nsq.exe`, a
Node single-executable application with the native addons) attached to the GitHub release. That
build is not made yet; the manifests are ready in `packaging/winget/` (`NeuroSquad.CLI`, portable
command `nsq`). Once the zips exist:

```sh
node scripts/release/channels.mjs winget --version <x.y.z>   # fills + `winget validate`
```

and open the PR to `microsoft/winget-pkgs` (`manifests/n/NeuroSquad/CLI/<version>/`) the way the
desktop does it (`neurosquad` repo, `scripts/winget-update.mjs --pr`: fork, API commit, one open
PR per package, CLA comment if `Needs-CLA`).

## If something goes wrong

- **Publish failed half-way**: fix and re-run the _Release_ workflow on `main`; changesets publishes
  only versions not yet on npm.
- **Bad version published**: `npm deprecate <pkg>@<version> "<reason>"` and release a fix. Unpublish
  only within 72 h and only if nothing depends on it.
- **Trusted publisher expired / OIDC 404 on publish**: `npm-bootstrap.mjs status`, revoke and
  re-create with `npm trust` (`npm trust revoke <pkg> --id <id>`), then re-run within 2 days.
