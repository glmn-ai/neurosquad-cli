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
import { readConfig } from './config.js'
import { paths } from './paths.js'
import type { AgentView, RunSpec } from './protocol.js'
import { VERSION } from './version.js'

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
    const result = await client.request<{ restartNeeded: boolean }>({
      t: 'set',
      id: agent.id,
      ...(dangerous !== undefined
        ? { dangerousMode: dangerous === 'on' || dangerous === 'true' }
        : {}),
      ...(model !== undefined ? { model: model === 'none' ? null : model } : {}),
      ...(provider !== undefined ? { provider: provider === 'none' ? null : 'openrouter' } : {})
    })
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
    const cleanup = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
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
