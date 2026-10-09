# Phone (experimental)

> **Experimental.** Phone access is the newest part of nsq; its page, commands and push options
> may change in the next releases.

From a phone you can see the agents, read their screens, send a prompt, answer a permission prompt
and interrupt a turn.

## Turn it on and pair

```sh
nsq phone on --lan       # listen on the local network (default port 8766; --port n to change)
nsq phone pair           # prints the pairing link and a QR code
```

Scan the QR code with the phone's camera and open the link: a mobile page lists your agents with
their status and pending question. Tap an agent to read its screen, type a prompt, answer
**yes / always / no**, or stop the current turn. A prompt sent to a busy agent is delivered when its
turn ends.

The phone has to reach your computer: the same Wi-Fi, or a network you already have between them
(a VPN such as Tailscale, an SSH tunnel). Without `--lan`, nsq listens on this machine only. The
choice and the port are remembered: after one `nsq phone on --lan`, a plain `nsq phone on` stays
on the network; `nsq phone on --lan=off` goes back to this machine only.

```sh
nsq phone status         # on/off, address, which phones are connected
nsq phone rotate         # new pairing token: every paired phone is signed out
nsq phone off
```

In the dashboard, **p** shows the connected phones — who is connected is always visible.

## Push notifications (optional)

The phone page only shows updates while it is open. To get a notification on the phone when an
agent needs you, nsq can push through [ntfy](https://ntfy.sh), either the public ntfy.sh server or
your own. Push is off by default.

```sh
nsq phone push ntfy                  # a new random topic on ntfy.sh
nsq phone push ntfy --url            # your own server or topic: asks for the topic URL
nsq phone push ntfy --url --token    # … and an access token
nsq phone push test                  # send a test notification
nsq phone push show                  # print the topic URL
nsq phone push status                # on/off, which server (also plain `nsq phone push`)
nsq phone push off
```

`nsq phone push ntfy` prints the topic URL; subscribe to it in the ntfy app. Anyone who knows the
topic URL can read it, so treat it like a password. That is why the URL and the token never go on
the command line (process list, shell history): `--url` and `--token` take no value — nsq asks for
them without echoing what you type, or reads them from stdin, one per line, in that order:

```sh
printf '%s
%s
' "$NTFY_TOPIC_URL" "$NTFY_TOKEN" | nsq phone push ntfy --url --token
```

The URL and the optional access token are kept in the OS keyring, not in `config.json` or the log
(where there is no keyring, set `NSQ_NTFY_URL` and `NSQ_NTFY_TOKEN` in the daemon's environment).
The URL must be https; plain http is accepted only for this machine or a local network address,
and an access token is sent only over https (or plain http to this machine). Over plain http on
the local network, anyone who can watch that network can read the agent's name and question — use
https for anything sensitive. The URL takes no
`user:password`, `?query` or `#fragment` — give a token with `--token` instead. `nsq phone push off`
stores "off" in the keyring, so push stays off even when `NSQ_NTFY_URL` is set. Without an OS
keyring, `off` cannot be stored: remove `NSQ_NTFY_URL` (and `NSQ_NTFY_TOKEN`) from the environment
where the daemon starts, then `nsq down` / `nsq up`.

What a push contains: the title `<agent> needs you` and the agent's question (cut to 300
characters, control characters removed). When phone access is on with `--lan`, it also carries a
link to the phone page — this computer's local network address and port, without the token — so
tapping the notification opens the page. Nothing else from the terminal is sent. Pushes only go out
for "needs you", not for "finished". A push is skipped only when it repeats the question that was
last pushed successfully for the same agent, within 30 seconds and with no answer in between; a
different question is pushed right away. Push works whether or not `nsq phone on` is set.

## Security

- **Off by default**, and loopback-only unless you pass `--lan`.
- **The link is a password.** It carries the pairing token (24 random bytes in `~/.neurosquad-cli/phone-token`,
  readable only by you on macOS/Linux, shown only by `nsq phone pair`). Anyone with the link on your network can do what a
  phone can. `nsq phone rotate` revokes it at once.
- **A phone can do little on purpose.** It can read agents and screens, send prompts, answer and
  interrupt. It **cannot** start agents or commands, send raw keys to a terminal, stop or remove
  agents, change dangerous mode, models or settings, read files, or switch phone access off.
- Every request is checked against the token in constant time; repeated wrong tokens and floods are
  rate-limited; no cross-origin access.
- The connection is plain HTTP on your local network, so someone sniffing that Wi-Fi could see the
  token — use it on networks you trust, or over a VPN.

The design and its trade-offs: [docs/remote-proposal.md](../remote-proposal.md).

## Account

Phone access works without an account. `nsq login` signs in to an optional NeuroSquad account
(tokens in the OS keyring); nothing in nsq 0.1.0 requires it.
