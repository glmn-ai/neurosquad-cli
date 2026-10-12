// A stand-in Claude Code for the "quiet while working" e2e (apps/cli/src/quiet.e2e.test.ts and
// scripts/e2e-ci/quiet.mjs): it starts a turn through its real hook endpoint (UserPromptSubmit,
// as Claude Code does), prints a little, then runs a stand-in `git push` whose credential prompt
// waits on the terminal — a question no hook reports. While it waits, a Claude-like spinner line
// keeps turning (glyph, verb, a counting timer), which must not count as output. Once `git` got
// its line, the turn ends (Stop) and the agent sits idle.
//
// QUIET_AGENT_ASK=1: before the turn ends it asks permission for one more command, as Claude Code
// does (PermissionRequest + Notification permission_prompt, its 1/2/3 dialog); a key answers it
// (PostToolUse), then the turn ends (Stop).
//
//   node scripts/e2e/quiet-agent.mjs --settings <file> …     (as nsq launches `claude`)
//   node scripts/e2e/quiet-agent.mjs git                     (the stand-in git, run by the above)
//
// NSQ_TEST_PIDS: a file each process appends its pid to (the test kills them afterwards).
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (process.env.NSQ_TEST_PIDS) appendFileSync(process.env.NSQ_TEST_PIDS, `${process.pid}\n`)
const out = (text) => process.stdout.write(text)

if (args[0] === 'git') {
  // git's credential prompt: the question on the last line, the cursor after it, one line read.
  out('Enumerating objects: 5, done.\r\n')
  out("Password for 'https://me@git.example.com': ")
  let line = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    line += chunk
    if (/[\r\n]/.test(line)) {
      out('\r\nTo https://git.example.com/me/shop.git\r\n   1a2b3c4..5d6e7f8  main -> main\r\n')
      process.exit(0)
    }
  })
} else {
  const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'))
  const base = settings.hooks.PermissionRequest[0].hooks[0].url.replace(/\/ClaudePermission$/, '')
  const post = (event, body) =>
    fetch(`${base}/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => {})

  out('\x1b[2J\x1b[H> push the cart fix\r\n\r\n')
  await post('UserPromptSubmit', { prompt: 'push the cart fix' })
  out('⏺ I will push the branch now.\r\n\r\n')
  out('⏺ Bash(git push)\r\n')
  // The spinner on its own row (row 7), drawn with save/restore so the prompt below keeps the
  // cursor — as Claude Code's live region turns while a tool runs.
  const SPIN = ['✻', '✽', '✶', '✳', '✢', '·']
  const VERBS = ['Pushing', 'Waiting', 'Pushing']
  const started = Date.now()
  let tick = 0
  const spin = setInterval(() => {
    tick += 1
    const s = Math.floor((Date.now() - started) / 1000)
    out(
      `\x1b7\x1b[7;1H\x1b[2K${SPIN[tick % SPIN.length]} ${VERBS[tick % VERBS.length]}… (${s}s · esc to interrupt)\x1b8`
    )
  }, 120)
  out('\r\n\r\n\r\n')
  const git = spawn(process.execPath, [fileURLToPath(import.meta.url), 'git'], {
    stdio: 'inherit',
    env: process.env
  })
  git.on('exit', async () => {
    clearInterval(spin)
    out('\x1b7\x1b[7;1H\x1b[2K\x1b8')
    out('\r\n⏺ Pushed.\r\n')
    if (process.env.QUIET_AGENT_ASK === '1') {
      const command = 'gh pr create --fill'
      out(`\r\n⏺ Bash(${command})\r\n`)
      await post('ClaudePermission', { tool_name: 'Bash', tool_input: { command } })
      await post('Notification', {
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash'
      })
      out(" Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don't ask again\r\n   3. No\r\n")
      // One key, as Claude Code's dialog takes it: raw, no Enter.
      if (process.stdin.isTTY) process.stdin.setRawMode(true)
      process.stdin.setEncoding('utf8')
      await new Promise((answered) => process.stdin.once('data', answered))
      process.stdin.pause()
      out('\r\n  https://git.example.com/me/shop/pull/7\r\n')
      await post('PostToolUse', { tool_name: 'Bash' })
    }
    await post('Stop', {})
    setInterval(() => {}, 60_000)
  })
}
