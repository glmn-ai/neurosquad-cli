---
'neurosquad': minor
'@neurosquad/remote': minor
---

`nsq phone on --online`: phone access from anywhere through a Cloudflare quick tunnel (https), an explicit opt-in with a warning, the link and QR printed, `O` in the dashboard to switch it. cloudflared is used from PATH or downloaded once into the nsq home and checked against its published sha256. Through the tunnel, wrong tokens lock an address out (5 → 15 minutes) and plain http is refused; phones that came in from the internet are marked as such. `--expire 12h` makes phones pair again; `nsq phone tunnel-token set` + `--tunnel-token --hostname` use your own named tunnel. `@neurosquad/remote` adds `openTunnelOrigin`, `Lockout`, `ensureCloudflared` and `CloudflareTunnel`.
