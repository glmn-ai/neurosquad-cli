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
`answer`, `interrupt` and `capabilities` are additions. No phone UI is served — see
[docs/remote-proposal.md](../../docs/remote-proposal.md) for why, and for push notifications.

Security: 24-byte token on every request (constant-time compare, also on the event stream),
throttled wrong tokens and writes per address, 64 KiB bodies, 4000-char prompts, loopback bind by
default, no CORS, `no-referrer` / `no-store`, host errors answered generically, an allowlist of
routes (`PHONE_CAPABILITIES`) and a documented `PHONE_BLOCKED` list.

## Testing

`@neurosquad/remote/testing` exports `startFakeCloud()` (device flow, rotation with the lost-answer
window, family revocation, revoke, `/me`, outage and failure switches) and `FakePhoneHost`. Tests
never talk to the real cloud.
