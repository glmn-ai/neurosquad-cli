// The non-interactive commands (`nsq run`, `ls`, `send`, `stop`…).
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveHarnessCommand, stripAnsi, type HarnessId } from '@neurosquad/core'
import { flagBool, flagString, parseSince, type ParsedArgs } from './args.js'
import { DaemonClient, daemonRunning, readState, startDaemon } from './client/client.js'
import {
  HARNESS_LABEL,
  costLabel,
  elapsed,
  harnessFromAlias,
  statusLabel,
  textWidth,
  truncate
} from './format.js'
import { attach, parseDetachKey } from './attach.js'
import { readConfig, writeConfig, type NsqConfig } from './config.js'
import { ensureDir, paths } from './paths.js'
import type { AgentView, RunSpec } from './protocol.js'
import { VERSION } from './version.js'
import { modelSwitchText, type ModelSwitchApplied } from './modelRules.js'

const execFileAsync = promisify(execFile)

export class UsageError extends Error {}

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`)
}

async function withClient<T>(
  run: (client: DaemonClient) => Promise<T>,
  autostart = true
): Promise<T> {
  const client = await DaemonClient.open('cli', { autostart })
  try {
    return await run(client)
  } finally {
    client.close()
  }
}

function requireRef(args: ParsedArgs, what = 'agent'): string {
  const ref = args.positional[0]
  if (!ref) throw new UsageError(`which ${what}? (a name or id from \`nsq ls\`)`)
  return ref
}

export async function cmdRun(args: ParsedArgs): Promise<void> {
  let spec: RunSpec
  const cwd = resolve(flagString(args, 'cwd') ?? process.cwd())
  const columns = process.stdout.columns || 120
  const rows = process.stdout.rows || 32
  const common = {
    cwd,
    ...(flagString(args, 'name') ? { name: flagString(args, 'name') } : {}),
    ...(flagBool(args, 'worktree', 'w') ? { worktree: true } : {}),
    ...(flagString(args, 'model') ? { model: flagString(args, 'model') } : {}),
    ...(flagBool(args, 'dangerous') ? { dangerousMode: true } : {}),
    cols: columns,
    rows
  }
  if (args.rest) {
    if (args.rest.length === 0)
      throw new UsageError('nsq run -- <command…>: the command is missing')
    spec = { harness: 'command', command: args.rest, ...common }
  } else {
    const alias = args.positional[0]
    if (!alias)
      throw new UsageError('nsq run <claude|codex|opencode> [prompt] — or nsq run -- <command…>')
    const harness = harnessFromAlias(alias)
    if (!harness)
      throw new UsageError(`unknown harness "${alias}" (claude, codex, opencode, or -- <command>)`)
    const provider = flagString(args, 'provider')
    if (provider && provider !== 'openrouter')
      throw new UsageError('--provider: only "openrouter" is supported')
    const prompt = args.positional.slice(1).join(' ').trim()
    spec = {
      harness,
      ...common,
      ...(prompt ? { prompt } : {}),
      ...(provider === 'openrouter' || flagBool(args, 'openrouter')
        ? { provider: 'openrouter' as const }
        : {})
    }
  }
  await withClient(async (client) => {
    const result = await client.request<{ agent: AgentView; warnings: string[] }>({
      t: 'run',
      spec
    })
    for (const warning of result.warnings) process.stderr.write(`nsq: ${warning}\n`)
    if (flagBool(args, 'json')) {
      out(JSON.stringify(result.agent))
      return
    }
    out(
      `started ${result.agent.name} (${HARNESS_LABEL[result.agent.harness]}) in ${result.agent.cwd}`
    )
    if (result.agent.worktree)
      out(`worktree: ${result.agent.worktree.path} on ${result.agent.worktree.branch}`)
    if (flagBool(args, 'attach', 'a') && process.stdin.isTTY) {
      await attach(client, result.agent, { detachKey: parseDetachKey(readConfig().detachKey) })
    } else {
      out(`nsq attach ${result.agent.name}   ·   nsq   (dashboard)`)
    }
  })
}

export function formatTable(agents: AgentView[], now = Date.now()): string[] {
  const rows = agents.map((agent) => [
    agent.name,
    HARNESS_LABEL[agent.harness],
    statusLabel(agent),
    elapsed(agent.statusAt ?? agent.createdAt, now),
    costLabel(agent),
    agent.worktree ? agent.worktree.branch : '',
    agent.status === 'needs-input' ? truncate(agent.detail ?? '', 60) : truncate(agent.cwd, 60)
  ])
  const head = ['NAME', 'HARNESS', 'STATUS', 'SINCE', 'COST', 'BRANCH', 'DETAIL']
  // Display width, not UTF-16 length: CJK and emoji take two columns.
  const widths = head.map((title, i) =>
    Math.max(textWidth(title), ...rows.map((row) => textWidth(row[i])))
  )
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i] - textWidth(cell))))
      .join('  ')
      .trimEnd()
  return [line(head), ...rows.map(line)]
}

