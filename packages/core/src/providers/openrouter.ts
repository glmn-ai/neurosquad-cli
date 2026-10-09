// OpenRouter as a model provider for an agent: the per-harness launch recipes
// and the host attribution headers sent with every OpenRouter request.
//
// Everything is launch-time only — env vars and flags on one process. The
// user's `~/.claude`, `~/.codex/config.toml` and `opencode.json` are never
// written. The key goes into the child's environment only: never into argv,
// a log or a file. No key → no recipe: the harness runs on its own login.
//
// Attribution (https://openrouter.ai/docs/app-attribution): `HTTP-Referer` is
// the host's identity, `X-OpenRouter-Title` its display name (`X-Title` is the
// older alias, sent too), `X-OpenRouter-Categories` at most two categories.
// No `X-OpenRouter-App-Visibility` header is sent. Each recipe below was
// checked against a local server recording the headers that arrived.

/** Headers on every OpenRouter request an agent makes. Identical in the desktop app. */
export const OPENROUTER_ATTRIBUTION: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://neurosquad.ai/',
  'X-OpenRouter-Title': 'NeuroSquad',
  'X-Title': 'NeuroSquad',
  'X-OpenRouter-Categories': 'cli-agent,programming-app'
}

export const OPENROUTER_API = 'https://openrouter.ai/api/v1'
/** Claude Code appends `/v1/messages` itself — so the base is `/api`, not `/api/v1`. */
export const OPENROUTER_ANTHROPIC_BASE = 'https://openrouter.ai/api'

/** The variable an OpenRouter key is read from when none is stored. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY'

export interface ProviderLaunch {
  args: string[]
  env: Record<string, string>
}

const NONE: ProviderLaunch = { args: [], env: {} }

/** A model slug safe for argv and config (OpenRouter slugs: `vendor/model[:variant]`, `~` aliases). */
export const MODEL_ID_PATTERN = /^~?[A-Za-z0-9][\w.\-/:@+]{0,199}$/

export function normalizeModelId(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined
  const id = model.trim()
  return MODEL_ID_PATTERN.test(id) ? id : undefined
}

/**
 * Codex CLI's `openrouter` model provider as `-c` flags, without selecting it.
 * Values that do not parse as TOML are taken as literal strings, so no quotes.
 */
export function codexOpenRouterProviderArgs(apiBase: string = OPENROUTER_API): string[] {
  const p = 'model_providers.openrouter'
  return [
    '-c',
    `${p}.name=OpenRouter`,
    '-c',
    `${p}.base_url=${apiBase}`,
    '-c',
    `${p}.env_key=${OPENROUTER_KEY_ENV}`,
    // The wire API Codex supports; OpenRouter serves /responses.
    '-c',
    `${p}.wire_api=responses`,
    ...Object.entries(OPENROUTER_ATTRIBUTION).flatMap(([name, value]) => [
      '-c',
      `${p}.http_headers.${name}=${value}`
    ])
  ]
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function mergeJson(base: Json, extra: Json): Json {
  const out: Json = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key]
    out[key] = isObject(value) && isObject(current) ? mergeJson(current, value) : value
  }
  return out
}

function parseJsonObject(text: string | undefined): Json {
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * OPENCODE_CONFIG_CONTENT: the user's own (if any) plus the attribution headers on the openrouter
 * provider. With `slug`, the model is declared on the provider too: OpenCode only runs models it
 * knows, and its catalog (models.dev) lags OpenRouter's list — a new slug was "model not found".
 * A declared model that the catalog has keeps the catalog's details (the entry only adds).
 */
export function openCodeConfigWithAttribution(
  userContent?: string,
  apiBase?: string,
  slug?: string
): string {
  return JSON.stringify(
    mergeJson(parseJsonObject(userContent), {
      provider: {
        openrouter: {
          options: {
            headers: { ...OPENROUTER_ATTRIBUTION },
            ...(apiBase ? { baseURL: apiBase } : {})
          },
          ...(slug ? { models: { [slug]: {} } } : {})
        }
      }
    })
  )
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Another API base, checked: the key travels with every request, so plain
 * HTTP is accepted only to this machine (a local proxy or a recording server
 * in tests); anywhere else it must be HTTPS. Throws otherwise.
 */
export function checkedApiBase(base: string): string {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`not a URL: ${base}`)
  }
  // The base reaches argv (Codex's `-c`): credentials in it would be visible to every process.
  if (url.username || url.password) {
    throw new Error('the OpenRouter API base must not contain credentials (user:password@)')
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('the OpenRouter API base must use https (http only on this machine)')
  }
  return base.replace(/\/+$/, '')
}

/**
 * Pure: the OpenRouter recipe for one harness. No key → nothing at all (for
 * Claude Code, a base URL without a key would send its own login token to
 * openrouter.ai).
 */
