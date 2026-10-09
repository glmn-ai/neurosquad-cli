# Phone access for nsq — findings and proposal

Phase 2 of the CLI design: "answer your agents from your phone", behind an optional `nsq login`.
This document records what the **existing public NeuroSquad cloud contract** allows, what
`@neurosquad/remote` therefore implements today, and what needs work elsewhere (a phone UI, a
relay, push) — as options with a security model and effort. No server code was changed.

## 1. Findings

### What the public cloud API offers

The contract (`/api/v1`, documented in the NeuroSquad repo as `docs/cloud/api.md`) has:

- device sign-in (`/device/start`, `/device/poll`; approval on the web panel), rotating refresh
  tokens bound to an install (`/auth/refresh`, `/auth/revoke`), the profile (`/me`), the list of
  signed-in devices;
- telemetry counters, the feedback board, the templates marketplace.

It has **no** relay, **no** push-notification endpoints, **no** phone pairing and nothing that
carries agent state. Signing in works for a CLI exactly as for the desktop (the device flow is not
desktop-specific), and that is implemented (§2). Everything about phones is local today.

### How the desktop app's phone access works

Entirely without the cloud:

1. A plain `node:http` server on the LAN (`0.0.0.0:8765`, off by default), guarded by a 24-byte
   pairing token (constant-time compare, failure throttle, write rate limit, body caps). Pairing =
   scanning a QR of `http://<lan-ip>:8765/?t=<token>`; "Regenerate" revokes.
2. It serves two phone clients **from its own bundle**: the full desktop renderer over a WebSocket
   (`/`, IPC channel names with a BLOCKED list of desktop-only channels) and a lightweight client
   (`/lite`) over a small JSON + SSE API: `/api/state`, `/api/workspace/:id`,
   `/api/agent/:id/screen`, `/api/agent/:id/prompt`, `/api/events` (SSE), `/api/poll` (long-poll),
   plus card/workspace creation.
3. From outside the LAN: an optional Cloudflare tunnel (`cloudflared`, quick or named). TLS ends at
   Cloudflare; quick tunnels do not carry SSE, hence the long-poll endpoint.
4. Notifications: only while the page is open (sound, badge, in-page list). Real Web Push is
   impossible on a plain-HTTP LAN origin: iOS needs a home-screen PWA **and** a secure context
   **and** a service worker; none of that exists on `http://192.168.x.x`. On an HTTPS origin (a
   tunnel) the page's `Notification` works while it is open; there is no background push at all.

### Can the existing phone client talk to nsq?

- **Wire format: yes, for the lightweight client.** `PhoneServer` answers the same routes with the
  same shapes (`state`, `workspace`, `screen`, `prompt`, SSE and long-poll events, `kinds`), so a
  client written against the desktop's lite API reads nsq's agents and sends prompts unchanged.
