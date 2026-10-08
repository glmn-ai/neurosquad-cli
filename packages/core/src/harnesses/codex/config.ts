// What the host reads from the user's own Codex config
// — read, never written: `$CODEX_HOME/config.toml` (default ~/.codex).
//
// Three facts, each the user's own choice that a agent has to respect:
// - the default model (Squad agent),
// - whether approvals go to Codex's automatic reviewer (then a
//   `PermissionRequest` hook is not "waiting for you" — codexHooks.ts),
// - which of their own model providers point at OpenRouter, so a agent that
//   talks to OpenRouter on the user's own login still carries NeuroSquad's
//   attribution headers.
//
// A small TOML reader rather than a dependency: tables, dotted and quoted
// keys, strings, numbers, booleans, arrays and inline tables — what a Codex
// config holds. Arrays of tables (`[[x]]`) are skipped; nothing read here
// lives in one.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Toml = { [key: string]: unknown }

/** `$CODEX_HOME`, else ~/.codex (codex-rs/utils/home-dir). */
export function codexHome(): string {
  return process.env['CODEX_HOME'] || join(homedir(), '.codex')
}

class Reader {
  i = 0
  constructor(readonly s: string) {}

  ws(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i]
      if (c === ' ' || c === '\t') this.i++
      else if (c === '#') while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++
      else break
    }
  }

  /** Whitespace, newlines and comments — inside arrays and inline tables. */
  gap(): void {
    for (;;) {
      this.ws()
      if (this.s[this.i] === '\n' || this.s[this.i] === '\r') this.i++
      else return
    }
  }

  key(): string[] {
    const parts: string[] = []
    for (;;) {
      this.ws()
      const c = this.s[this.i]
      if (c === '"' || c === "'") parts.push(this.string())
      else {
        const start = this.i
        while (this.i < this.s.length && /[A-Za-z0-9_-]/.test(this.s[this.i])) this.i++
        if (start === this.i) throw new Error(`bad key at ${this.i}`)
        parts.push(this.s.slice(start, this.i))
      }
      this.ws()
      if (this.s[this.i] !== '.') return parts
      this.i++
    }
  }

  string(): string {
    const quote = this.s[this.i]
    const multi = this.s.startsWith(quote.repeat(3), this.i)
    this.i += multi ? 3 : 1
    if (multi && this.s[this.i] === '\n') this.i++
    else if (multi && this.s.startsWith('\r\n', this.i)) this.i += 2
    let out = ''
    for (;;) {
      if (this.i >= this.s.length) throw new Error('unterminated string')
      if (multi ? this.s.startsWith(quote.repeat(3), this.i) : this.s[this.i] === quote) {
        this.i += multi ? 3 : 1
        return out
      }
      const c = this.s[this.i++]
      if (c === '\\' && quote === '"') {
        const e = this.s[this.i++]
        const simple: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          b: '\b',
          f: '\f',
          '"': '"',
          '\\': '\\'
        }
        if (e in simple) out += simple[e]
        else if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8
          out += String.fromCodePoint(parseInt(this.s.slice(this.i, this.i + len), 16))
          this.i += len
        } else if (multi && (e === '\n' || e === '\r' || e === ' ')) {
          while (/\s/.test(this.s[this.i] ?? '')) this.i++
        } else throw new Error('bad escape')
      } else out += c
    }
  }

  value(): unknown {
    this.ws()
    const c = this.s[this.i]
    if (c === '"' || c === "'") return this.string()
    if (c === '[') {
      this.i++
      const out: unknown[] = []
      for (;;) {
        this.gap()
        if (this.s[this.i] === ']') {
          this.i++
          return out
        }
        out.push(this.value())
        this.gap()
        if (this.s[this.i] === ',') this.i++
      }
    }
    if (c === '{') {
      this.i++
      const out: Toml = {}
      for (;;) {
        this.gap()
        if (this.s[this.i] === '}') {
          this.i++
          return out
        }
        const key = this.key()
        this.ws()
        if (this.s[this.i++] !== '=') throw new Error('expected =')
        assign(out, key, this.value())
        this.gap()
        if (this.s[this.i] === ',') this.i++
      }
    }
    const start = this.i
    while (this.i < this.s.length && !/[\s,\]}#]/.test(this.s[this.i])) this.i++
    const word = this.s.slice(start, this.i)
    if (word === 'true') return true
    if (word === 'false') return false
    const number = Number(word.replaceAll('_', ''))
    return Number.isFinite(number) ? number : word
  }
}

