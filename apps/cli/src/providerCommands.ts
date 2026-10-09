// `nsq provider add|test|list|models|remove` — the user's own model servers
// (providers.ts). The key is asked for without echo, or read from stdin with
// --key-stdin; it is never an argument (argv is visible to every process).
import {
  CUSTOM_PROVIDER_HARNESSES,
  CUSTOM_PROVIDER_PRESETS,
  customProviderAddress,
  customProviderHarnessProblem,
  customProviderTransportWarning,
  type CustomProvider
} from '@neurosquad/core'
import { flagBool, flagString, type ParsedArgs } from './args.js'
import { UsageError, readSecretLine } from './commands.js'
import { HARNESS_LABEL } from './format.js'
import {
  endpointsLabel,
  getProvider,
  listProviders,
  providerKey,
  providerModels,
  removeProvider,
  saveProvider,
  type KeyChange,
  type SaveResult
} from './providers.js'

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`)
}

export const PROVIDER_USAGE = `nsq provider add <name> --url <base> [--key-stdin | --ask-key]
nsq provider test <name> [--key-stdin | --ask-key | --clear-key]
nsq provider list [--json]
nsq provider models <name> [query]
nsq provider remove <name>`

/** Reads a key: piped stdin with --key-stdin, asked without echo with --ask-key. */
async function keyChange(args: ParsedArgs, fallback: KeyChange): Promise<KeyChange> {
  if (flagBool(args, 'clear-key')) return 'clear'
  if (flagString(args, 'key') !== undefined || args.flags.get('key') === true) {
    throw new UsageError(
      'a key is never an argument (other processes can read argv): use --key-stdin or --ask-key'
    )
  }
  if (flagBool(args, 'key-stdin')) {
    if (process.stdin.isTTY) throw new UsageError('--key-stdin: pipe the key in (or use --ask-key)')
    const key = (await readSecretLine('')).trim()
    return key ? { set: key } : fallback
  }
  if (flagBool(args, 'ask-key')) {
    if (!process.stdin.isTTY)
      throw new UsageError('--ask-key needs a terminal (or use --key-stdin)')
    const key = (await readSecretLine('API key (empty: none): ')).trim()
    return key ? { set: key } : fallback
  }
  return fallback
}

/** Which harnesses run on the provider, and why the others do not. */
function harnessLines(provider: CustomProvider): string[] {
  return CUSTOM_PROVIDER_HARNESSES.map((harness) => {
    const label = HARNESS_LABEL[harness as keyof typeof HARNESS_LABEL] ?? harness
    const problem = customProviderHarnessProblem(harness, provider)
    if (problem) return `  ${label.padEnd(12)} no — ${problem}`
    const via =
      harness === 'codex-cli' && provider.endpoints.responses !== true
        ? ' (chat completions, through nsq’s Responses gateway)'
        : harness === 'opencode'
          ? provider.endpoints.chat
            ? ' (chat completions)'
            : ' (Anthropic messages)'
          : ''
    return `  ${label.padEnd(12)} yes${via}`
  })
}

function report(result: SaveResult, verb: string): void {
  if (!result.ok) {
    const hint =
      result.test && !result.test.ok && result.test.kind === 'unreachable'
        ? `\n  default ports: ${CUSTOM_PROVIDER_PRESETS.map((p) => `${p.name} ${p.url.replace(/^https?:\/\/[^:]+:/, '')}`).join(', ')}`
        : result.test && !result.test.ok && result.test.kind === 'unauthorized'
          ? '\n  give the key: --ask-key (typed, not shown) or --key-stdin (piped)'
          : ''
    throw new Error(`${result.error}${hint}`)
  }
  const { provider, test } = result
  out(
    `${verb} ${provider.id}: ${customProviderAddress(provider)} — ${test.models.length} model${test.models.length === 1 ? '' : 's'}, endpoints: ${endpointsLabel(provider)} (${test.latencyMs} ms)`
  )
  const warning = customProviderTransportWarning(provider)
  if (warning) process.stderr.write(`nsq: warning: ${warning}\n`)
  for (const line of harnessLines(provider)) out(line)
  if (test.models.length > 0) {
    out(
      `models: ${test.models
        .slice(0, 8)
        .map((m) => m.id)
        .join(', ')}${test.models.length > 8 ? ', …' : ''}`
    )
    out(`run one: nsq run <claude|codex|opencode> --provider ${provider.id} --model <id>`)
  }
}

export async function cmdProvider(args: ParsedArgs): Promise<void> {
  const verb = args.positional[0] ?? 'list'
  const name = args.positional[1]
  switch (verb) {
    case 'add': {
      const url = flagString(args, 'url') ?? args.positional[2]
      if (!name || !url) {
        throw new UsageError(
          `nsq provider add <name> --url <base> [--key-stdin | --ask-key]\n  e.g. nsq provider add lmstudio --url http://localhost:1234\n  defaults: ${CUSTOM_PROVIDER_PRESETS.map((p) => `${p.name} ${p.url}`).join(', ')}`
        )
      }
      const change = await keyChange(args, 'keep')
      const verb = getProvider(name) ? 'updated' : 'added'
      report(await saveProvider(name, url, change), verb)
      return
    }
    case 'test': {
      if (!name) throw new UsageError('nsq provider test <name>')
      if (!getProvider(name)) throw new UsageError(`no provider "${name}" (nsq provider list)`)
      report(
        await saveProvider(
          name,
          flagString(args, 'url') ??
            (args.flags.get('url') === true ? args.positional[2] : undefined),
          await keyChange(args, 'keep')
        ),
        'tested'
      )
      return
    }
    case 'list':
    case 'ls': {
      const providers = listProviders()
      if (flagBool(args, 'json')) {
        const withKeys = await Promise.all(
          providers.map(async (p) => ({ ...p, hasKey: Boolean(await providerKey(p.id)) }))
        )
        out(JSON.stringify(withKeys, null, 2))
        return
      }
      if (providers.length === 0) {
        out('no providers — add one: nsq provider add lmstudio --url http://localhost:1234')
        return
      }
      for (const provider of providers) {
        const key = (await providerKey(provider.id)) ? 'key ••••' : 'no key'
        out(
          `${provider.id.padEnd(16)} ${customProviderAddress(provider).padEnd(32)} ${endpointsLabel(provider).padEnd(26)} ${String(provider.models.length).padStart(4)} models  ${key}`
        )
      }
      return
    }
    case 'models': {
      if (!name) throw new UsageError('nsq provider models <name> [query]')
      const query = args.positional.slice(2).join(' ').toLowerCase()
      const { models, error } = await providerModels(name)
      if (error) process.stderr.write(`nsq: ${error}${models.length ? ' (the stored list)' : ''}\n`)
      for (const model of models) {
        if (query && !`${model.id} ${model.name ?? ''}`.toLowerCase().includes(query)) continue
        out(
          `${model.id.padEnd(48)} ${model.contextWindow ? `${model.contextWindow} ctx` : ''}`.trimEnd()
        )
      }
      return
    }
    case 'remove':
    case 'rm': {
      if (!name) throw new UsageError('nsq provider remove <name>')
      if (!(await removeProvider(name))) throw new UsageError(`no provider "${name}"`)
      out(
        `removed ${name.toLowerCase()} (agents on it will not start until moved: nsq set <agent> --provider …)`
      )
      return
    }
    default:
      throw new UsageError(PROVIDER_USAGE)
  }
}
