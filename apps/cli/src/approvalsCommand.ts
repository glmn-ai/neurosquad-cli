// `nsq log approvals` — the approvals log as a table (or JSON): which agent asked what, the
// answer, and who gave it from where. Reads the files directly: no daemon needed.
import { flagBool, flagString, parseSince, type ParsedArgs } from './args.js'
import { HARNESS_LABEL, textWidth, truncate } from './format.js'
import { paths } from './paths.js'
import { readConfig } from './config.js'
import { UsageError } from './commands.js'
import { readApprovals, type ApprovalBy, type ApprovalRecord } from './daemon/approvals.js'

const USAGE = 'nsq log approvals [--agent <name|id>] [--since 2h] [-n 50] [--json]'
const DEFAULT_ROWS = 50

/** "dashboard", "nsq answer", "phone (LAN, iPhone · Safari)", "terminal (attach)". */
export function byLabel(by: ApprovalBy | undefined, outcome: ApprovalRecord['outcome']): string {
  if (!by) return '—'
  switch (by.via) {
    case 'dashboard':
      return 'dashboard'
    case 'cli':
      return outcome === 'interrupted' ? 'nsq interrupt' : 'nsq answer'
    case 'terminal':
      return `terminal (${by.client ?? '?'})`
    case 'phone': {
      const where = by.from === 'internet' ? 'internet' : by.from === 'lan' ? 'LAN' : 'local'
      return `phone (${[where, by.device].filter(Boolean).join(', ')})`
    }
  }
}

/** The answer, or how the question ended without one. */
export function answerLabel(record: ApprovalRecord): string {
  if (record.answer) return record.answer
  switch (record.outcome) {
    case 'terminal':
      return 'answered'
    case 'cli':
      return 'CLI went on'
    case 'ended':
      return 'turn ended'
    default:
      return record.outcome
  }
}

/** "Bash: npm test", "Edit: src/a.ts", else the CLI's own wording. */
export function questionLabel(record: ApprovalRecord): string {
  const { tool, command, path, url, text } = record.question
  const target = command ?? path ?? url
  return tool && target ? `${tool}: ${target}` : text
}

function timeLabel(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function filterApprovals(
  records: readonly ApprovalRecord[],
  options: { agent?: string; since?: number }
): ApprovalRecord[] {
  const ref = options.agent?.toLowerCase()
  return records.filter((record) => {
    if (options.since !== undefined && Date.parse(record.at) < options.since) return false
    if (ref) {
      const name = record.agent.name.toLowerCase()
      if (name !== ref && !record.agent.id.startsWith(ref)) return false
    }
    return true
  })
}

/** Control characters (C0, DEL, C1) out: a field could carry an escape sequence. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

export function formatApprovals(records: readonly ApprovalRecord[], width = 120): string[] {
  const head = ['TIME', 'AGENT', 'HARNESS', 'ANSWER', 'BY', 'QUESTION']
  // The file is data: no escape sequence or control character in it reaches the terminal.
  const rows = records.map((record) => [
    timeLabel(record.at),
    truncate(plain(record.agent.name), 16),
    plain(HARNESS_LABEL[record.harness] ?? String(record.harness)),
    plain(answerLabel(record)),
    truncate(plain(byLabel(record.by, record.outcome)), 34),
    plain(questionLabel(record))
  ])
  const widths = head.map((cell, i) =>
    i === head.length - 1 ? 0 : Math.max(textWidth(cell), ...rows.map((row) => textWidth(row[i]!)))
  )
  const used = widths.reduce((sum, w) => sum + w + 2, 0)
  const rest = Math.max(20, width - used)
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) =>
        i === cells.length - 1
          ? truncate(cell, rest)
          : cell + ' '.repeat(Math.max(0, widths[i]! - textWidth(cell)))
      )
      .join('  ')
      .trimEnd()
  return [line(head), ...rows.map(line)]
}

export function cmdLog(args: ParsedArgs): void {
  const [what] = args.positional
  if (what !== 'approvals') throw new UsageError(USAGE)
  const sinceText = flagString(args, 'since')
  const since = sinceText ? parseSince(sinceText) : undefined
  if (sinceText && since === undefined) throw new UsageError('--since: e.g. 2h, 7d, 30m')
  const countText = flagString(args, 'n', 'lines')
  const count = countText === undefined ? undefined : Number.parseInt(countText, 10)
  if (countText !== undefined && !(count! > 0)) throw new UsageError('-n: a number of rows')
  const agent = flagString(args, 'agent')
  const records = filterApprovals(readApprovals(paths.logs()), {
    ...(agent ? { agent } : {}),
    ...(since !== undefined ? { since } : {})
  })
  if (flagBool(args, 'json')) {
    const shown = count ? records.slice(-count) : records
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`)
    return
  }
  const off = readConfig().approvalsLog === false
  if (records.length === 0) {
    process.stdout.write(
      off
        ? 'the approvals log is off (nsq config set approvalsLog true)\n'
        : 'no approvals logged yet\n'
    )
    return
  }
  const shown = records.slice(-(count ?? DEFAULT_ROWS))
  const width = process.stdout.columns || 120
  for (const line of formatApprovals(shown, width)) process.stdout.write(`${line}\n`)
  if (shown.length < records.length)
    process.stdout.write(
      `(${records.length - shown.length} earlier; -n ${records.length} for all, --json for details)\n`
    )
  if (off) process.stdout.write('the approvals log is off now (nsq config set approvalsLog true)\n')
}