export function openRouterLaunch(
  harness: string,
  key: string | undefined,
  model: string | undefined,
  options: {
    openCodeConfigContent?: string
    /**
     * Another OpenRouter-compatible base (`…/api/v1`): a proxy, or a local
     * server recording requests in tests. The public API by default.
     */
    apiBase?: string
  } = {}
): ProviderLaunch {
  if (!key) return NONE
  const slug = normalizeModelId(model)
  const apiBase = options.apiBase ? checkedApiBase(options.apiBase) : undefined
  const anthropicBase = apiBase ? apiBase.replace(/\/v1$/, '') : OPENROUTER_ANTHROPIC_BASE
  switch (harness) {
    case 'claude-code':
      return {
        args: [],
        env: {
          ANTHROPIC_BASE_URL: anthropicBase,
          // Sent as `Authorization: Bearer`.
          ANTHROPIC_AUTH_TOKEN: key,
          // Explicitly empty: a set ANTHROPIC_API_KEY goes out as `x-api-key`.
          ANTHROPIC_API_KEY: '',
          // Claude Code >= 2.1.227: `Name: Value` lines added to every request.
          ANTHROPIC_CUSTOM_HEADERS: Object.entries(OPENROUTER_ATTRIBUTION)
            .map(([name, value]) => `${name}: ${value}`)
            .join('\n'),
          ...(slug
            ? {
                ANTHROPIC_MODEL: slug,
                // Background and subagent calls on the same model.
                ANTHROPIC_DEFAULT_OPUS_MODEL: slug,
                ANTHROPIC_DEFAULT_SONNET_MODEL: slug,
                ANTHROPIC_DEFAULT_HAIKU_MODEL: slug,
                CLAUDE_CODE_SUBAGENT_MODEL: slug
              }
            : {})
        }
      }
    case 'codex-cli':
      return {
        args: [
          '-c',
          'model_provider=openrouter',
          ...codexOpenRouterProviderArgs(apiBase ?? OPENROUTER_API),
          ...(slug ? ['--model', slug] : [])
        ],
        env: { [OPENROUTER_KEY_ENV]: key }
      }
    case 'opencode':
      return {
        args: slug ? ['--model', `openrouter/${slug}`] : [],
        env: {
          [OPENROUTER_KEY_ENV]: key,
          OPENCODE_CONFIG_CONTENT: openCodeConfigWithAttribution(
            options.openCodeConfigContent,
            apiBase,
            slug
          )
        }
      }
    default:
      return NONE
  }
}

/** The harness's own model on its own login (`--model <id>`). */
export function nativeModelLaunch(harness: string, model: string | undefined): ProviderLaunch {
  const id = normalizeModelId(model)
  if (!id) return NONE
  switch (harness) {
    case 'claude-code':
    case 'codex-cli':
    case 'opencode':
      return { args: ['--model', id], env: {} }
    default:
      return NONE
  }
}

/**
 * True when `model` can only be an OpenRouter model id for this harness — on the harness's own
 * login it is "model not found". Launching it without the OpenRouter recipe is the bug this
 * guards against (a slug picked from OpenRouter's list on an agent still on its own login).
 *
 * - `~vendor/model` (OpenRouter's "latest" aliases): OpenRouter only, every harness.
 * - Claude Code: native ids have no `/` (`claude-sonnet-4-5`, `opus`, `sonnet[1m]`); the one
 *   native shape with a slash is a Bedrock ARN (`arn:aws:bedrock:…/…`).
 * - Codex: its own models have no `/` — unless the user's Codex config selects another
 *   `model_provider` (Ollama, LM Studio, their own OpenRouter entry…), whose ids may.
 * - OpenCode: native ids ARE `provider/model` (`anthropic/claude-sonnet-4-5`), so a slash says
 *   nothing; only the `~` alias is OpenRouter's.
 */
export function openRouterOnlyModel(
  harness: string,
  model: string | undefined,
  options: { codexModelProvider?: string } = {}
): boolean {
  const id = normalizeModelId(model)
  if (!id || !OPENROUTER_HARNESSES.includes(harness)) return false
  if (id.startsWith('~')) return true
  if (!id.includes('/')) return false
  switch (harness) {
    case 'claude-code':
      return !/^arn:/i.test(id)
    case 'codex-cli':
      return !options.codexModelProvider || options.codexModelProvider === 'openai'
    default:
      return false
  }
}

/** Why a launch with `model` but without OpenRouter would fail, and the fix. */
export function openRouterOnlyMessage(model: string): string {
  return `${model} is an OpenRouter model id — add --provider openrouter`
}

/** Harnesses the OpenRouter recipe supports. */
export const OPENROUTER_HARNESSES: readonly string[] = ['claude-code', 'codex-cli', 'opencode']

// ---------------------------------------------------------------------------
// OpenRouter's public JSON (`GET /api/v1/models`, `GET /api/v1/key`)