export async function cmdLs(args: ParsedArgs): Promise<void> {
  if (!(await daemonRunning())) {
    if (flagBool(args, 'json')) out('[]')
    else out('no agents (the daemon is not running)')
    return
  }
  await withClient(async (client) => {
    const agents = await client.request<AgentView[]>({ t: 'list' })
    if (flagBool(args, 'json')) {
      out(JSON.stringify(agents, null, 2))
      return
    }
    if (agents.length === 0) {
      out('no agents — start one: nsq run claude "…"')
      return
    }
    for (const line of formatTable(agents)) out(line)
  }, false)
}

async function find(client: DaemonClient, ref: string): Promise<AgentView> {
  const agents = await client.request<AgentView[]>({ t: 'list' })
  const lower = ref.toLowerCase()
  const match =
    agents.find((agent) => agent.id === ref) ??
    agents.find((agent) => agent.name.toLowerCase() === lower) ??
    (agents.filter((agent) => agent.id.startsWith(lower)).length === 1
      ? agents.find((agent) => agent.id.startsWith(lower))
      : undefined)
  if (!match) throw new UsageError(`no agent "${ref}" (see nsq ls)`)
  return match
}

export async function cmdAttach(args: ParsedArgs): Promise<void> {
  if (!process.stdin.isTTY) throw new UsageError('nsq attach needs an interactive terminal')
  const ref = requireRef(args)
  await withClient(async (client) => {
    const agent = await find(client, ref)
    if (!agent.running) {
      await client.request({ t: 'start', id: agent.id })
    }
    const how = await attach(client, agent, { detachKey: parseDetachKey(readConfig().detachKey) })
    out(how === 'exited' ? `${agent.name} exited` : `detached from ${agent.name}`)
  })
}

export async function cmdSend(args: ParsedArgs): Promise<void> {
  const ref = requireRef(args)
  const text = args.positional.slice(1).join(' ').trim() || (args.rest ?? []).join(' ').trim()
  if (!text) throw new UsageError('nsq send <agent> "prompt" [--when-done]')
  await withClient(async (client) => {
    const agent = await find(client, ref)
    const result = await client.request<{ queued?: number; sent?: boolean }>({
      t: 'send',
      id: agent.id,
      text,
      whenDone: flagBool(args, 'when-done', 'queue')
    })
    out(
      result.queued
        ? `queued for ${agent.name} (${result.queued} waiting)`
        : `sent to ${agent.name}`
    )
  })
}

export async function cmdAnswer(args: ParsedArgs): Promise<void> {
  const ref = requireRef(args)
  const word = (args.positional[1] ?? '').toLowerCase()
  const key = ({ y: 'yes', yes: 'yes', a: 'always', always: 'always', n: 'no', no: 'no' } as const)[
    word as 'y'
  ]
  if (!key) throw new UsageError('nsq answer <agent> yes|always|no')
  await withClient(async (client) => {
    const agent = await find(client, ref)
    await client.request({ t: 'answer', id: agent.id, key })
    out(`answered ${key} to ${agent.name}`)
  })
}

export async function cmdSimple(
  verb: 'stop' | 'start' | 'restart' | 'interrupt',
  args: ParsedArgs
): Promise<void> {
  const ref = requireRef(args)
  await withClient(async (client) => {
    const agent = await find(client, ref)
    const result = await client.request<{ warnings?: string[] } | undefined>({
      t: verb,
      id: agent.id
    })
    for (const warning of result?.warnings ?? []) process.stderr.write(`nsq: ${warning}\n`)
    out(
      `${verb === 'stop' ? 'stopped' : verb === 'interrupt' ? 'interrupted' : `${verb}ed`} ${agent.name}`
    )
  })
}

export async function cmdRm(args: ParsedArgs): Promise<void> {
  const ref = requireRef(args)
  await withClient(async (client) => {
    const agent = await find(client, ref)
    const removeWorktree = flagBool(args, 'worktree')
    if (agent.worktree && !removeWorktree) {
      out(
        `keeping the worktree ${agent.worktree.path} (branch ${agent.worktree.branch}); add --worktree to delete it`
      )
    }
    await client.request({ t: 'remove', id: agent.id, removeWorktree })
    out(`removed ${agent.name}`)
  })
}

