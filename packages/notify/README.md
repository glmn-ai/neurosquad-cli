# @neurosquad/notify

Native desktop notifications and sound for [`nsq`](../../README.md), without Electron: "an agent
needs you" and "an agent finished", one notification per agent, replaced in place and withdrawn
the moment the agent works again. When no native backend works (a server, a container, an SSH
session) the terminal takes over with BEL and OSC 9 / OSC 777 / OSC 99.

Node.js ≥ 22.13, no runtime dependencies, no native modules, nothing to compile.

```ts
import { createNotifier } from '@neurosquad/notify'

const notifier = createNotifier({ appName: 'NeuroSquad CLI', appId: 'ai.neurosquad.cli' })

// An agent is blocked on the person: stays on screen until answered.
void notifier.show({
  id: agent.id,
  title: `${agent.name} needs you`,
  body: 'Allow Bash (npm test)?',
  kind: 'needs-input'
})

// The agent is working again (the person answered): take it down.
void notifier.withdraw(agent.id)

notifier.setMuted(true) // notifications still show, no sound
await notifier.status() // { backend, reason, replaceable, soundPlayer, terminal, muted } — for `nsq doctor`
await notifier.dispose() // on exit; toasts already on screen stay
```

## Rules

The same as the NeuroSquad desktop app:

- **One notification per `id`.** Showing again replaces it in place (no stack of stale toasts); a
  burst for one id keeps only the latest.
- **`needs-input` does not time out** (Windows `reminder` scenario with a Dismiss button, Linux
  critical urgency and no expiry); `finished` and `error` are ordinary.
- **`withdraw(id)` when the agent goes back to working.** A toast asking for an answer that was
  already given is a lie. Withdraw is queued behind the show it follows.
- **The toast is silent; the sound plays separately**, so muting means no noise at all. `sound:
false` updates the text without ringing again; a string plays that file instead.
- **Never throws, never blocks.** `show`/`withdraw`/`status` never reject; OS work runs in the
  background; failures go to `log` (default: a deduplicated `console.warn`) and the terminal
  fallback takes over.

## Options

| Option          | Default        | Meaning                                                                                                                                  |
| --------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `appName`       | —              | The sender shown by the OS.                                                                                                              |
| `appId`         | —              | Stable id (`[A-Za-z0-9._-]`): the Windows AppUserModelID, the terminal-notifier group prefix.                                            |
| `iconPath`      | —              | Absolute path to a PNG (Windows sender/logo, Linux icon, terminal-notifier `-appIcon`).                                                  |
| `muted`         | `false`        | Start muted (`setMuted` changes it live).                                                                                                |
| `sounds`        | bundled        | Per-kind sound files (WAV plays everywhere).                                                                                             |
| `terminal`      | `auto`         | `{ mode: 'auto' \| 'always' \| 'never', write?, protocol? }` — `write` lets a daemon route the signal to the attached client's terminal. |
| `native`        | `true`         | `false`: terminal + sound only.                                                                                                          |
| `nativeOverSsh` | `false`        | Over SSH the screen and speakers belong to the remote machine, so the terminal is used unless this is set.                               |
| `registerAppId` | `true`         | Windows: register `appId` (see below).                                                                                                   |
| `log`           | `console.warn` | Failures and fallbacks.                                                                                                                  |

## Platforms

### Windows 10/11

Toasts go through WinRT (`Windows.UI.Notifications`) from one long-lived **Windows PowerShell 5.1**
helper (`assets/windows/toast-bridge.ps1`, JSON lines over stdin/stdout), which also plays the
sound (`System.Media.SoundPlayer`). Started once, lazily, hidden, and unreferenced while idle so it
never keeps a finished CLI alive; it exits when its stdin closes. The script is loaded with
`-Command` from an environment variable, so the execution policy does not apply and no argv
quoting is involved.