export interface OpenRouterModel {
  /** The slug the harness gets, e.g. `anthropic/claude-sonnet-4.5`. */
  id: string
  name: string
  contextLength?: number
  /** USD per 1M prompt tokens. Absent when OpenRouter prices it per request (routers, `-1`). */
  promptPerMTok?: number
  /** USD per 1M completion tokens. */
  completionPerMTok?: number
}

export interface OpenRouterModelList {
  models: OpenRouterModel[]
  /** ISO time of the fetch these came from (the cache's, when served from it). */
  fetchedAt?: string
  /** Set when the last refresh failed; `models` is then the cached list, possibly empty. */
  error?: string
}

/** `GET /api/v1/key` — what the key has spent and may still spend (USD). */
export interface OpenRouterKeyInfo {
  label?: string
  usage: number
  usageDaily?: number
  usageWeekly?: number
  usageMonthly?: number
  /** `null` = no limit on this key. */
  limit: number | null
  limitRemaining: number | null
  limitReset?: string
  isFreeTier?: boolean
}

export type OpenRouterKeyResult =
  | { ok: true; info: OpenRouterKeyInfo }
  | {
      ok: false
      error: string
      /** true = the key itself was rejected (401/403). */ unauthorized?: boolean
    }

export interface OpenRouterStatus {
  hasKey: boolean
  /** False where no OS keyring is available (a key can then only come from the environment). */
  encryptionAvailable: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined
}

/** Per-token USD price string → per-1M; negative ("-1" = variable) and garbage → undefined. */
function perMillion(value: unknown): number | undefined {
  const perToken = finiteNumber(value)
  if (perToken === undefined || perToken < 0) return undefined
  // Rounded to 1e-6 USD so 0.000003 * 1e6 prints as 3, not 2.9999999999999996.
  return Math.round(perToken * 1e6 * 1e6) / 1e6
}

/** `GET /api/v1/models` body → a clean list, sorted by name. Malformed entries are dropped. */
export function parseOpenRouterModels(json: unknown): OpenRouterModel[] {
  const data = asRecord(json)?.data
  if (!Array.isArray(data)) return []
  const models: OpenRouterModel[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    const record = asRecord(entry)
    const id = typeof record?.id === 'string' ? record.id.trim() : ''
    if (!record || !id || seen.has(id)) continue
    seen.add(id)
    const pricing = asRecord(record.pricing)
    const contextLength =
      finiteNumber(record.context_length) ??
      finiteNumber(asRecord(record.top_provider)?.context_length)
    const model: OpenRouterModel = {
      id,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id
    }
    if (contextLength !== undefined && contextLength > 0) model.contextLength = contextLength
    const prompt = perMillion(pricing?.prompt)
    const completion = perMillion(pricing?.completion)
    if (prompt !== undefined) model.promptPerMTok = prompt
    if (completion !== undefined) model.completionPerMTok = completion
    models.push(model)
  }
  return models.sort((a, b) => a.name.localeCompare(b.name))
}

/** `GET /api/v1/key` body → key info, or undefined when it is not that shape. */
export function parseOpenRouterKey(json: unknown): OpenRouterKeyInfo | undefined {
  const data = asRecord(asRecord(json)?.data)
  if (!data) return undefined
  const usage = finiteNumber(data.usage)
  if (usage === undefined) return undefined
  const info: OpenRouterKeyInfo = {
    usage,
    limit: finiteNumber(data.limit) ?? null,
    limitRemaining: finiteNumber(data.limit_remaining) ?? null
  }
  if (typeof data.label === 'string' && data.label) info.label = data.label
  const daily = finiteNumber(data.usage_daily)
  const weekly = finiteNumber(data.usage_weekly)
  const monthly = finiteNumber(data.usage_monthly)
  if (daily !== undefined) info.usageDaily = daily
  if (weekly !== undefined) info.usageWeekly = weekly
  if (monthly !== undefined) info.usageMonthly = monthly
  if (typeof data.limit_reset === 'string' && data.limit_reset) info.limitReset = data.limit_reset
  if (typeof data.is_free_tier === 'boolean') info.isFreeTier = data.is_free_tier
  return info
}

/**
 * Case-insensitive match on slug and name; every whitespace-separated word
 * must appear (so "sonnet 4.5" finds "anthropic/claude-sonnet-4.5").
 * Capped — a ListBox of ~400 rows re-renders on every keystroke otherwise.
 */
export function filterOpenRouterModels(
  models: readonly OpenRouterModel[],
  query: string,
  limit = 100
): OpenRouterModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const result: OpenRouterModel[] = []
  for (const model of models) {
    const haystack = `${model.id} ${model.name}`.toLowerCase()
    if (words.every((word) => haystack.includes(word))) {
      result.push(model)
      if (result.length >= limit) break
    }
  }
  return result
}

/** Short model label for the agent chip: the part after the vendor slash. */
export function shortModelLabel(slug: string): string {
  const withoutVariant = slug.replace(/^~/, '')
  const slash = withoutVariant.indexOf('/')
  return slash === -1 ? withoutVariant : withoutVariant.slice(slash + 1)
}
