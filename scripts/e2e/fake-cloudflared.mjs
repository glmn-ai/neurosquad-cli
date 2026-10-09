// A stand-in for `cloudflared tunnel --url http://127.0.0.1:<port>` in tests (NSQ_CLOUDFLARED).
//
// It does what the real connector looks like from nsq's side: prints a quick-tunnel address on
// stderr and forwards HTTP to the origin, adding the headers Cloudflare's edge adds
// (CF-Connecting-IP, X-Forwarded-Proto, CF-Visitor). Instead of the internet it listens on a
// loopback port and writes { port, pid, argv } to `fake-cloudflared.state.json` next to itself.
// A test picks the visitor's address with `x-fake-client-ip` and plain http with
// `x-fake-proto: http`. Nothing leaves the machine.
import { writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const origin = argv[argv.indexOf('--url') + 1]
if (!argv.includes('--url') || !origin?.startsWith('http://127.0.0.1:')) {
  console.error('ERR fake-cloudflared: only quick tunnels to 127.0.0.1 are faked')
  process.exit(2)
}
const target = new URL(origin)

const server = createServer((req, res) => {
  const headers = { ...req.headers }
  const client = String(req.headers['x-fake-client-ip'] ?? '198.51.100.1')
  const proto = String(req.headers['x-fake-proto'] ?? 'https')
  delete headers['x-fake-client-ip']
  delete headers['x-fake-proto']
  headers['cf-connecting-ip'] = client
  headers['x-forwarded-proto'] = proto
  headers['cf-visitor'] = JSON.stringify({ scheme: proto })
  const upstream = request(
    { host: target.hostname, port: target.port, path: req.url, method: req.method, headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    }
  )
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(upstream)
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  const state = join(dirname(fileURLToPath(import.meta.url)), 'fake-cloudflared.state.json')
  writeFileSync(state, JSON.stringify({ port, pid: process.pid, argv }))
  console.error('INF Requesting new quick Tunnel on https://api.trycloudflare.com...')
  console.error(
    'INF +--------------------------------------------------------------------------------------------+'
  )
  console.error(
    'INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |'
  )
  console.error(
    'INF |  https://fake-e2e-tunnel.trycloudflare.com                                                 |'
  )
  console.error(
    'INF +--------------------------------------------------------------------------------------------+'
  )
})