- **Replace/withdraw:** the id is the toast `Tag` (group `nsq`); `History.Remove` withdraws.
- **AppUserModelID:** Windows drops toasts from an unpackaged app whose AUMID is unknown. With
  `registerAppId` (default) the helper writes **only** its own per-user key
  `HKCU\Software\Classes\AppUserModelId\<appId>` (`DisplayName`, `IconUri`). No Start-menu
  shortcut, no machine-wide setting. To remove it:
  `reg delete "HKCU\Software\Classes\AppUserModelId\<appId>" /f`.
- **Switched off:** `ToastNotifier.Setting` throws for unpackaged apps, so the helper reads what
  Settings > System > Notifications writes (group policy `NoToastApplicationNotification`, the
  global `ToastEnabled`, the per-app `Enabled`). If toasts are off, `status().reason` is
  `toasts-disabled:DisabledForUser` (etc.) and the terminal is used; the sound still plays.
- Why not a native module: SnoreToast (via node-notifier) is a prebuilt binary unmaintained since
  2022; NodeRT/`@nodert-win10-*` need node-gyp and a matching Windows SDK. PowerShell 5.1 ships
  with every supported Windows.
- Focus assist / Do not disturb sends toasts straight to the Action Center.

### macOS

`UNUserNotificationCenter` only serves a signed app bundle, which a Node process is not, and no
maintained npm module avoids shipping its own `.app`. So:

1. **`terminal-notifier`** (`brew install terminal-notifier`), found on `PATH`, `/opt/homebrew/bin`
   or `/usr/local/bin`: its own app identity, `-group <appId>.<id>` replaces in place, `-remove`
   withdraws.
2. **`osascript`** `display notification` otherwise: always available, but it appears as **Script
   Editor**, needs notifications allowed for Script Editor in System Settings > Notifications
   (macOS may have it off, or ask once), cannot be replaced or withdrawn, and Focus modes silence
   it. Text is passed as run-handler arguments, never spliced into the script.

Sound: `/usr/bin/afplay`.

### Linux / BSD

The freedesktop notification service on the D-Bus session bus (needs `DBUS_SESSION_BUS_ADDRESS`,
`DISPLAY`, `WAYLAND_DISPLAY` or `XDG_RUNTIME_DIR`):

1. **`gdbus`** (GLib): calls `Notify` directly and keeps the returned id, so the next show passes it
   as `replaces_id` and `withdraw` calls `CloseNotification`. `GetServerInformation` is checked
   once, so a bus without a notification daemon falls back to the terminal.
2. **`notify-send`** when gdbus is missing: `--print-id` / `--replace-id` where supported (libnotify
   ≥ 0.7.9); cannot withdraw.

`needs-input` is `urgency=critical` with no expiry; every toast has `suppress-sound`. Sound: the
first of `paplay`, `pw-play`, `aplay`.

### Terminal fallback (anywhere, including SSH)

Used when no native toast was shown (`terminal.mode: 'auto'`), or always (`'always'`). The bell is
the sound when no sound file could be played (and is muted with everything else).

| Terminal                    | Signal                                 |
| --------------------------- | -------------------------------------- |
| iTerm2, WezTerm, Ghostty    | OSC 9 (`ESC ] 9 ; title: body BEL`)    |
| foot, urxvt                 | OSC 777 (`ESC ] 777 ; notify ; t ; b`) |
| kitty                       | OSC 99                                 |
| everything else, GNU screen | BEL only                               |
| inside tmux                 | wrapped in tmux passthrough            |

Unknown terminals get BEL only: most ignore a stray OSC, but not all (ConEmu reads OSC 9 as its
own commands). Text is stripped of control characters so it cannot end the sequence early.

## Sounds

`assets/sounds/{needs-input,finished,error}.wav` are short chimes synthesized from scratch by
`scripts/gen-sounds.mjs` and dedicated to the public domain (CC0 1.0); see
[assets/sounds/LICENSE.md](assets/sounds/LICENSE.md).

## Demo

```sh
npm run demo -w packages/notify             # needs-input -> replaced by finished -> withdrawn
npm run demo -w packages/notify -- --once   # one "finished" toast
#   --muted  --terminal (no native toast)  --always (native + terminal)
```

MIT licensed.