export async function cmdSet(args: ParsedArgs): Promise<void> {
  const ref = requireRef(args)
  const dangerousFlag = args.flags.get('dangerous')
  const dangerous =
    typeof dangerousFlag === 'string'
      ? dangerousFlag
      : dangerousFlag === true
        ? (args.positional.find((word, i) => i > 0 && /^(on|off|true|false)$/i.test(word)) ?? 'on')
        : undefined
  const model = flagString(args, 'model')
  const provider = flagString(args, 'provider')
  if (dangerous === undefined && model === undefined && provider === undefined) {
    throw new UsageError(
      'nsq set <agent> [--dangerous on|off] [--model <id>|none] [--provider openrouter|none]'
    )
  }
  await withClient(async (client) => {
    const agent = await find(client, ref)
    const result = await client.request<{
      restartNeeded: boolean
      applied?: ModelSwitchApplied
      warnings?: string[]
    }>({
      t: 'set',
      id: agent.id,
      ...(dangerous !== undefined
        ? { dangerousMode: dangerous === 'on' || dangerous === 'true' }
        : {}),
      ...(model !== undefined ? { model: model === 'none' ? null : model } : {}),
      ...(provider !== undefined ? { provider: provider === 'none' ? null : 'openrouter' } : {})
    })
    for (const warning of result.warnings ?? [])
      process.stderr.write(`nsq: ${warning}
`)
    if (model !== undefined || provider !== undefined) {
      // The daemon has the agent's model/provider now (the request may have changed only one).
      const now = (await client.request<AgentView[]>({ t: 'list' })).find((a) => a.id === agent.id)
      out(`${agent.name}: ${modelSwitchText(now?.model, now?.provider, result.applied)}`)
      return
    }
    out(
      result.restartNeeded
        ? `updated ${agent.name}; applies after nsq restart ${agent.name}`
        : `updated ${agent.name}`
    )
  })
}

export async function cmdDiff(args: ParsedArgs): Promise<void> {
  const ref = requireRef(args)
  await withClient(async (client) => {
    const agent = await find(client, ref)
    const { stdout } = await execFileAsync('git', ['-c', 'color.ui=always', 'diff', 'HEAD'], {
      cwd: agent.cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    })
    process.stdout.write(stdout || `${agent.name}: no changes\n`)
  })
}

export async function cmdPeek(args: ParsedArgs): Promise<void> {
  const ref = requireRef(args)
  const lines = Number(flagString(args, 'n', 'lines') ?? '20')
  await withClient(async (client) => {
    const agent = await find(client, ref)
    const text = await new Promise<string>((resolveText) => {
      let screen = ''
      const off = client.on((event) => {
        if (event.t === 'screen' && event.id === agent.id) {
          screen = event.data
          off()
          resolveText(screen)
        }
      })
      void client
        .request({ t: 'snapshot', id: agent.id })
        .then(() => setTimeout(() => resolveText(screen), 200))
    })
    const plain = stripAnsi(text)
    const rows = plain.split(/\r?\n/).filter((line, i, all) => line.trim() || i < all.length - 1)
    out(rows.slice(-lines).join('\n'))
  })
}

export async function cmdCost(args: ParsedArgs): Promise<void> {
  const sinceText = flagString(args, 'since')
  const since = sinceText ? parseSince(sinceText) : undefined
  if (sinceText && since === undefined) throw new UsageError('--since: e.g. 7d, 12h, 30m')
  await withClient(async (client) => {
    type Row = {
      name: string
      harness: HarnessId
      requests: number
      usd: string
      pico: string
      unpricedRequests: number
      totals: { input: number; output: number; cacheRead: number; cacheWrite: number }
      models: string[]
    }
    const rows = await client.request<Row[]>({ t: 'cost', ...(since ? { since } : {}) })
    if (flagBool(args, 'json')) {
      out(JSON.stringify(rows, null, 2))
      return
    }
    let total = 0n
    let unpriced = 0
    out(
      'NAME'.padEnd(18) +
        'HARNESS'.padEnd(13) +
        'REQUESTS'.padStart(9) +
        'TOKENS'.padStart(13) +
        'COST'.padStart(12) +
        '  MODEL'
    )
    for (const row of rows) {
      const tokens =
        row.totals.input + row.totals.output + row.totals.cacheRead + row.totals.cacheWrite
      total += BigInt(row.pico)
      unpriced += row.unpricedRequests
      const cost =
        row.requests === 0
          ? '—'
          : row.unpricedRequests && row.pico === '0'
            ? 'no price'
            : `${row.usd}${row.unpricedRequests ? '+' : ''}`
      out(
        truncate(row.name, 17).padEnd(18) +
          HARNESS_LABEL[row.harness].padEnd(13) +
          String(row.requests).padStart(9) +
          tokens.toLocaleString('en-US').padStart(13) +
          cost.padStart(12) +
          `  ${row.models.slice(0, 2).join(', ')}`
      )
    }
    const { formatUsd } = await import('@neurosquad/core')
    out(
      `total ${formatUsd(total)}${unpriced ? ` (+ ${unpriced} request${unpriced > 1 ? 's' : ''} with no price)` : ''}`
    )
  })
}

