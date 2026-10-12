# Notifications and sound

When an agent **needs you** or **finishes**, nsq shows a desktop notification and plays a short
sound. The notification carries the question, e.g. _api-fix needs you — Claude wants to run: npm
test_.

The rules:

- **One notification per agent.** A newer one replaces the old one instead of stacking up.
- **"Needs you" stays on screen** until you answer; "finished" is an ordinary notification.
- **Withdrawn when the agent works again** — a notification asking for an answer you already gave
  would be wrong. (Where the system cannot withdraw notifications, it stays until dismissed.)
- **Sound** plays separately from the notification; `"sound": false` silences it. (The terminal
  bell of the fallback below still rings; `"notifications": false` silences that too.)

The daemon sends notifications even when the dashboard is closed.

## Quiet agents

Some questions never reach a hook: a tool inside a command the agent runs — git asking for a
password, an installer's `Continue? [y/N]`, `sudo`, ssh's host-key question — or a command that
hangs. When a **working** agent's screen has not changed for `quietAfter` minutes (default 5, see
[configuration](configuration.md); a turning spinner or a counting timer does not count as a
change), nsq flags it **quiet** and calls you the same way as for "needs you": the desktop
notification (_api is quiet — No new output for 5 min. Looks like it's asking: Password for
'https://github.com':_), the terminal bell, the phone and the ntfy push — but without answer keys,
since nsq does not know what it waits for. Open the agent to look at its screen. Any new output, a
key you type into it, or the harness reporting progress clears it. Details:
[agent status](../status.md#quiet-while-working).

## Per platform

| Platform      | How                                                                                                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11 | native toasts (no extra install). With Focus assist / Do not disturb they go to the notification centre                                                                                                                                                                                                         |
| macOS         | [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) if installed (`brew install terminal-notifier`) — recommended, it can replace and withdraw; otherwise AppleScript notifications, which appear as **Script Editor** (allow them in System Settings → Notifications) and cannot be withdrawn |
| Linux / BSD   | the desktop's notification service over D-Bus (`gdbus`, or `notify-send`); sound through `paplay`, `pw-play` or `aplay`                                                                                                                                                                                         |

## Over SSH and without a desktop

When no desktop notification can be shown — an SSH session, a server, a container — the dashboard
rings **its terminal** instead: the bell, plus an OSC 9 sequence that terminals such as iTerm2,
WezTerm and Ghostty show as a notification. Over SSH it always does this, since a desktop
notification would show on the remote machine. So keep the dashboard open in a terminal on the machine you sit at, e.g. over
SSH.

For notifications on your phone (a push through ntfy when an agent needs you), see
[Phone](phone.md#push-notifications-optional) — in the dashboard, **Q** → **Notifications** sets it up
and shows a QR code that subscribes the phone.

## Turning it off

In `~/.neurosquad-cli/config.json` ([configuration](configuration.md)):

```json
{ "notifications": false, "sound": false }
```

`"notifications": false` — or `NSQ_NO_NOTIFY=1` in the daemon's environment — turns notifications
off completely: no desktop notification, and the dashboard does not ring its terminal either (no
bell, no OSC 9). The phone still sees which agent needs you ([Phone](phone.md)).
