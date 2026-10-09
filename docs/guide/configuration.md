# Configuration

nsq works without any configuration. Settings live in **`~/.neurosquad-cli/config.json`**; every
field is optional, and a missing or malformed file means the defaults. `nsq config` prints it;
`nsq config set <key> <value>` / `unset <key>` change `autoUpdate`, `notifications`, `sound`,
`logos`, `color`, `layout` and `detachKey`. The dashboard reads it when
it opens; the daemon (notifications, sound, phone) when it starts — after changing those,
`nsq down` and `nsq up` (the agents resume).

```json
{
  "logos": "auto",
  "notifications": true,
  "sound": true,
  "detachKey": "Ctrl+]",
  "dictation": { "enabled": true, "hotkey": "CommandOrControl+Shift+Space" },
  "phone": { "enabled": false, "lan": false, "port": 8766 }
}
```

| Field           | Default                            | What                                                                                                                                       |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `logos`         | `"auto"`                           | CLI logos: `"auto"` / `"images"` (real logos where the terminal can draw them), `"glyphs"` (two-cell badges), `"neutral"` (no brand marks) |
| `notifications` | `true`                             | desktop notifications, or the terminal bell when none can show; `false` silences both ([notifications](notifications.md))                  |
| `sound`         | `true`                             | a sound with each notification                                                                                                             |
| `detachKey`     | `"Ctrl+]"`                         | the key that leaves a full-screen agent: `Ctrl+` and a letter or one of `@ [ \ ] ^ _`; anything else falls back to Ctrl+]                  |
| `dictation`     | on, `CommandOrControl+Shift+Space` | `enabled`, `hotkey`, `mode` (default: a tap toggles, a hold records; or `toggle` / `hold`), `model` ([dictation](dictation.md))            |
| `phone`         | off                                | written by `nsq phone on` / `nsq phone off` ([phone](phone.md))                                                                            |
| `autoUpdate`    | `true`                             | `true`: check and install new releases by itself; `"notify"`: only show them; `false`: never check ([updates](updates.md))                 |

## Environment variables

| Variable                         | What                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `NSQ_HOME`                       | where nsq keeps its data (default `~/.neurosquad-cli`); each home has its own daemon                |
| `OPENROUTER_API_KEY`             | the OpenRouter key when there is no OS keyring ([OpenRouter](openrouter.md))                        |
| `NSQ_NO_ANIMATION=1`             | no animations (`NSQ_ANIMATION=1` forces them on, e.g. over SSH)                                     |
| `NSQ_LOGOS`                      | `images`, `glyphs` or `none` — overrides the logo style                                             |
| `NSQ_IMAGES=0`                   | never draw images in the terminal                                                                   |
| `NSQ_COLOR`                      | `truecolor`, `256`, `16` or `none`; otherwise detected (`NO_COLOR` and `FORCE_COLOR` are respected) |
| `NSQ_GLYPHS`                     | `ascii` or `unicode` — the set used for borders and status glyphs                                   |
| `NSQ_AMBIGUOUS_WIDE=1`           | for CJK terminals set to "ambiguous width = wide": switches to ASCII so borders line up             |
| `NSQ_NO_NOTIFY=1`                | notifications off: no desktop notifications, and the dashboard does not ring its terminal either    |
| `NSQ_NTFY_URL`, `NSQ_NTFY_TOKEN` | the ntfy push topic URL and token when there is no OS keyring ([phone](phone.md))                   |
| `NSQ_OPENROUTER_BASE_URL`        | another OpenRouter-compatible API base (`…/api/v1`)                                                 |
| `NSQ_NO_BROWSER=1`               | `nsq login` prints the link instead of opening a browser                                            |
| `NSQ_NO_UPDATE=1`                | no update checks or installs ([updates](updates.md)); also off when `CI` is set                     |
| `NSQ_UPDATE_REGISTRY`            | another npm registry for the update check (`https://…`)                                             |

Variables that affect the daemon (`OPENROUTER_API_KEY`, `NSQ_OPENROUTER_BASE_URL`, `NSQ_NO_NOTIFY`,
`NSQ_NTFY_URL`, `NSQ_NTFY_TOKEN`, `NSQ_NO_UPDATE`, `NSQ_HOME`) must be set
where the daemon starts — the first `nsq` command that needs it — or restart it with `nsq down` /
`nsq up`.

## What is stored where

| Path (under `~/.neurosquad-cli`) | What                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `config.json`                    | your settings                                                    |
| `agents.json`                    | the agents: name, harness, folder, session, model, branch        |
| `layers/`                        | per-agent hook and plugin settings handed to the CLIs            |
| `worktrees/`                     | agents' git checkouts ([worktrees](worktrees.md))                |
| `models/`                        | dictation models                                                 |
| `daemon.json`                    | the running daemon's address and access token (owner-only)       |
| `daemon.log`                     | the daemon's log (no secrets)                                    |
| `phone-token`                    | the phone pairing token (owner-only)                             |
| `cloud.json`                     | account state when signed in (no tokens)                         |
| `update.json`                    | the last update check and install ([updates](updates.md))        |
| `logs/update.log`                | the installer's output                                           |
| `nsq.sock`                       | the daemon socket on macOS/Linux when `XDG_RUNTIME_DIR` is unset |

Secrets (the OpenRouter key, the ntfy push topic and token, the optional account session) are kept
in the OS keyring, not in
these files. The CLIs keep their own data (sessions, transcripts, logins) where they always do.

**Privacy:** nsq has no telemetry. No account is needed. The update check sends nothing about you
([updates](updates.md)).
