# Phone (experimental)

> **Experimental in 0.1.0.** Phone access is the newest part of nsq; its page and commands may
> change in the next releases.

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

The page updates while it is open; nsq 0.1.0 sends no push notifications to the phone.

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