function assign(target: Toml, path: string[], value: unknown): void {
  let at = target
  for (const part of path.slice(0, -1)) {
    const next = at[part]
    if (!next || typeof next !== 'object' || Array.isArray(next)) at[part] = {}
    at = at[part] as Toml
  }
  at[path[path.length - 1]] = value
}

/** Parses a TOML document; null when it is not one this reader understands. */
export function parseToml(text: string): Toml | null {
  const root: Toml = {}
  let table = root
  const reader = new Reader(text.replace(/^\uFEFF/, ''))
  try {
    while (reader.i < reader.s.length) {
      reader.gap()
      if (reader.i >= reader.s.length) break
      if (reader.s[reader.i] === '[') {
        if (reader.s[reader.i + 1] === '[') {
          // An array of tables: skip it and its body up to the next header.
          table = {}
          while (reader.i < reader.s.length && reader.s[reader.i] !== '\n') reader.i++
          continue
        }
        reader.i++
        const path = reader.key()
        reader.ws()
        if (reader.s[reader.i++] !== ']') throw new Error('expected ]')
        table = root
        for (const part of path) {
          const next = table[part]
          if (!next || typeof next !== 'object' || Array.isArray(next)) table[part] = {}
          table = table[part] as Toml
        }
        continue
      }
      const key = reader.key()
      reader.ws()
      if (reader.s[reader.i++] !== '=') throw new Error('expected =')
      assign(table, key, reader.value())
      reader.ws()
    }
    return root
  } catch {
    return null
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined
const table = (value: unknown): Toml | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Toml) : undefined

export interface CodexUserConfig {
  /** `model`, from the selected profile if it sets one. */
  model?: string
  /** `approvals_reviewer` in effect ("user" | "auto_review" | …). */
  approvalsReviewer?: string
  /** Ids of the user's `model_providers` whose `base_url` is OpenRouter's. */
  openRouterProviderIds: string[]
  /** Every id the user's `model_providers` defines. */
  providerIds: string[]
}

/** Pure: the facts above from a parsed config. */
export function codexUserConfigFrom(config: Toml | null): CodexUserConfig {
  if (!config) return { openRouterProviderIds: [], providerIds: [] }
  const profileName = str(config.profile)
  const profile = profileName ? table(table(config.profiles)?.[profileName]) : undefined
  const providers = table(config.model_providers) ?? {}
  const openRouterProviderIds = Object.entries(providers)
    .filter(([id, entry]) => {
      const base = str(table(entry)?.base_url)
      // A provider id with a dot could not be addressed by a `-c` path.
      return (
        !id.includes('.') && base !== undefined && /(^|\/\/|\.)openrouter\.ai(\/|:|$)/i.test(base)
      )
    })
    .map(([id]) => id)
  const model = str(profile?.model) ?? str(config.model)
  const approvalsReviewer = str(profile?.approvals_reviewer) ?? str(config.approvals_reviewer)
  return {
    ...(model ? { model } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    openRouterProviderIds,
    providerIds: Object.keys(providers)
  }
}

const CACHE_MS = 10_000
let cache: { at: number; home: string; value: CodexUserConfig } | null = null

/** The user's Codex config, re-read at most every 10 s. Never throws. */
export function readCodexUserConfig(home = codexHome()): CodexUserConfig {
  if (cache && cache.home === home && Date.now() - cache.at < CACHE_MS) return cache.value
  let text: string | undefined
  try {
    text = readFileSync(join(home, 'config.toml'), 'utf-8')
  } catch {
    text = undefined
  }
  const value = codexUserConfigFrom(text === undefined ? null : parseToml(text))
  cache = { at: Date.now(), home, value }
  return value
}
