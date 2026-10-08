/**
 * Status vocabulary (same five states as the desktop's `lib/agentStatus.ts`) and the glyph sets
 * that draw them. A status is never colour-only: every state has its own glyph shape *and* label,
 * so it reads on a 16-colour terminal, with NO_COLOR, and for colour-blind users.
 */
import type { Role } from './tokens.js'

export type AgentStatus = 'working' | 'needs-input' | 'finished' | 'idle' | 'exited'

/** Display order in lists: what needs you first. */
export const STATUS_ORDER: readonly AgentStatus[] = [
  'needs-input',
  'working',
  'finished',
  'idle',
  'exited'
]

export interface GlyphSet {
  readonly status: { readonly [S in AgentStatus]: string }
  /** Spinner frames for "working" (one cell each). */
  readonly spinner: readonly string[]
  readonly bullet: string
  readonly separator: string
  readonly ellipsis: string
  readonly chevronRight: string
  readonly chevronDown: string
  readonly arrowUp: string
  readonly arrowDown: string
  readonly enter: string
  readonly check: string
  readonly cross: string
  /** Twinkle frames for the "done" sparkle. */
  readonly sparkle: readonly string[]
  /** Glyphs a "thinking" label scrambles through. */
  readonly scramble: string
}

/**
 * Default set. Every glyph is one cell wide and has no emoji presentation by default (so it never
 * turns into a two-cell colour emoji); `●○◐` and box drawing are East Asian *ambiguous* — that is
 * why `ambiguousWide` terminals get the ASCII set.
 */
export const UNICODE_GLYPHS: GlyphSet = {
  status: {
    'needs-input': '●',
    working: '◐',
    finished: '✔',
    idle: '○',
    exited: '✕'
  },
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  bullet: '•',
  separator: '·',
  ellipsis: '…',
  chevronRight: '›',
  chevronDown: '⌄',
  arrowUp: '↑',
  arrowDown: '↓',
  enter: '⏎',
  check: '✔',
  cross: '✕',
  sparkle: ['·', '✧', '✦', '✧', '✔'],
  scramble: 'abcdefghkmnpqrstwxyz0123456789#$%&*+=?<>/~^▚▞'
}

export const ASCII_GLYPHS: GlyphSet = {
  status: {
    'needs-input': '!',
    working: '*',
    finished: '+',
    idle: '-',
    exited: 'x'
  },
  spinner: ['|', '/', '-', '\\'],
  bullet: '*',
  separator: '|',
  ellipsis: '...',
  chevronRight: '>',
  chevronDown: 'v',
  arrowUp: '^',
  arrowDown: 'v',
  enter: 'Enter',
  check: '+',
  cross: 'x',
  sparkle: ['.', '+', '*', '+', '+'],
  scramble: 'abcdefghkmnpqrstwxyz0123456789#$%&*+=?<>/~^'
}

export function glyphSet(unicode: boolean): GlyphSet {
  return unicode ? UNICODE_GLYPHS : ASCII_GLYPHS
}

export interface StatusStyle {
  /** Short label for rows: `NEEDS YOU`, `working`, … (upper-case = the one that wants you). */
  readonly label: string
  /** Long label for screen readers / `--json` / help. */
  readonly description: string
  readonly role: Role
  /** Bold label (only needs-you shouts). */
  readonly bold: boolean
}

/** Desktop mapping (`cards/squad/OverviewSummary.tsx` TONE, `Sidebar.tsx` dots). */
export const STATUS_STYLE: { readonly [S in AgentStatus]: StatusStyle } = {
  'needs-input': {
    label: 'NEEDS YOU',
    description: 'waiting for your answer',
    role: 'needsYou',
    bold: true
  },
  working: {
    label: 'working',
    description: 'working on its turn',
    role: 'accentText',
    bold: false
  },
  finished: { label: 'finished', description: 'finished its turn', role: 'success', bold: false },
  idle: { label: 'idle', description: 'idle', role: 'mutedText', bold: false },
  exited: { label: 'exited', description: 'process exited', role: 'faintText', bold: false }
}
