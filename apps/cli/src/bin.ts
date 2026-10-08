// nsq — the entry point.
import { parseArgs } from './args.js'
import {
  UsageError,
  cmdAnswer,
  cmdAttach,
  cmdCost,
  cmdDiff,
  cmdDoctor,
  cmdDown,
  cmdLs,
  cmdOpenRouter,
  cmdPeek,
  cmdRm,
  cmdRun,
  cmdSend,
  cmdSet,
  cmdSimple,
  cmdUp
} from './commands.js'
import { VERSION } from './version.js'

const HELP = `nsq ${VERSION} — run several AI coding agents and get called when one needs you

  nsq                                   the dashboard (starts the daemon)
  nsq run <claude|codex|opencode> [prompt]
        [--name n] [--worktree] [--model id] [--provider openrouter] [--dangerous] [--attach]
  nsq run [--name n] -- <command…>      any command
  nsq ls [--json]                       agents and their status
  nsq attach <agent>                    full-screen terminal (Ctrl+] to detach)
  nsq send <agent> "prompt" [--when-done]
  nsq answer <agent> yes|always|no      answer a permission prompt
  nsq interrupt|stop|start|restart <agent>
  nsq rm <agent> [--worktree]           remove (and delete its worktree)
  nsq set <agent> [--dangerous on|off] [--model id|none] [--provider openrouter|none]
  nsq diff <agent>                      git diff of the agent's folder
  nsq peek <agent> [-n 20]              the last lines of its screen
  nsq cost [--since 7d] [--json]        what each agent spent
  nsq openrouter set-key|clear-key|models [query]|status
  nsq up | down                         start / stop the daemon (and its agents)
  nsq doctor                            check harnesses, hooks, terminal
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  switch (command) {
    case undefined:
    case 'ui':
    case 'dashboard': {
      // The dashboard arrives with the TUI; until then, the agent list.
      await cmdLs(args)
      return 0
    }
    case 'daemon': {
      const { runDaemon } = await import('./daemon/daemon.js')
      await runDaemon()
      return -1
    }
    case 'run':
      await cmdRun(args)
      return 0
    case 'ls':
    case 'list':
      await cmdLs(args)
      return 0
    case 'attach':
    case 'a':
      await cmdAttach(args)
      return 0
    case 'send':
      await cmdSend(args)
      return 0
    case 'answer':
      await cmdAnswer(args)
      return 0
    case 'stop':
    case 'start':
    case 'restart':
    case 'interrupt':
      await cmdSimple(command, args)
      return 0
    case 'rm':
    case 'remove':
      await cmdRm(args)
      return 0
    case 'set':
      await cmdSet(args)
      return 0
    case 'diff':
      await cmdDiff(args)
      return 0
    case 'peek':
      await cmdPeek(args)
      return 0
    case 'cost':
      await cmdCost(args)
      return 0
    case 'openrouter':
      await cmdOpenRouter(args)
      return 0
    case '_input': {
      const { cmdRawInput } = await import('./commands.js')
      await cmdRawInput(args)
      return 0
    }
    case 'up':
      await cmdUp()
      return 0
    case 'down':
      await cmdDown()
      return 0
    case 'doctor':
      await cmdDoctor()
      return 0
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`)
      return 0
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return 0
    default:
      process.stderr.write(`nsq: unknown command "${command}"\n\n${HELP}`)
      return 2
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`nsq: ${message}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
)