export async function cmdUp(): Promise<void> {
  if (await daemonRunning()) {
    out('the nsq daemon is running')
    return
  }
  await startDaemon()
  const state = readState()
  out(`started the nsq daemon (pid ${state?.pid ?? '?'}); agents that were running are resumed`)
}

export async function cmdDown(): Promise<void> {
  if (!(await daemonRunning())) {
    out('the nsq daemon is not running')
    return
  }
  await withClient(async (client) => {
    await client.request({ t: 'shutdown', stopAgents: true })
  }, false)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && (await daemonRunning()))
    await new Promise((r) => setTimeout(r, 150))
  if (await daemonRunning()) {
    throw new Error(`the nsq daemon did not stop within 15 s (see ${paths.daemonLog()})`)
  }
  out('stopped the nsq daemon and its agents (they resume with `nsq up`)')
}

export async function cmdDoctor(): Promise<void> {
  out(`nsq ${VERSION} · node ${process.version} · ${process.platform}-${process.arch}`)
  out(`home: ${paths.home()}`)
  const running = await daemonRunning()
  out(`daemon: ${running ? `running (pid ${readState()?.pid})` : 'not running'}`)
  for (const harness of ['claude-code', 'codex-cli', 'opencode'] as const) {
    const found = resolveHarnessCommand(harness)
    out(`${HARNESS_LABEL[harness].padEnd(12)} ${found ?? 'not found on PATH'}`)
  }
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  try {
    await execFileAsync(curl, ['--version'], { windowsHide: true })
    out(`${curl.padEnd(12)} ok (hooks use it)`)
  } catch {
    out(`${curl.padEnd(12)} MISSING — Claude Code and Codex hooks need it`)
  }
  try {
    await import('node-pty')
    out('node-pty     ok')
  } catch (error) {
    out(`node-pty     FAILED: ${String(error)}`)
  }
  const { openRouterKey } = await import('./daemon/secrets.js')
  out(
    `OpenRouter   ${(await openRouterKey()) ? 'key available' : 'no key (nsq openrouter set-key)'}`
  )
  const { doctorUpdateLines } = await import('./update/command.js')
  const [first, ...more] = await doctorUpdateLines()
  out(`update       ${first ?? ''}`)
  for (const line of more) out(`             ${line.trimStart()}`)
  const term =
    process.env['TERM_PROGRAM'] ??
    process.env['TERM'] ??
    (process.env['WT_SESSION'] ? 'Windows Terminal' : 'unknown')
  out(`terminal     ${term}, ${process.stdout.columns ?? '?'}x${process.stdout.rows ?? '?'}`)
}

export async function cmdOpenRouter(args: ParsedArgs): Promise<void> {
  const verb = args.positional[0] ?? 'status'
  switch (verb) {
    case 'set-key': {
      let key = args.positional[1] ?? flagString(args, 'key')
      if (!key) key = await readSecretLine('OpenRouter API key: ')
      key = key.trim()
      if (!/^sk-or-[\w-]{10,}$/.test(key))
        throw new UsageError('that does not look like an OpenRouter key (sk-or-…)')
      const { setSecret, OPENROUTER_SECRET } = await import('./daemon/secrets.js')
      await setSecret(OPENROUTER_SECRET, key)
      out('stored the OpenRouter key in the OS keyring')
      return
    }
    case 'clear-key': {
      const { setSecret, OPENROUTER_SECRET } = await import('./daemon/secrets.js')
      await setSecret(OPENROUTER_SECRET, undefined)
      out('removed the OpenRouter key')
      return
    }
    case 'models': {
      const { fetchOpenRouterModels } = await import('./daemon/models.js')
      const models = await fetchOpenRouterModels(args.positional.slice(1).join(' '))
      for (const model of models.slice(0, 50)) {
        const price =
          model.promptPerMTok !== undefined && model.completionPerMTok !== undefined
            ? `$${model.promptPerMTok}/$${model.completionPerMTok} per M`
            : ''
        out(`${model.id.padEnd(48)} ${price}`)
      }
      return
    }
    case 'status': {
      const { openRouterKey } = await import('./daemon/secrets.js')
      out(
        (await openRouterKey())
          ? 'OpenRouter key: available'
          : 'OpenRouter key: none (nsq openrouter set-key)'
      )
      return
    }
    default:
      throw new UsageError('nsq openrouter set-key|clear-key|models [query]|status')
  }
}

