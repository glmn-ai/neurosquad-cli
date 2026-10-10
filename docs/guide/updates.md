# Updates

nsq keeps itself up to date: when a new release is published, the dashboard shows it, nsq installs
it in the background the same way you installed nsq, and the daemon switches to it when that costs
you nothing — never in the middle of an agent's turn.

## What happens

1. **Check.** The daemon asks the npm registry for the newest `neurosquad` release a few seconds
   after it starts (when the last check is older than 6 hours) and then every 6 hours. It is one
   HTTPS request for the package's public metadata (`registry.npmjs.org/neurosquad`, with an ETag,
   so an unchanged answer is a few bytes). Nothing about you or your machine is sent: no ids, no
   tokens, no usage. The answer is cached in `~/.neurosquad-cli/update.json`.
2. **Install**, in the background, detached from the agents' terminals, with its output in
   `~/.neurosquad-cli/logs/update.log`:

   | Installed with                        | nsq runs                                                       |
   | ------------------------------------- | -------------------------------------------------------------- |
   | `npm install -g`, the install scripts | `npm install -g neurosquad@<version>` into the same npm prefix |
   | Homebrew                              | `brew upgrade glmn-ai/neurosquad/neurosquad-cli`               |
   | Scoop                                 | `scoop update neurosquad-cli`                                  |
   | `npx neurosquad`                      | nothing — it says to run `npx neurosquad@latest`               |
   | pnpm, yarn, bun, Volta, anything else | nothing — it shows the command to run                          |

   nsq never uses `sudo` or asks for administrator rights: when the npm folder is not writable
   (e.g. a system Node.js in `/usr`), it shows the update and the command to run yourself.
   With Homebrew only nsq is upgraded (`HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK`, so none of your other formulae), but Homebrew may upgrade `node` along with it when nsq's formula needs a newer one. Homebrew and Scoop get a release a little after npm (Homebrew a day later); until then the
   dashboard says the release is "not in Homebrew yet" and nsq tries again later. A release that
   needs a newer Node.js than yours is shown, not installed. Afterwards nsq reads the installed
   version back to make sure it worked.

3. **Apply.** The running daemon still runs the old version. It restarts onto the new one by
   itself only when nothing is lost: no agent is working, needs you, is starting or has prompts
   queued; every running agent can resume its session (a plain `nsq run -- <command>` would start
   over, so it waits); no dashboard, `nsq attach` or phone is open; phone access is not online through a quick
   tunnel (it would not come back after the restart, and a phone away from home would lose its
   address — a named tunnel comes back, so it does not hold the update); and nobody typed into an agent
   in the last 5 minutes. Before it switches, it runs the new version once (`--version`): if that fails, the old daemon and every agent keep running and the dashboard says why. The restart is the same as `nsq down` + `nsq up`: agents come back on
   their sessions. Until then the dashboard shows **updated to x.y.z · U restart**.

### A newer nsq meets an older daemon

Upgrades the daemon did not make itself — `npx neurosquad` picking a new release, `npm i -g`,
a Homebrew upgrade by hand — leave the old daemon running. The first command of the newer nsq
restarts it on itself, the same way (the new version starts first, agents resume on their
sessions), as soon as no agent is working, needs you, starts or has prompts queued; until then it
says so, and a daemon of 0.2.1 or later does it by itself once they are free (an older one: at
the next nsq command after that). An open dashboard or a recent
keystroke does not hold it: you are at the newer nsq right now. **U** in the dashboard does it at
once. An older nsq never restarts a newer daemon. `nsq doctor` shows a version mismatch.

## In the dashboard

The header shows what is going on: `update 0.1.0 → 0.2.0`, `installing…`, `updated to 0.2.0 · U
restart`, or `update failed: <reason> · nsq update`. **U** opens the details: for an installed
update it asks to restart now — busy agents are waited for, idle ones resume on their sessions,
plain commands start over — and the dashboard reconnects to the new daemon by itself. After the
switch it says `nsq updated to 0.2.0`.

## Commands

```sh
nsq update            # check now and install the newest release now
nsq update --check    # only check, and say what nsq would do
nsq --version         # the version; on a terminal also "update available: …" from the last check
nsq doctor            # includes the update state and how nsq was installed
```

`nsq update` works even with automatic updates turned off. With the daemon running, the daemon does
the install (the dashboard shows the progress) and restarts onto it at the first safe moment;
without one, it installs right there with npm's output in your terminal.

## Turning it off

```sh
nsq config set autoUpdate notify   # check and show, never install by itself
nsq config set autoUpdate false    # never check
nsq config unset autoUpdate        # back to the default (on)
```

or set `NSQ_NO_UPDATE=1` where the daemon starts. nsq also never checks when `CI` is set, or when it
runs from a development checkout or `npm link`. A different registry (a mirror):
`NSQ_UPDATE_REGISTRY=https://…` — the install itself uses your npm configuration as always.

## When an update fails

The dashboard and `nsq update --check` say why (for example "permission denied") and show the
command to run yourself; the full output is in `~/.neurosquad-cli/logs/update.log`. nsq does not try
the same release again until the next check. If the daemon does not come back after a restart, see
`~/.neurosquad-cli/daemon.log`, then `nsq up`.

On Windows, npm cannot delete the old package's folder while the old daemon still runs it; it leaves
a `.neurosquad-xxxxxxxx` folder next to the package, which nsq removes after the restart.
