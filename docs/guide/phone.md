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

## Online: from anywhere (Cloudflare tunnel)

Away from your Wi-Fi, nsq can make the phone page reachable from the internet through a
[Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
— no account, nothing opened on your router, real HTTPS:

```sh
nsq phone on --online            # prints an https://….trycloudflare.com link and its QR code
nsq phone on --online --expire 12h   # … and phones have to pair again after 12 hours
```

Going online prints a warning, the link with the pairing token and its QR code — scan it with the
phone. **Anyone with this link and token can control your agents**, so treat it like a password.

- **The address changes every time the tunnel starts** — after `nsq phone on --online` again, a
  restart of the daemon or `nsq down`, pair the phone again (`nsq phone pair` prints the current
  link and QR). A quick tunnel is never brought back on its own: going online is explicit, every time.
- **Turn it off** with `nsq phone off` (all phone access), or `nsq phone on` without `--online`
  (back to this machine / the Wi-Fi only). The tunnel also stops with `nsq down`. In the dashboard,
  **O** switches online on and off (with the same warning), and the header shows a red **ONLINE**
  badge while it is.
- **cloudflared** is Cloudflare's connector. If it is on your `PATH`, that one is used. Otherwise,
  the first time, nsq downloads the official release binary from
  [Cloudflare's GitHub releases](https://github.com/cloudflare/cloudflared/releases) into
  `~/.neurosquad-cli/bin` — never system-wide, no install script — and checks it against the sha256
  digest GitHub publishes (and Cloudflare's own checksum list where it covers the file). Without a
  published checksum, or on a mismatch, nothing is run. Delete `~/.neurosquad-cli/bin` to remove it.
- Quick tunnels are a free Cloudflare service for testing, with no uptime guarantee; if Cloudflare
  stops the tunnel, `nsq phone status` and the dashboard say so (it is not restarted silently, since
  a new address would need a new pairing).

### Your own hostname (named tunnel, optional)

With a Cloudflare account you can keep one address: create a tunnel in the Cloudflare dashboard
(Zero Trust → Networks → Tunnels), add a public hostname for it (say `nsq.example.com`) whose
service is `http://127.0.0.1:8767`, and copy its token. Then:

```sh
nsq phone tunnel-token set       # asks for the token (or reads it from stdin) → OS keyring
nsq phone on --online --tunnel-token --hostname nsq.example.com [--tunnel-port 8767]
nsq phone tunnel-token clear
```

The token is kept in the OS keyring (or `NSQ_TUNNEL_TOKEN` in the daemon's environment where there
is none), never on the command line, in `config.json` or the log, and reaches `cloudflared` through
its environment. A named tunnel comes back on its own when the daemon starts, at the same address.
Consider putting [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front of the hostname as a second lock.

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
printf '%s\n%s\n' "$NTFY_TOPIC_URL" "$NTFY_TOKEN" | nsq phone push ntfy --url --token
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
characters, control characters removed). When phone access is online, or on with `--lan`, it also carries a
link to the phone page — the online https address when online, else this computer's local network
address and port, never the token — so tapping the notification opens the page. Nothing else from the terminal is sent. Pushes only go out
for "needs you", not for "finished". A push is skipped only when it repeats the question that was
last pushed successfully for the same agent, within 30 seconds and with no answer in between; a
different question is pushed right away. Push works whether or not `nsq phone on` is set.

## Security

- **Off by default**, and loopback-only unless you pass `--lan` (or `--online`, below).
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

### Online

- **Opt-in, every time** (`--online`, or **O** with a confirmation in the dashboard), with a warning
  line wherever the link is shown. Online, anyone on the internet can _reach_ the page; the pairing
  token is still what lets them _in_.
- **HTTPS only.** The tunnel forwards to a separate listener on `127.0.0.1` that only `cloudflared`
  uses; a request that reached Cloudflare over plain http is refused there. TLS ends at Cloudflare:
  their edge carries the traffic, the token included.
- **Brute force:** besides the per-minute throttle, 5 wrong tokens from one internet address lock
  that address out for 15 minutes (the real client address comes from Cloudflare's
  `CF-Connecting-IP`, which is believed only on the tunnel's own listener — anywhere else it is just
  a header a client chose). Guessing 24 random bytes is out of reach anyway; this keeps the log and
  the daemon quiet.
- **Who is connected** is always shown — phones that came through the tunnel are marked
  `(internet)` in `nsq phone status`, the dashboard header and **p**.
- **Re-pairing:** `--expire 12h` (or `2d`) replaces the pairing token once it is that old, signing
  every phone out; `--expire off` turns that off. `nsq phone rotate` does it at once.
- The capabilities are the same as on the Wi-Fi (above): no starting agents, no raw keys, no files,
  no settings.

The design and its trade-offs: [docs/remote-proposal.md](../remote-proposal.md).

## Account

Phone access works without an account. `nsq login` signs in to an optional NeuroSquad account
(tokens in the OS keyring); nothing in nsq 0.1.0 requires it.