const BOOLEAN = new Map<string, boolean>([
  ['true', true],
  ['on', true],
  ['false', false],
  ['off', false]
])

/** The settings `nsq config set` changes (the rest of config.json is written by its commands). */
const CONFIG_KEYS: Record<string, { values: string; parse: (text: string) => unknown }> = {
  autoUpdate: {
    values: 'true | notify | false',
    parse: (text) => (text === 'notify' ? 'notify' : BOOLEAN.get(text))
  },
  notifications: { values: 'true | false', parse: (text) => BOOLEAN.get(text) },
  sound: { values: 'true | false', parse: (text) => BOOLEAN.get(text) },
  logos: {
    values: 'auto | images | glyphs | neutral',
    parse: (text) => (['auto', 'images', 'glyphs', 'neutral'].includes(text) ? text : undefined)
  },
  color: {
    values: 'auto | truecolor | 256 | 16',
    parse: (text) => (['auto', 'truecolor', '256', '16'].includes(text) ? text : undefined)
  },
  layout: {
    values: 'grid | focus',
    parse: (text) => (['grid', 'focus'].includes(text) ? text : undefined)
  },
  detachKey: {
    values: 'Ctrl+<key>',
    parse: (text) => (/^ctrl\+.$/i.test(text) ? text : undefined)
  }
}

/** `nsq config` · `get <key>` · `set <key> <value>` · `unset <key>` */
export function cmdConfig(args: ParsedArgs): void {
  const [verb = 'list', key, value] = args.positional
  const config = readConfig() as Record<string, unknown>
  const usage = `nsq config [get <key> | set <key> <value> | unset <key>]; keys: ${Object.keys(CONFIG_KEYS).join(', ')}`
  if (verb === 'list' || verb === 'show') {
    out(`# ${paths.config()}`)
    out(JSON.stringify(config, null, 2))
    return
  }
  if (!key) throw new UsageError(usage)
  const spec = Object.hasOwn(CONFIG_KEYS, key) ? CONFIG_KEYS[key] : undefined
  switch (verb) {
    case 'get':
      out(config[key] === undefined ? '(default)' : JSON.stringify(config[key]))
      return
    case 'set': {
      if (!spec)
        throw new UsageError(
          `nsq config set: unknown key "${key}" (${Object.keys(CONFIG_KEYS).join(', ')})`
        )
      const parsed = value === undefined ? undefined : spec.parse(value)
      if (parsed === undefined) throw new UsageError(`nsq config set ${key} <${spec.values}>`)
      ensureDir(paths.home())
      writeConfig({ ...config, [key]: parsed } as NsqConfig)
      out(`${key} = ${JSON.stringify(parsed)}`)
      return
    }
    case 'unset': {
      if (!spec) throw new UsageError(`nsq config unset: unknown key "${key}"`)
      const next = { ...config }
      delete next[key]
      ensureDir(paths.home())
      writeConfig(next as NsqConfig)
      out(`${key} back to its default`)
      return
    }
    default:
      throw new UsageError(usage)
  }
}

/** Several secret lines: asked one by one on a terminal, or the first lines of piped stdin. */
export async function readSecretLines(prompts: readonly string[]): Promise<string[]> {
  if (prompts.length === 0) return []
  if (process.stdin.isTTY) {
    const lines: string[] = []
    for (const prompt of prompts) lines.push(await readSecretLine(prompt))
    return lines
  }
  const data = await new Promise<string>((resolveData) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => (text += chunk))
    process.stdin.on('end', () => resolveData(text))
  })
  return data.split(/\r?\n/).slice(0, prompts.length)
}

