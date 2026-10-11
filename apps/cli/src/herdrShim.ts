// HERDR_BIN_PATH inside a plain command started by nsq: the three reporting
// subcommands of herdr's CLI (`pane report-agent`, `pane report-agent-session`,
// `pane release-agent`), sent to the nsq daemon's herdr socket. Small on
// purpose — agents call it on every state change. herdr: https://herdr.dev
import {
  HERDR_SOCKET_PATH,
  herdrCliReply,
  parseHerdrCli,
  sendHerdrRequest
} from '@neurosquad/core/herdr'

async function main(): Promise<number> {
  const parsed = parseHerdrCli(process.argv.slice(2))
  if ('exit' in parsed) {
    if (parsed.stdout) process.stdout.write(parsed.stdout)
    if (parsed.stderr) process.stderr.write(parsed.stderr)
    return parsed.exit
  }
  const socketPath = process.env[HERDR_SOCKET_PATH]
  if (!socketPath) {
    process.stderr.write(`${HERDR_SOCKET_PATH} is not set: not inside an nsq agent\n`)
    return 1
  }
  try {
    const reply = await sendHerdrRequest(socketPath, parsed.request, { timeoutMs: 3000 })
    const result = herdrCliReply(reply)
    if (result.stderr) process.stderr.write(result.stderr)
    return result.exit
  } catch (error) {
    process.stderr.write(`nsq is not reachable: ${String((error as Error).message ?? error)}\n`)
    return 1
  }
}

process.exitCode = await main()
