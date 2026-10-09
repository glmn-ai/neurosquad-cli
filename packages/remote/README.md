# @neurosquad/remote

The optional, account-backed and phone-facing parts of [`nsq`](../../README.md). Nothing here is
needed to run agents; a host (the `nsq` CLI / daemon) wires it into commands.

Node.js ≥ 22.13. No telemetry of any kind: this package sends nothing anywhere unless the host
calls it, and the only remote it ever talks to is the NeuroSquad API origin the host configured.

## Cloud sign-in (`nsq login` / `nsq logout` / `nsq whoami`)

Device-code sign-in against the public NeuroSquad API (`/api/v1/device/*`, `/auth/refresh`,
`/auth/revoke`, `/me`) — the same flow the desktop app uses.

```ts
import {
  CloudHttp,
  CloudSession,
  FileSessionStore,
  KeyringVault,
  resolveCloudOrigins
} from '@neurosquad/remote'

const origins = resolveCloudOrigins() // production, or NSQ_CLOUD_URL (https / loopback http only)
const session = new CloudSession({
  http: new CloudHttp(origins.api, origins.web, fetch, `nsq/${version}`),
  vault: new KeyringVault(), // OS keyring via @napi-rs/keyring, loaded on first use
  store: new FileSessionStore(join(home, '.neurosquad-cli', 'cloud.json')), // no secrets
  device: { deviceName: hostname(), platform: process.platform, appVersion: version }
})

await session.login({
  onCode: ({ userCode, verifyUrl }) => {
    /* print the code, open verifyUrl */
  },
  signal // Ctrl+C
})
await session.verify() // { state: 'signed-in', user, plan, offline? } | { state: 'signed-out', reason }
await session.authorized({ method: 'GET', path: '/me' }) // Bearer call with refresh + retry
await session.logout()
```

| Rule                                     | How                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens only in the OS keyring            | `KeyringVault`: one entry per API origin (`service = neurosquad-cli`; on Linux the Secret Service only, never the non-persistent kernel keyring). No file fallback — without a keyring `login` fails with `KeyringUnavailableError` and nothing is left half signed in. |
| Refresh is single-flight                 | rotating refresh tokens; reuse would revoke the family                                                                                                                                                                                                                  |
| Network / 5xx / 429 / proxy 403 ≠ logout | a session ends only on the cloud's `401`: to a refresh, or to the one retry made with a freshly refreshed token; offline grace of 7 days, then `grace-expired` (tokens kept, `verify()` restores)                                                                       |
| Logout clears                            | local record and keyring entry first, then a best-effort server revoke (rotating once if the access token expired)                                                                                                                                                      |
| Tokens never printed                     | not in errors, logs or the session file; `CloudHttp` refuses redirects                                                                                                                                                                                                  |

## Phone API

`PhoneServer` — a token-guarded HTTP server: a paired phone sees each agent's status and pending
question, reads the terminal mirror, sends a prompt, answers a permission prompt (`yes` / `always` /
`no`) and interrupts. Nothing else. The host implements `PhoneHost` (list, screen, submit, answer,
interrupt, events).

```ts
const server = new PhoneServer({
  host,
  token: generatePairingToken(),
  bindAddress: lanAddresses()[0]
})
const { address, port } = await server.start()
const link = pairingUrl({ address, port }, token) // the credential: show it as a QR on request only
server.rotateToken(generatePairingToken()) // revoke
```

The routes and shapes (`/api/state`, `/api/workspace/:id`, `/api/agent/:id/screen|prompt`,
`/api/events` SSE, `/api/poll` long-poll) match the NeuroSquad desktop's lightweight phone API;
`answer`, `interrupt` and `capabilities` are additions. `connections()` lists who is connected
(address, a short device label, since) for the host to show.

### Online (a Cloudflare tunnel)

`server.openTunnelOrigin(port?)` opens a second listener on `127.0.0.1` for a tunnel connector to
forward to; every request on it counts as coming from the internet: the client address is
Cloudflare's `CF-Connecting-IP` (believed only there), plain http is refused, wrong tokens lock an
address out (`Lockout`: 5 within 15 minutes → 15 minutes, `onlineLockout` to change), and
`connections()` marks those clients `via: 'internet'`. `closeTunnelOrigin()` cuts them off.

`ensureCloudflared({ binDir })` returns a `cloudflared` from `binDir`, else from `PATH`, else
downloads the latest official release into `binDir`, verified against GitHub's sha256 digest (and
Cloudflare's checksum list when it covers the file); `CloudflareTunnel` runs it
(`tunnel --no-autoupdate --config <empty> --url http://127.0.0.1:<port>` for a quick tunnel, or
`tunnel run` with `TUNNEL_TOKEN` in a trimmed environment for a named one) and reports the https
address (`parseQuickTunnelUrl`).

```ts
const binary = await ensureCloudflared({ binDir })
const origin = await server.openTunnelOrigin()
const tunnel = new CloudflareTunnel()
const { state, url } = await tunnel.start({
  binary: binary.path,
  origin: `http://127.0.0.1:${origin}`,
  mode: 'quick',
  stateDir
})
// pairingUrl(url, token) is the link for the phone; tunnel.stop() closes it
```

### The phone page

The server also serves a small client for these routes at `/` (`src/phone/web/`, plain HTML, CSS
and JavaScript, MIT, no build step, no third-party code; `page: false` leaves it out): the agents
with their status, the pending question with Yes / Always / No, one agent's screen (text, refreshed
while it is open and the page is visible), a prompt box and a two-tap interrupt. It opens from the
pairing link (`/?t=<token>`), keeps the token in the page's `localStorage` and takes it out of the
address bar and history. It loads only from its own origin under a strict Content-Security-Policy
(no inline script or style, no eval, no frames), and puts every value from the server into the page
as text. The page holds no data until the token is presented. Installable to the home screen
(web app manifest); it uses the long-poll route, which works through proxies that buffer event
streams.

Security: 24-byte token on every API request (constant-time compare, also on the event stream),
throttled wrong tokens and writes per address, 64 KiB bodies, 4000-char prompts, loopback bind by
default, no CORS, `no-referrer` / `no-store`, host errors answered generically, an allowlist of
routes (`PHONE_CAPABILITIES`) and a documented `PHONE_BLOCKED` list.

## Testing

`@neurosquad/remote/testing` exports `startFakeCloud()` (device flow, rotation with the lost-answer
window, family revocation, revoke, `/me`, outage and failure switches) and `FakePhoneHost`. Tests
never talk to the real cloud.
