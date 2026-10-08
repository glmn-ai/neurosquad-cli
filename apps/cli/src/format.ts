// Small text helpers shared by the commands and the TUI.
import { formatUsd } from '@neurosquad/core'
import type { HarnessId } from '@neurosquad/core'
import type { AgentView } from './protocol.js'

const ALIASES: Record<string, HarnessId> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  cc: 'claude-code',
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
  opencode: 'opencode',
  oc: 'opencode'
}

export function harnessFromAlias(name: string): HarnessId | undefined {
  return ALIASES[name.toLowerCase()]
}

export const HARNESS_LABEL: Record<HarnessId, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex',
  opencode: 'OpenCode',
  command: 'command'
}

export function statusLabel(agent: Pick<AgentView, 'status'>): string {
  switch (agent.status) {
    case 'working':
      return 'working'
    case 'needs-input':
      return 'needs you'
    case 'finished':
      return 'finished'
    case 'idle':
      return 'idle'
    case 'exited':
      return 'exited'
    default:
      return 'starting'
  }
}

/** "12s", "4m", "2h", "3d". */
export function elapsed(since: number | undefined, now = Date.now()): string {
  if (!since) return '—'
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** An agent's cost: dollars, "no price" for requests without one, "—" before any request. */
export function costLabel(
  agent: Pick<AgentView, 'costPico' | 'unpricedRequests' | 'tokens'>
): string {
  if (agent.costPico === undefined) return agent.unpricedRequests ? 'no price' : '—'
  const pico = BigInt(agent.costPico)
  if (pico === 0n && agent.unpricedRequests) return 'no price'
  return `${formatUsd(pico)}${agent.unpricedRequests ? '+' : ''}`
}

/** Display width of a string (East Asian wide characters and emoji count two). */
export function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0)
  return width
}

export function charWidth(code: number): number {
  if (code === 0) return 0
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  // Combining marks.
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f)
    return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** Cuts `text` to `width` columns, with an ellipsis when it had to cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (textWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const w = charWidth(char.codePointAt(0) ?? 0)
    if (used + w > width - 1) break
    out += char
    used += w
  }
  return `${out}…`
}