/** Reads one line without echoing it (for keys). */
export function readSecretLine(prompt: string): Promise<string> {
  return new Promise((resolveLine, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      let data = ''
      stdin.setEncoding('utf8')
      stdin.on('data', (chunk: string) => (data += chunk))
      stdin.on('end', () => resolveLine(data.split(/\r?\n/)[0] ?? ''))
      return
    }
    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    let line = ''
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolveLine(line)
          return
        }
        if (char === '\x03') {
          cleanup()
          reject(new Error('cancelled'))
          return
        }
        if (char === '\x7f' || char === '\b') line = line.slice(0, -1)
        else line += char
      }
    }
    // Whatever ends the prompt — a line, Ctrl+C, a signal, the process exiting — the terminal
    // leaves raw mode.
    const restore = (): void => {
      try {
        stdin.setRawMode(false)
      } catch {
        // stdin already gone
      }
    }
    const onSignal = (signal: NodeJS.Signals): void => {
      cleanup()
      process.kill(process.pid, signal)
    }
    const cleanup = (): void => {
      stdin.off('data', onData)
      process.off('exit', restore)
      for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.off(signal, onSignal)
      restore()
      stdin.pause()
    }
    process.once('exit', restore)
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.once(signal, onSignal)
    stdin.on('data', onData)
  })
}

/** Debugging aid: raw input to an agent's terminal, given as a JSON string (\u001b…). */
export async function cmdRawInput(args: ParsedArgs): Promise<void> {
  const ref = requireRef(args)
  const data = JSON.parse(args.positional[1] ?? '""') as string
  await withClient(async (client) => {
    const agent = await find(client, ref)
    await client.request({ t: 'input', id: agent.id, data })
  })
}

interface PhoneReply {
  status: {
    running: boolean
    lan: boolean
    port?: number
    address?: string
    connections: number
    phones: {
      address: string
      device: string
      firstSeen: number
      open: number
      via?: 'internet'
    }[]
    online?: { state: string; mode?: 'quick' | 'named'; url?: string; error?: string }
    expireHours?: number
  }
  links?: string[]
}

const PHONE_USAGE =
  'nsq phone on [--lan] [--port n] [--online [--tunnel-token --hostname h] [--refresh]] [--expire 12h|off] | off | pair | rotate | status | tunnel-token set|clear | push ntfy [--url] [--token]|off|test|show|status'

/** The warning that goes with every online address. */
export const ONLINE_WARNING =
  'ONLINE: anyone with this link and token can control your agents. Turn it off: nsq phone off (or nsq phone on without --online)'

function describePhone(status: PhoneReply['status']): string {
  if (!status.running) return 'phone access: off (nsq phone on [--lan] [--online])'
  const where = status.lan
    ? `the local network, port ${status.port}`
    : `this machine only, port ${status.port}`
  const online = status.online
  const reach =
    online?.state === 'running'
      ? `; online at ${online.url}`
      : online?.state === 'error'
        ? '; online: failed'
        : online
          ? `; online: ${online.state}`
          : ''
  const expiry = status.expireHours ? `; pairing expires after ${status.expireHours} h` : ''
  return `phone access: on — ${where}${reach}${expiry}; ${status.phones.length} connected`
}

/** `12`, `12h`, `2d` → hours; `off`/`0`/`never` → null; anything else → undefined. */
export function parseExpireHours(text: string): number | null | undefined {
  const value = text.trim().toLowerCase()
  if (value === 'off' || value === 'never' || value === '0') return null
  const match = /^(\d{1,4})\s*([hd]?)$/.exec(value)
  if (!match) return undefined
  const hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1)
  return hours > 0 && hours <= 24 * 365 ? hours : undefined
}

