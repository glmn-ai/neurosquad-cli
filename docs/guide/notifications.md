# Notifications and sound

When an agent **needs you** or **finishes**, nsq shows a desktop notification and plays a short
sound. The notification carries the question, e.g. _api-fix needs you — Claude wants to run: npm
test_.

The rules:

- **One notification per agent.** A newer one replaces the old one instead of stacking up.
- **"Needs you" stays on screen** until you answer; "finished" is an ordinary notification.
- **Withdrawn when the agent works again** — a notification asking for an answer you already gave
  would be wrong. (Where the system cannot withdraw notifications, it stays until dismissed.)
- **Sound** plays separately from the notification, so turning sound off means no noise at all.

The daemon sends notifications even when the dashboard is closed.

## Per platform

| Platform      | How                                                                                                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11 | native toasts (no extra install). With Focus assist / Do not disturb they go to the notification centre                                                                                                                                                                                                         |
| macOS         | [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) if installed (`brew install terminal-notifier`) — recommended, it can replace and withdraw; otherwise AppleScript notifications, which appear as **Script Editor** (allow them in System Settings → Notifications) and cannot be withdrawn |
| Linux / BSD   | the desktop's notification service over D-Bus (`gdbus`, or `notify-send`); sound through `paplay`, `pw-play` or `aplay`                                                                                                                                                                                         |

## Over SSH and without a desktop

When no desktop notification can be shown — an SSH session, a server, a container — the dashboard
rings **its terminal** instead: a terminal notification where the terminal supports one (OSC 9 for
iTerm2, WezTerm, Ghostty; OSC 777 for foot, urxvt; OSC 99 for kitty; passed through tmux) and the
bell everywhere else. So keep the dashboard open in a terminal on the machine you sit at, e.g. over
SSH.

For notifications on your phone, see [Phone](phone.md).

## Turning it off

In `~/.neurosquad-cli/config.json` ([configuration](configuration.md)):

```json
{ "notifications": false, "sound": false }
```

`NSQ_NO_NOTIFY=1` in the daemon's environment turns desktop notifications off as well.