- **Delivery: no.** That client is part of the closed desktop app, served by the desktop itself
  (same origin, relative `/api/...` URLs, token from `?t=`). nsq is MIT and cannot ship it. Hosting
  it elsewhere does not help: an HTTPS page (say on `app.neurosquad.ai`) may not fetch
  `http://192.168.x.x` (mixed content; Chrome's Private Network Access), and the server would need
  CORS, which it deliberately does not send.
- The full-app client (`/`) speaks the desktop's IPC channel names over a WebSocket — renderer
  shaped, not applicable to nsq.

So a phone needs **a UI we can ship** (option A or B) and, for "needs you" while the phone is in a
pocket, **push** (option D or E).

## 2. Implemented now (`packages/remote`)

- **Cloud sign-in** (`CloudSession`): device code, tokens only in the OS keyring
  (`@napi-rs/keyring`; one entry per API origin; no file fallback), single-flight refresh, only the
  cloud's 401 ends a session (network/5xx/429/proxy 403 = offline, 7-day grace), logout clears
  locally first then revokes. Tested against an MIT fake cloud (`@neurosquad/remote/testing`).
- **Phone API** (`PhoneServer` + the `PhoneHost` port the daemon implements): the desktop-compatible
  lite routes above plus `POST /api/agent/:id/answer` (`yes|always|no` → the harness's keys, mapped
  by the host), `POST /api/agent/:id/interrupt` (the harness's own interrupt key) and
  `GET /api/capabilities`. Loopback by default; LAN only when the host passes an address.
- Pairing helpers: `generatePairingToken`, `lanAddresses`, `pairingUrl` (the QR payload).

What the lead wires in `apps/cli`: `nsq login|logout|whoami`, `nsq phone on|off|pair|rotate`
(QR rendering, persisting the token in the CLI config with mode 0600), a `PhoneHost` over the
daemon (`listAgents` ← records + runtime status/detail, `screen` ← screen mirror, `submit` /
`answer` / `interrupt` ← the existing daemon messages, `subscribe` ← status/attention events).

## 3. Security model of the phone API

| A paired phone CAN                                  | Route                              |
| --------------------------------------------------- | ---------------------------------- |
| see agents, status, the pending question            | `GET /api/state`, `/workspace/:id` |
| read an agent's terminal mirror (text, ≤ 600 lines) | `GET /api/agent/:id/screen`        |
| follow status and needs-you events                  | `GET /api/events`, `/api/poll`     |
| send a prompt (≤ 4000 chars) to a running agent     | `POST /api/agent/:id/prompt`       |
| answer a permission prompt: yes / always / no       | `POST /api/agent/:id/answer`       |
| interrupt the current turn                          | `POST /api/agent/:id/interrupt`    |

| A paired phone CANNOT (the BLOCKED-equivalent)                                    |
| --------------------------------------------------------------------------------- |
| start agents or choose a command; create workspaces or probe paths (answered 403) |
| send raw bytes/keys to a pty (no such route — a shell is one keystroke away)      |
| stop/remove agents, delete worktrees, change permission mode, harness or model    |
| browse, read or download files                                                    |
| reach the cloud session or any token; re-key or switch off the phone server       |

Guards: one pairing token per pairing (24 random bytes, rotate = revoke, drops open streams and
held polls at once); on every `/api/**` request including the event stream; `timingSafeEqual` with
a length-safe dummy compare; 20 wrong tokens/min per address → 429; 40 writes/min per address;
64 KiB bodies; no CORS; `Referrer-Policy: no-referrer` (the token rides in `?t=` for EventSource);
`Cache-Control: no-store`; unexpected host errors answered as a generic 500. The token is never
logged; the pairing link is shown only on explicit request. Plain HTTP leaks the token to anyone
sniffing the Wi-Fi — the same trade-off the desktop documents; options C/D fix it.

## 4. Options for the rest

### A. A minimal phone page in this repo (no server work) — recommended next

`PhoneServer` serves one static, MIT, dependency-free page at `/` (vanilla TS → one JS file, ~1–1.5k
LOC): agent list with status and question, tap → screen mirror + composer, three answer buttons,
Stop; long-poll fallback built in; strict CSP (`default-src 'self'`), token kept in `localStorage`
and stripped from the URL. Alerts only while open (sound, vibration, title badge).
**Effort: 3–5 days** incl. tests (Playwright mobile emulation in CI).

### B. Re-license the desktop's lite client

The desktop's lightweight phone client (~2.1k LOC, React + HeroUI + i18next) already speaks this API. Moving it to
MIT is an owner decision; adapting it to a standalone Vite build served by nsq: **~2 days**. Heavier
than A (React + HeroUI in the CLI package) but i18n and polish for free.

### C. Reach from outside the LAN (no server work) — implemented

`nsq phone on --online` (docs/guide/phone.md, "Online"): a quick tunnel (or the person's named
one), cloudflared from PATH or downloaded once with its sha256 verified, a separate loopback
listener for the tunnel with a per-address lockout and HTTPS-only.

The download is not pinned to one release: the latest release's asset is checked against the
sha256 digest GitHub publishes for it (and Cloudflare's checksum list in the release notes for
plain binaries) and refused without one or on a mismatch. A `cloudflared` on PATH is used as is.
Quick tunnels get an empty `--config` (to dodge `~/.cloudflared/config.yaml`) and the phone page
long-polls, because quick tunnels drop SSE. Tailscale / `ssh -R` remain an alternative for people
who already have them.

### D. Cloud relay + push (server work on the NeuroSquad cloud, additive under `/api/v1`)

What it takes for "the phone buzzes in a pocket" and for answering without being on the same
network:

- **Phone app**: a PWA on a secure origin we control (e.g. `app.neurosquad.ai/phone`), installable
  (iOS 16.4+ Web Push needs the home-screen install), with a service worker.
- **Pairing**: `nsq phone pair --cloud` shows a QR with a pairing id and an X25519 public key; the
  PWA (signed in to the same account) answers with its key → per-pairing symmetric key. The server
  stores only the pairing id, the account and the Web Push subscription.
- **Endpoints** (Bearer for the CLI, cookie + CSRF for the PWA):
  `POST /phone/pairings` (create, returns id), `DELETE /phone/pairings/:id` (revoke, also listed on
  the devices page), `PUT /phone/pairings/:id/subscription` (PWA's Web Push subscription),
  `POST /phone/pairings/:id/notify` (CLI → Web Push; body is **ciphertext**), and
  `GET /phone/pairings/:id/relay` (WebSocket; both sides connect outbound, the server forwards
  opaque frames, never parses them).
- **Content rule**: the cloud's rule is "never content". A notification that says _what_ the agent
  asks ("Allow Bash: npm test?") is content, so payloads are end-to-end encrypted (AEAD with the
  pairing key, sequence numbers against replay); the server sees sizes and timing only. A
  no-content mode ("api-fix needs you") works without encryption.
- **Authority stays on the machine**: the relay carries the same capability set as §3; nsq enforces
  it; the server cannot inject because it cannot encrypt.
- **Limits**: per-account rate limits on notify and relay bandwidth, VAPID keys server-side,
  subscriptions expire and are dropped on 404/410 from the push service.
- **Effort**: server ~1–1.5 weeks (Web Push, pairing storage, revoke, relay, limits, tests), PWA
  ~1 week (or A's page reused as the PWA), CLI ~3 days. Native APNs/FCM apps: not proposed.

### E. Third-party push, opt-in (no server work)

`nsq notify --via ntfy|pushover|telegram` sends "needs you / finished" to a service the user already
has (self-hosted ntfy recommended). Off by default; question text only with an explicit flag, since
it leaves for a third party. **Effort: 1–2 days.** The fastest way to a pocket buzz.

## 5. Recommendation

1. Merge this package; wire `nsq login` and `nsq phone` in `apps/cli`.
2. Next, no server work: **A** (minimal page) + **E** (opt-in push) — the phone loop is usable on the
   LAN with a buzz from ntfy/Telegram; **C** for away-from-home.
3. **D** when the owner approves server work: it is the only path to private, first-party push and
   answering from anywhere, and it must stay additive to the contract.