export async function cmdPhone(args: ParsedArgs): Promise<void> {
  const verb = args.positional[0] ?? 'status'
  if (verb === 'push') {
    await cmdPhonePush(args)
    return
  }
  if (verb === 'tunnel-token') {
    await cmdTunnelToken(args)
    return
  }
  if (!['status', 'on', 'off', 'pair', 'rotate'].includes(verb)) {
    throw new UsageError(PHONE_USAGE)
  }
  const port = flagString(args, 'port')
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) > 65535))
    throw new UsageError('--port takes a number from 0 to 65535')
  const tunnelPort = flagString(args, 'tunnel-port')
  if (
    tunnelPort !== undefined &&
    (!/^\d{1,5}$/.test(tunnelPort) || Number(tunnelPort) < 1 || Number(tunnelPort) > 65535)
  )
    throw new UsageError('--tunnel-port takes a number from 1 to 65535')
  if (typeof args.flags.get('tunnel-token') === 'string') {
    // A tunnel token works like a password: never on the command line.
    throw new UsageError(
      'give no token on the command line: save it with nsq phone tunnel-token set, then use --tunnel-token'
    )
  }
  const online = args.flags.has('online') ? flagBool(args, 'online') : false
  const named = flagBool(args, 'tunnel-token')
  if (named && !online) throw new UsageError('--tunnel-token goes with --online')
  const refresh = flagBool(args, 'refresh')
  if (refresh && !online) throw new UsageError('--refresh goes with --online')
  const hostnameFlag = flagString(args, 'hostname')
  let hostname: string | undefined
  if (hostnameFlag !== undefined) {
    const { normalizeTunnelHostname } = await import('@neurosquad/remote')
    hostname = normalizeTunnelHostname(hostnameFlag)?.replace(/^https:\/\//, '')
    if (!hostname) throw new UsageError('--hostname takes a host name like nsq.example.com')
  }
  const expireFlag = flagString(args, 'expire')
  const expireHours = expireFlag === undefined ? undefined : parseExpireHours(expireFlag)
  if (expireFlag !== undefined && expireHours === undefined)
    throw new UsageError('--expire takes hours or days (12h, 2d) or off')
  if (verb === 'on' && online) {
    process.stderr.write(
      named
        ? 'going online through your named Cloudflare tunnel…\n'
        : "going online through a Cloudflare quick tunnel (the first time, cloudflared is downloaded from Cloudflare's GitHub releases and its sha256 checked)…\n"
    )
  }
  const client = await DaemonClient.open('phone')
  try {
    const reply = (await client.request({
      t: 'phone',
      action: verb as 'status' | 'on' | 'off' | 'pair' | 'rotate',
      ...(args.flags.has('lan') ? { lan: flagBool(args, 'lan') } : {}),
      ...(port !== undefined ? { port: Number(port) } : {}),
      ...(verb === 'on' ? { online } : {}),
      // From the command line the tunnel is what the flags say (quick unless --tunnel-token).
      ...(online ? { named } : {}),
      ...(refresh ? { refresh } : {}),
      ...(hostname ? { hostname } : {}),
      ...(tunnelPort !== undefined ? { tunnelPort: Number(tunnelPort) } : {}),
      ...(expireHours !== undefined ? { expireHours } : {})
    })) as PhoneReply
    const status = reply.status
    out(describePhone(status))
    for (const phone of status.phones) {
      out(
        `  ${phone.device}  ${phone.address}${phone.via ? '  (internet)' : ''}  since ${new Date(phone.firstSeen).toLocaleTimeString()}${phone.open ? '  (live)' : ''}`
      )
    }
    if (status.online?.state === 'running') out(`! ${ONLINE_WARNING}`)
    if (verb === 'rotate')
      out('new pairing token: every paired phone is signed out (nsq phone pair)')
    if (verb === 'on' && online) {
      if (status.online?.state !== 'running') {
        throw new Error(
          `could not go online: ${status.online?.error ?? 'the tunnel did not start'} (phone access stays on locally)`
        )
      }
      if (status.online.mode !== 'named') {
        out(
          'the quick-tunnel address changes every time it starts: pair the phone again after nsq phone on --online, a restart or nsq down'
        )
      }
      await printPairing(reply.links ?? [])
      return
    }
    if (verb === 'on' && !status.lan) {
      out(
        'a phone cannot reach 127.0.0.1; for the Wi-Fi: nsq phone on --lan; from anywhere: nsq phone on --online'
      )
    }
    if (verb === 'pair') {
      const links = reply.links ?? []
      if (!links.length) {
        out(
          status.running
            ? 'no network address found'
            : 'turn it on first: nsq phone on --lan (or --online)'
        )
        return
      }
      await printPairing(links)
    }
  } finally {
    client.close()
  }
}

/** The QR of the first link and every link — they carry the pairing token. */
async function printPairing(links: string[]): Promise<void> {
  if (!links.length) return
  // The link is the credential: shown only on request (pair, or on --online which is pairing).
  const { renderUnicodeCompact } = await import('uqr')
  out('Scan with the phone (it carries the pairing token — do not share it):')
  out(renderUnicodeCompact(links[0]!))
  for (const link of links) out(`  ${link}`)
}

