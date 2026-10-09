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
        [--name n] [--worktree] [--model id] [--provider name|openrouter]
        [--dangerous] [--attach]
  nsq run [--name n] -- <command…>      any command
  nsq ls [--json]                       agents and their status
  nsq attach <agent>                    full-screen terminal (Ctrl+] to detach)
  nsq send <agent> "prompt" [--when-done]
  nsq answer <agent> yes|always|no      answer a permission prompt
  nsq interrupt|stop|start|restart <agent>
  nsq rm <agent> [--worktree]           remove (and delete its worktree)
  nsq set <agent> [--dangerous on|off] [--model id|none]
        [--provider name|openrouter|none]
  nsq diff <agent>                      git diff of the agent's folder
  nsq peek <agent> [-n 20]              the last lines of its screen
  nsq cost [--since 7d] [--json]        what each agent spent
  nsq openrouter set-key|clear-key|models [query]|status
  nsq provider add <name> --url <base> [--key-stdin|--ask-key]
                                        your own server: llama.cpp, Ollama, LM Studio,
                                        vLLM, SGLang, Unsloth Studio, any compatible API
  nsq provider test|models|remove <name> · nsq provider list
  nsq phone on [--lan]|off|pair|rotate|status   answer agents from a phone
  nsq phone on --online [--expire 12h]  from anywhere, through a Cloudflare tunnel (https)
  nsq phone tunnel-token set|clear      your own named tunnel (--online --tunnel-token --hostname h)
  nsq phone push ntfy [--url] [--token]|off|test|show|status
                                        push "needs you" to the phone
  nsq login | logout | whoami           the optional NeuroSquad account
  nsq dictation setup|status|test <wav> [--model id]
  nsq up | down                         start / stop the daemon (and its agents)
  nsq update [--check]                  install the newest release now (or only check)
  nsq config [get|set|unset <key> [value]]   settings (e.g. autoUpdate true|notify|false)
  nsq doctor                            check harnesses, hooks, terminal, updates
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  switch (command) {
    case undefined:
    case 'ui':
    case 'dashboard': {
      const { runDashboard } = await import('./tui/app.js')
      await runDashboard()
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
    case 'provider':
    case 'providers': {
      const { cmdProvider } = await import('./providerCommands.js')
      await cmdProvider(args)
      return 0
    }
    case 'phone': {
      const { cmdPhone } = await import('./commands.js')
      await cmdPhone(args)
      return 0
    }
    case 'login':
    case 'logout':
    case 'whoami': {
      const { cmdLogin } = await import('./commands.js')
      await cmdLogin(command)
      return 0
    }
    case 'dictation': {
      const { cmdDictation } = await import('./dictation.js')
      await cmdDictation(args)
      return 0
    }
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
    case 'update':
    case 'upgrade': {
      const { cmdUpdate } = await import('./update/command.js')
      await cmdUpdate(args)
      return 0
    }
    case 'config': {
      const { cmdConfig } = await import('./commands.js')
      cmdConfig(args)
      return 0
    }
    case 'version':
    case '--version':
    case '-v': {
      process.stdout.write(`${VERSION}\n`)
      // Scripts read stdout; a person at a terminal also hears about a newer release.
      if (process.stderr.isTTY) {
        const { versionNotice } = await import('./update/command.js')
        const notice = versionNotice()
        if (notice) process.stderr.write(`${notice}\n`)
      }
      return 0
    }
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
