// A small argument parser: `--flag`, `--key value`, `--key=value`, `-x`,
// and everything after `--` kept verbatim.
export interface ParsedArgs {
  positional: string[]
  flags: Map<string, string | true>
  /** Everything after a bare `--`. */
  rest: string[] | null
}

/** Flags that take a value (everything else is boolean). */
const VALUED = new Set([
  'name',
  'model',
  'provider',
  'since',
  'n',
  'lines',
  'cwd',
  'key',
  'hotkey',
  'language',
  'mode',
  'port'
])

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  let rest: string[] | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      rest = argv.slice(i + 1)
      break
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) flags.set(body.slice(0, eq), body.slice(eq + 1))
      else if (VALUED.has(body) && i + 1 < argv.length) flags.set(body, argv[++i])
      else flags.set(body, true)
      continue
    }
    if (arg.length > 1 && arg.startsWith('-') && !/^-\d/.test(arg)) {
      const letters = arg.slice(1)
      if (letters === 'n' && i + 1 < argv.length) {
        flags.set('n', argv[++i])
        continue
      }
      for (const letter of letters) flags.set(letter, true)
      continue
    }
    positional.push(arg)
  }
  return { positional, flags, rest }
}

export function flagString(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags.get(name)
    if (typeof value === 'string') return value
  }
  return undefined
}

export function flagBool(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => {
    const value = args.flags.get(name)
    return value === true || value === 'true' || value === 'on' || value === '1'
  })
}

/** `7d`, `12h`, `30m` → a start time (epoch ms) that far back from `now`. */
export function parseSince(text: string, now = Date.now()): number | undefined {
  const match = /^(\d+)\s*([dhm])$/i.exec(text.trim())
  if (!match) return undefined
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2].toLowerCase() as 'd' | 'h' | 'm']
  return now - Number(match[1]) * unit
}