/** `nsq phone tunnel-token set | clear` — a named tunnel's token, kept in the OS keyring. */
async function cmdTunnelToken(args: ParsedArgs): Promise<void> {
  const { setSecret } = await import('./daemon/secrets.js')
  const { TUNNEL_TOKEN_SECRET } = await import('./daemon/phone.js')
  const verb = args.positional[1]
  if (args.positional[2] !== undefined) {
    throw new UsageError(
      'give no token on the command line: nsq phone tunnel-token set asks for it (or reads it from stdin)'
    )
  }
  if (verb === 'set') {
    const [answer] = await readSecretLines(['Cloudflare tunnel token: '])
    const token = (answer ?? '').trim()
    if (!/^[A-Za-z0-9+/=_-]{20,4096}$/.test(token)) {
      throw new UsageError(
        'that does not look like a tunnel token (Cloudflare dashboard → Tunnels → your tunnel → the token after --token)'
      )
    }
    await setSecret(TUNNEL_TOKEN_SECRET, token)
    out('tunnel token saved in the OS keyring')
    out('then: nsq phone on --online --tunnel-token --hostname <the public hostname you set up>')
    return
  }
  if (verb === 'clear') {
    await setSecret(TUNNEL_TOKEN_SECRET, undefined)
    out('tunnel token removed')
    return
  }
  throw new UsageError('nsq phone tunnel-token set | clear')
}

/** `nsq phone push ntfy [--url] [--token] | off | test | show | status` */
async function cmdPhonePush(args: ParsedArgs): Promise<void> {
  const push = await import('./daemon/push.js')
  const verb = args.positional[1] ?? 'status'
  const sender = new push.NtfyPush((line) => process.stderr.write(`${line}\n`))
  switch (verb) {
    case 'ntfy': {
      if (
        typeof args.flags.get('token') === 'string' ||
        typeof args.flags.get('url') === 'string' ||
        args.positional[2] !== undefined
      ) {
        // The topic URL and the token work like passwords: never on the command line (process
        // list, shell history) - asked for, or piped in one per line.
        throw new UsageError(
          'give no URL or token on the command line: nsq phone push ntfy [--url] [--token] asks for them (or reads them from stdin, one per line)'
        )
      }
      const askUrl = args.flags.get('url') === true
      const askToken = args.flags.get('token') === true
      const answers = await readSecretLines([
        ...(askUrl ? ['ntfy topic URL: '] : []),
        ...(askToken ? ['ntfy access token: '] : [])
      ])
      const url = askUrl ? (answers[0] ?? '').trim() : push.randomNtfyUrl()
      const target = push.parseNtfyUrl(url)
      const token = askToken ? (answers[askUrl ? 1 : 0] ?? '').trim() || undefined : undefined
      push.checkTokenTransport(target, token)
      await push.saveNtfy(url, token)
      out(`push on: when an agent needs you, ntfy gets its name and question (nothing else)`)
      out('Subscribe to this topic in the ntfy app (it works like a password — keep it private):')
      out(`  ${url}`)
      if (target.server.startsWith('http:')) {
        out('note: plain http — fine on your own network, not over the internet')
      }
      out('Check it: nsq phone push test')
      return
    }
    case 'off':
      // Stored as "off" so NSQ_NTFY_URL in the daemon's environment does not switch it back on.
      try {
        await push.saveNtfy(push.NTFY_OFF, undefined)
      } catch {
        throw new Error(
          'no OS keyring here: push comes from NSQ_NTFY_URL — remove it from the environment where the daemon starts, then nsq down / nsq up'
        )
      }
      out('push off')
      return
    case 'test': {
      const configured = await sender.target()
      if (!configured) throw new UsageError('push is off: nsq phone push ntfy [--url]')
      const ok = await sender.send(
        configured.target,
        configured.token,
        push.ntfyMessage(configured.target, {
          agentId: 'test',
          agentName: 'nsq',
          question: 'Test notification — push works.'
        })
      )
      if (!ok) throw new Error('the ntfy server did not accept the message')
      out('sent a test notification')
      return
    }
    case 'show': {
      const configured = await sender.target()
      out(
        configured
          ? `${configured.target.server}/${configured.target.topic}`
          : 'push is off: nsq phone push ntfy [--url]'
      )
      return
    }
    case 'status': {
      const configured = await sender.target()
      out(
        configured
          ? `push: ntfy on ${new URL(configured.target.server).host} (topic: nsq phone push show)${configured.token ? ', with an access token' : ''}`
          : 'push: off (nsq phone push ntfy [--url])'
      )
      return
    }
    default:
      throw new UsageError('nsq phone push ntfy [--url] [--token] | off | test | show | status')
  }
}

export async function cmdLogin(verb: 'login' | 'logout' | 'whoami'): Promise<void> {
  const { cmdCloud } = await import('./cloud.js')
  await cmdCloud(verb)
}
