// A fake coding agent that speaks the herdr status protocol
// (https://herdr.dev/docs/add-herdr-support/), for testing `nsq run -- <cmd>`
// with no real agent behind it.
//
//   node scripts/e2e/fake-herdr-agent.mjs [--mode cli|socket] [--resume <session>] [--env-out <file>]
//
// `cli` reports through "$HERDR_BIN_PATH" pane report-agent … (herdr's
// portable way); `socket` writes the JSON request to $HERDR_SOCKET_PATH itself
// (on Windows, the named pipe herdr serves there). Lines typed into it:
//
//   go     working, then blocked ("Fake wants to run: mkdir out") until…
//   y      working again, then idle with its session id and resume command
//   quit   releases the pane and exits
//
// --env-out writes the four HERDR_* variables it was given (as JSON) to a file.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const option = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const mode = option('mode') ?? 'cli'
const resumed = option('resume')
const envOut = option('env-out')
const SESSION = resumed ?? 'fake-session-1'
const env = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  HERDR_BIN_PATH: process.env.HERDR_BIN_PATH
}
if (envOut) writeFileSync(envOut, JSON.stringify(env))
const inHerdr = env.HERDR_ENV === '1' && env.HERDR_PANE_ID && env.HERDR_SOCKET_PATH
let seq = Date.now() * 1000

const resumeArgv = () => [
  'node',
  fileURLToPath(import.meta.url),
  '--mode',
  mode,
  '--resume',
  SESSION,
  ...(envOut ? ['--env-out', envOut] : [])
]

function viaCli(args) {
  return new Promise((resolve) => {
    const bin = env.HERDR_BIN_PATH
    if (!bin) return resolve(1)
    const child =
      process.platform === 'win32'
        ? spawn(
            'cmd.exe',
            ['/d', '/s', '/c', `"${[bin, ...args].map((a) => `"${a}"`).join(' ')}"`],
            { windowsVerbatimArguments: true, stdio: ['ignore', 'ignore', 'pipe'] }
          )
        : spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('error', () => resolve(1))
    child.on('exit', (code) => {
      if (code) console.log(`fake: report failed (${code}) ${err.trim()}`)
      resolve(code ?? 1)
    })
  })
}

function viaSocket(method, params) {
  return new Promise((resolve) => {
    const address =
      process.platform === 'win32' ? `\\\\.\\pipe\\${env.HERDR_SOCKET_PATH}` : env.HERDR_SOCKET_PATH
    const socket = connect(address)
    let reply = ''
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ id: `fake:${seq}`, method, params })}\n`)
    )
    socket.on('data', (d) => (reply += d))
    socket.on('error', () => resolve(1))
    socket.on('close', () => {
      if (reply.includes('"error"')) console.log(`fake: report refused ${reply.trim()}`)
      resolve(reply.includes('"error"') ? 1 : 0)
    })
  })
}

async function report(state, extra = {}) {
  if (!inHerdr) return
  seq += 1
  if (mode === 'socket') {
    await viaSocket('pane.report_agent', {
      pane_id: env.HERDR_PANE_ID,
      source: 'custom:fake-agent',
      agent: 'fake-agent',
      state,
      seq,
      ...(extra.message ? { message: extra.message } : {}),
      ...(extra.session ? { agent_session_id: extra.session } : {}),
      ...(extra.resume ? { resume_argv: resumeArgv() } : {})
    })
    return
  }
  await viaCli([
    'pane',
    'report-agent',
    env.HERDR_PANE_ID,
    '--source',
    'custom:fake-agent',
    '--agent',
    'fake-agent',
    '--state',
    state,
    '--seq',
    String(seq),
    ...(extra.message ? ['--message', extra.message] : []),
    ...(extra.session ? ['--agent-session-id', extra.session] : []),
    ...(extra.resume ? ['--', ...resumeArgv()] : [])
  ])
}

async function release() {
  if (!inHerdr) return
  seq += 1
  if (mode === 'socket') {
    await viaSocket('pane.release_agent', {
      pane_id: env.HERDR_PANE_ID,
      source: 'custom:fake-agent',
      agent: 'fake-agent',
      seq
    })
    return
  }
  await viaCli([
    'pane',
    'release-agent',
    env.HERDR_PANE_ID,
    '--source',
    'custom:fake-agent',
    '--agent',
    'fake-agent',
    '--seq',
    String(seq)
  ])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let blocked = false

console.log(resumed ? `fake: resumed ${resumed}` : 'fake: ready')
await report('idle', { session: SESSION })

process.stdin.setEncoding('utf8')
process.stdin.on('data', async (data) => {
  for (const line of data
    .split(/\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (line === 'go' && !blocked) {
      console.log('fake: working')
      await report('working', { session: SESSION })
      await sleep(600)
      blocked = true
      console.log('fake: may I run mkdir out? (y)')
      await report('blocked', { message: 'Fake wants to run: mkdir out' })
    } else if (line === 'y' && blocked) {
      blocked = false
      console.log('fake: running mkdir out')
      await report('working', { session: SESSION })
      await sleep(600)
      console.log('fake: done')
      await report('idle', { session: SESSION, resume: true })
    } else if (line === 'quit') {
      await release()
      process.exit(0)
    }
  }
})
