// Custom model providers: servers the user adds — a local one (llama.cpp,
// Ollama, LM Studio, vLLM, SGLang, Unsloth Studio…) or a remote one — that
// speak the OpenAI API, the Anthropic API or both. The user never picks the
// API: the connection test (customProbe.ts) finds which endpoints the server
// has (many local servers serve both on one port), and each harness is
// offered the provider when its own endpoint is there.
//
// Pure: validation, URLs, parsing the model list, which harness can drive
// which API, and the per-harness launch recipes. Ported from the NeuroSquad
// desktop app (shared/customProviders.ts, agentTerminal/providerLaunch.ts).
//
// The key, when the provider has one, goes into the child's environment only
// (CUSTOM_PROVIDER_KEY_ENV) — never argv, a log or a file; where a CLI reads
// its key from config, the config names the variable. No OpenRouter
// attribution header is ever sent to a custom server.
import { CLAUDE_CLOUD_SWITCHES_OFF, type ProviderLaunch } from './openrouter.js'

/** The two wire APIs a custom provider can speak. */
export type CustomProviderApi = 'openai' | 'anthropic'

export const CUSTOM_PROVIDER_PROTOCOLS = ['http', 'https'] as const
export type CustomProviderProtocol = (typeof CUSTOM_PROVIDER_PROTOCOLS)[number]

/** Where the server is (and what a test request carries). No key here. */
export interface CustomProviderDraft {
  name: string
  protocol: CustomProviderProtocol
  host: string
  port: number
  /**
   * Put in front of the API's own paths, for a server that serves it under a
   * sub-path (`/api`, `/anthropic`). Empty for most local servers.
   */
  pathPrefix: string
}

/** Which endpoints the last connection test found (a server may speak more than one). */
export interface CustomProviderEndpoints {
  /** OpenAI `POST /v1/chat/completions`. */
  chat?: boolean
  /**
   * OpenAI `POST /v1/responses` — the only wire API Codex CLI still speaks.
   * Codex uses it directly when found; on a provider with only `chat`, it
   * goes through the host's Responses gateway (responsesGateway.ts).
   */
  responses?: boolean
  /** Anthropic `POST /v1/messages`. */
  messages?: boolean
}

export interface CustomModel {
  id: string
  /** A display name when the server gives one (Anthropic's `display_name`). */
  name?: string
  /**
   * The context window the server SERVES this model with (tokens), when its
   * model list says so. The harnesses do not know a local model's window —
   * Claude Code assumes 200K, Codex its fallback, OpenCode never compacts
   * without one — so a long session would overflow the server.
   */
  contextWindow?: number
}

/** A saved provider. */
export interface CustomProvider extends CustomProviderDraft {
  id: string
  models: CustomModel[]
  modelsFetchedAt: string
  endpoints: CustomProviderEndpoints
  createdAt: string
  updatedAt: string
}

export type CustomProviderTestResult =
  | {
      ok: true
      models: CustomModel[]
      /** Ids the server listed that are not chat models (embeddings) or not usable as an argument. */
      skippedModels: number
      endpoints: CustomProviderEndpoints
      latencyMs: number
    }
  | {
      ok: false
      kind:
        | 'invalid'
        | 'unreachable'
        | 'timeout'
        | 'unauthorized'
        | 'not-found'
        | 'wrong-format'
        | 'bad-response'
        | 'http'
      error: string
      status?: number
    }

/** The variable the key goes into in a harness's env (never argv). Same name as the desktop app's. */
export const CUSTOM_PROVIDER_KEY_ENV = 'NEUROSQUAD_PROVIDER_API_KEY'

/**
 * Sent when the provider has no key: most CLIs refuse to start on an empty
 * one, and Claude Code would otherwise fall back to the user's own Anthropic
 * login and send *that* token to the custom server.
 */
export const CUSTOM_PROVIDER_PLACEHOLDER_KEY = 'neurosquad-no-key'

/** A provider id: what `nsq provider add <name>` takes and `--provider <name>` names. */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
/** Ids the built-in choices use — never a custom provider's. */
export const RESERVED_PROVIDER_IDS: readonly string[] = ['openrouter', 'none', 'own', 'native']

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/
const IPV6_PATTERN = /^\[[0-9A-Fa-f:.]{2,45}\]$/
const PATH_PREFIX_PATTERN = /^(\/[A-Za-z0-9._~-]+){0,8}$/
/**
 * Model ids reach argv (`--model`). Local ids (`qwen/qwen3-coder-30b`,
 * `llama3.1:8b`, `unsloth/…-GGUF`, vLLM's `/data/models/X` when served from a
 * path) all fit — never a leading `-`.
 */
export const CUSTOM_MODEL_ID_PATTERN = /^[A-Za-z0-9/][A-Za-z0-9._:/@+-]{0,199}$/
export const CUSTOM_PROVIDER_NAME_MAX = 60
export const CUSTOM_PROVIDER_KEY_MAX = 4096

// ---------------------------------------------------------------------------
// Presets

export interface CustomProviderPreset {
  id: 'llamacpp' | 'ollama' | 'lmstudio' | 'vllm' | 'sglang' | 'unsloth'
  name: string
  /** The server's default local address. */
  url: string
}

/**
 * Each server's default address (docs/guide/providers.md has what each one
 * serves). Hints only — the connection test decides what a server speaks.
 */
export const CUSTOM_PROVIDER_PRESETS: readonly CustomProviderPreset[] = [
  { id: 'llamacpp', name: 'llama.cpp', url: 'http://127.0.0.1:8080' },
  { id: 'ollama', name: 'Ollama', url: 'http://localhost:11434' },
  { id: 'lmstudio', name: 'LM Studio', url: 'http://localhost:1234' },
  { id: 'vllm', name: 'vLLM', url: 'http://localhost:8000' },
  { id: 'sglang', name: 'SGLang', url: 'http://localhost:30000' },
  { id: 'unsloth', name: 'Unsloth Studio', url: 'http://localhost:8888' }
]

// ---------------------------------------------------------------------------
// Validation and URLs

/** Why the draft cannot be tested or saved, or `undefined` when it is fine. */
export function customProviderDraftProblem(draft: unknown): string | undefined {
  if (!draft || typeof draft !== 'object') return 'No provider given.'
  const d = draft as Partial<CustomProviderDraft>
  const name = typeof d.name === 'string' ? d.name.trim() : ''
  if (!name) return 'Give the provider a name.'
  if (name.length > CUSTOM_PROVIDER_NAME_MAX)
    return `The name is longer than ${CUSTOM_PROVIDER_NAME_MAX} characters.`
  if (!(CUSTOM_PROVIDER_PROTOCOLS as readonly unknown[]).includes(d.protocol))
    return 'The protocol is http or https.'
  const host = typeof d.host === 'string' ? d.host.trim() : ''
  if (!host) return 'Enter a host.'
  if (!HOSTNAME_PATTERN.test(host) && !IPV6_PATTERN.test(host)) {
    return 'The host is a name or an IP address only — no scheme, port or path.'
  }
  if (typeof d.port !== 'number' || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    return 'The port is a number from 1 to 65535.'
  }
  const prefix = typeof d.pathPrefix === 'string' ? d.pathPrefix.trim() : ''
  if (!PATH_PREFIX_PATTERN.test(prefix)) {
    return 'The path starts with / and has letters, digits and . _ ~ - only (or leave it empty).'
  }
  return undefined
}

/** The draft with trimmed fields — only call after `customProviderDraftProblem` said it is fine. */
export function normalizeCustomProviderDraft(draft: CustomProviderDraft): CustomProviderDraft {
  return {
    name: draft.name.trim(),
    protocol: draft.protocol,
    host: draft.host.trim(),
    port: draft.port,
    pathPrefix: draft.pathPrefix.trim()
  }
}

/** API paths people paste along with the base; the base is what is left. */
const API_SUFFIX = /\/v1(?:\/(?:chat\/completions|completions|responses|messages|models))?\/?$/i

/**
 * A base URL as the user types it → a draft. `http://localhost:1234`,
 * `http://localhost:11434/v1`, `https://api.example.com/anthropic`, even a
 * pasted `…/v1/chat/completions` — the `/v1…` part is dropped (each harness
 * adds its own). No scheme: `http` for a local host, `https` otherwise.
 * Throws with the reason when it is not a usable address. The transport
 * policy (http only on this machine or the local network) is separate:
 * `customProviderTransportProblem`.
 */
export function parseCustomProviderUrl(name: string, input: string): CustomProviderDraft {
  const raw = input.trim()
  if (!raw) throw new Error('Enter the server address, e.g. http://localhost:1234')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `${isLocalHost(raw.replace(/[:/].*$/, '')) ? 'http' : 'https'}://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`Not a URL: ${raw}`)
  }
  const protocol = url.protocol.replace(/:$/, '')
  if (protocol !== 'http' && protocol !== 'https') throw new Error('The address is http or https.')
  // The key travels with every request; credentials in the URL would reach argv and logs.
  if (url.username || url.password)
    throw new Error('Put no user:password@ in the address — a key is given separately.')
  if (url.search || url.hash)
    throw new Error('The address has no ?query or #fragment — just scheme, host, port and path.')
  const pathPrefix = decodeURIComponent(url.pathname).replace(/\/+$/, '').replace(API_SUFFIX, '')
  const draft: CustomProviderDraft = {
    name,
    protocol,
    host: url.hostname,
    port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80,
    pathPrefix: pathPrefix.replace(/\/+$/, '')
  }
  const problem = customProviderDraftProblem(draft)
  if (problem) throw new Error(problem)
  return normalizeCustomProviderDraft(draft)
}

/** `http://localhost:1234` + the path prefix — no trailing slash. */
export function customProviderOrigin(p: CustomProviderDraft): string {
  const defaultPort = p.protocol === 'https' ? 443 : 80
  const port = p.port === defaultPort ? '' : `:${p.port}`
  return `${p.protocol}://${p.host}${port}${p.pathPrefix}`
}

/**
 * The base URL a harness gets, in each API's own convention:
 * OpenAI clients append `/chat/completions` to a base that ends in `/v1`;
 * Anthropic clients (Claude Code's ANTHROPIC_BASE_URL) append `/v1/messages`.
 */
export function customProviderBaseUrl(p: CustomProviderDraft, api: CustomProviderApi): string {
  const origin = customProviderOrigin(p)
  return api === 'openai' ? `${origin}/v1` : origin
}

/** Where the connection test lists the models: `GET /v1/models` in both APIs. */
export function customProviderModelsUrl(p: CustomProviderDraft): string {
  return `${customProviderOrigin(p)}/v1/models`
}

/** A short "where": `localhost:1234`, `api.example.com/anthropic`. */
export function customProviderAddress(p: CustomProviderDraft): string {
  const defaultPort = p.protocol === 'https' ? 443 : 80
  return `${p.host}${p.port === defaultPort ? '' : `:${p.port}`}${p.pathPrefix}`
}

/** This machine: `localhost`, `*.localhost`, 127.0.0.0/8, ::1. */
/** A dotted-quad IPv4 literal → its four octets, else undefined (`127.example.com` is a name). */
function ipv4(host: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return undefined
  const octets = match.slice(1).map(Number)
  return octets.every((octet) => octet <= 255) ? octets : undefined
}

/** This machine: exactly `localhost`, a 127.0.0.0/8 literal, or ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || ipv4(h)?.[0] === 127
}

/**
 * Loopback or the local network: RFC 1918 and link-local IPv4 literals, IPv6
 * unique-local/link-local, `*.localhost`, mDNS `.local` names, and
 * single-label names (`gpu-box` — no public DNS name has no dot). Names are
 * "local" for the warning, never for loopback trust.
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (isLoopbackHost(h)) return true
  const ip = ipv4(h)
  if (ip) {
    const [a, b] = ip as [number, number]
    return (
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    )
  }
  return (
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe[89ab][0-9a-f]:/.test(h) ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.lan') ||
    h.endsWith('.home.arpa') ||
    /^[a-z0-9-]+$/.test(h)
  )
}

/** How a provider is reached: what the key and the code cross on the way. */
export type CustomProviderTransport = 'https' | 'http-loopback' | 'http-lan' | 'http-remote'

export function customProviderTransport(p: CustomProviderDraft): CustomProviderTransport {
  if (p.protocol === 'https') return 'https'
  if (isLoopbackHost(p.host)) return 'http-loopback'
  return isLocalHost(p.host) ? 'http-lan' : 'http-remote'
}

/**
 * Plain http is refused past the local network: the key and every prompt
 * (the code the agent reads) would cross the internet unencrypted.
 */
export function customProviderTransportProblem(p: CustomProviderDraft): string | undefined {
  return customProviderTransport(p) === 'http-remote'
    ? `http://${p.host} is not on this machine or the local network — use https (the key and the code would cross the internet unencrypted).`
    : undefined
}

/** A warning for plain http on the local network (fine on this machine). */
export function customProviderTransportWarning(p: CustomProviderDraft): string | undefined {
  return customProviderTransport(p) === 'http-lan'
    ? `plain http to ${p.host}: the prompts, the code the agent reads and any key cross the local network unencrypted`
    : undefined
}

/** Why the key cannot be stored, or `undefined`. */
export function customProviderKeyProblem(key: string): string | undefined {
  if (key.length > CUSTOM_PROVIDER_KEY_MAX) return 'The key is too long.'
  // It goes into an HTTP header and a child's environment.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key))
    return 'The key cannot contain line breaks or control characters.'
  return undefined
}

// ---------------------------------------------------------------------------
// Model list

/** Plausible context windows only: 1K … 16M tokens, an integer. */
function contextTokens(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 16_777_216
    ? n
    : undefined
}

/**
 * A model entry's served context window, from the fields servers use for it:
 * `meta.n_ctx` (llama.cpp), `max_model_len` (vLLM, SGLang),
 * `loaded_context_length` (LM Studio's native list), `context_length`
 * (OpenRouter-style lists), `max_context_length`, `context_window`. Not
 * `n_ctx_train` — the training window, not what the server was started with.
 */
export function parseContextWindow(item: Record<string, unknown>): number | undefined {
  const meta =
    item.meta && typeof item.meta === 'object' ? (item.meta as Record<string, unknown>) : {}
  return (
    contextTokens(meta.n_ctx) ??
    contextTokens(item.max_model_len) ??
    contextTokens(item.loaded_context_length) ??
    contextTokens(item.context_length) ??
    contextTokens(item.max_context_length) ??
    contextTokens(item.context_window)
  )
}

/** A model the harness cannot use for chat (embedding models are listed by LM Studio and Ollama). */
function isEmbeddingModel(id: string): boolean {
  return /(^|[-_/.:])(text-)?embed(ding)?s?([-_/.:]|$)|embedding/i.test(id)
}

/**
 * `GET /v1/models` body → the chat models, sorted by id. Both APIs answer
 * `{ data: [{ id, … }] }` (OpenAI's `object: "model"`, Anthropic's
 * `display_name`); Ollama's native `{ models: [{ name }] }` is read too.
 */
export function parseCustomModels(
  json: unknown
): { models: CustomModel[]; skipped: number } | undefined {
  if (!json || typeof json !== 'object') return undefined
  const record = json as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : undefined
  if (!list) return undefined
  const models: CustomModel[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const raw =
      typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : ''
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (!CUSTOM_MODEL_ID_PATTERN.test(id) || isEmbeddingModel(id)) {
      skipped++
      continue
    }
    const display = typeof item.display_name === 'string' ? item.display_name.trim() : ''
    const contextWindow = parseContextWindow(item)
    models.push({
      id,
      ...(display && display !== id ? { name: display.slice(0, 120) } : {}),
      ...(contextWindow ? { contextWindow } : {})
    })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return { models, skipped }
}

/** Case-insensitive: every whitespace-separated word must appear in the id or name. */
export function filterCustomModels(
  models: readonly CustomModel[],
  query: string,
  limit = 200
): CustomModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const out: CustomModel[] = []
  for (const model of models) {
    const haystack = `${model.id} ${model.name ?? ''}`.toLowerCase()
    if (words.every((word) => haystack.includes(word))) {
      out.push(model)
      if (out.length >= limit) break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Which harness runs on which provider

/** Which APIs the server speaks, from the endpoints its test found. */
export function customProviderApis(endpoints: CustomProviderEndpoints): CustomProviderApi[] {
  return [
    ...(endpoints.chat === true ? (['openai'] as const) : []),
    ...(endpoints.messages === true ? (['anthropic'] as const) : [])
  ]
}

const CUSTOM_HARNESS_NEEDS: Record<
  string,
  { fits: (e: CustomProviderEndpoints) => boolean; needs: string }
> = {
  // Claude Code speaks only the Anthropic Messages API.
  'claude-code': {
    fits: (e) => e.messages === true,
    needs: 'Claude Code speaks only the Anthropic Messages API (POST /v1/messages)'
  },
  // Codex has no Chat Completions client any more — Responses API only: its
  // own /v1/responses when the server has one, otherwise the host's loopback
  // gateway translates to /v1/chat/completions (responsesGateway.ts).
  'codex-cli': {
    fits: (e) => e.responses === true || e.chat === true,
    needs:
      'Codex needs the OpenAI Responses API (POST /v1/responses) or chat completions (POST /v1/chat/completions, through nsq’s gateway)'
  },
  // OpenCode takes either (an AI SDK package per API).
  opencode: {
    fits: (e) => e.chat === true || e.messages === true,
    needs:
      'OpenCode needs OpenAI chat completions (POST /v1/chat/completions) or the Anthropic Messages API (POST /v1/messages)'
  }
}

/** Every harness that can use some custom provider. */
export const CUSTOM_PROVIDER_HARNESSES: readonly string[] = Object.keys(CUSTOM_HARNESS_NEEDS)

/** Whether `harness` can run on this provider: the endpoint it needs was found by the test. */
export function harnessSupportsCustomProvider(
  harness: string,
  provider: Pick<CustomProvider, 'endpoints'>
): boolean {
  return CUSTOM_HARNESS_NEEDS[harness]?.fits(provider.endpoints ?? {}) === true
}

/** Why `harness` cannot run on this provider, or `undefined` when it can. */
export function customProviderHarnessProblem(
  harness: string,
  provider: Pick<CustomProvider, 'endpoints' | 'name'>
): string | undefined {
  const need = CUSTOM_HARNESS_NEEDS[harness]
  if (!need) return `${harness} cannot run on a custom provider`
  if (need.fits(provider.endpoints ?? {})) return undefined
  const found = [
    provider.endpoints.chat ? 'chat completions' : '',
    provider.endpoints.responses ? 'responses' : '',
    provider.endpoints.messages ? 'messages' : ''
  ].filter(Boolean)
  return `${need.needs}; ${provider.name} serves ${found.length ? found.join(', ') : 'none of them'}`
}

/** Whether a Codex agent on this provider has to go through the Responses gateway. */
export function codexNeedsResponsesGateway(provider: Pick<CustomProvider, 'endpoints'>): boolean {
  return provider.endpoints.responses !== true && provider.endpoints.chat === true
}

// ---------------------------------------------------------------------------
// Recipes

/** The provider id OpenCode knows a custom provider by (`--model <id>/<model>`). */
export const OPENCODE_CUSTOM_PROVIDER_ID = 'neurosquad-custom'
/** Codex's `model_providers.<id>` for a custom provider. */
export const CODEX_CUSTOM_PROVIDER_ID = 'neurosquad-custom'

/** The context window the server serves `model` with, when its model list said. */
export function customModelContextWindow(
  provider: Pick<CustomProvider, 'models'>,
  model: string | undefined
): number | undefined {
  return model ? provider.models.find((entry) => entry.id === model)?.contextWindow : undefined
}

/**
 * What a CLI may ask for as output on a server of `window` tokens: its usual
 * 32K, but never more than a quarter of the window (prompt + max tokens must
 * fit, and servers reject — not truncate — a request that does not).
 */
export function customOutputBudget(window: number): number {
  return Math.min(32_000, Math.floor(window / 4))
}

/** A model id safe for argv and config, or undefined. */
export function safeCustomModelId(model: string | undefined): string | undefined {
  const id = model?.trim()
  return id && CUSTOM_MODEL_ID_PATTERN.test(id) ? id : undefined
}

export interface CustomProviderLaunchOptions {
  /** The user's own OPENCODE_CONFIG_CONTENT, if they set one — merged, not replaced. */
  openCodeConfigContent?: string
  /**
   * A Codex agent on a provider without `/v1/responses`: the host's loopback
   * Responses gateway for this agent — its base URL and the agent's
   * credential there (not the provider's key).
   */
  codexGateway?: { baseUrl: string; key: string }
}

const NONE: ProviderLaunch = { args: [], env: {} }

/**
 * Codex's own window for a model it has no metadata for: the served window
 * and an auto-compact limit at 85% of it.
 */
function codexContextArgs(window: number | undefined): string[] {
  if (!window) return []
  return [
    '-c',
    `model_context_window=${window}`,
    '-c',
    `model_auto_compact_token_limit=${Math.floor(window * 0.85)}`
  ]
}

/** The provider's name for Codex's status line, when it is a plain word (it reaches argv). */
function codexProviderName(name: string): string {
  const plain = /^[A-Za-z0-9][\w.-]{0,59}$/.test(name) ? name : 'custom'
  // Codex parses each `-c` value as TOML: a bare `4090`, `true` or `1e5` would be a number or a
  // boolean (and fail the string field) — always a quoted TOML string.
  return `"${plain.replace(/[\\"]/g, (char) => `\\${char}`)}"`
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

/** OPENCODE_CONFIG_CONTENT: the user's own (if any) plus the custom provider. */
export function openCodeConfigWithCustomProvider(
  provider: CustomProvider,
  model: string | undefined,
  userContent?: string
): string {
  // Chat Completions when the server has it (the most tried path on local
  // servers), otherwise its Anthropic endpoint.
  const isAnthropic = provider.endpoints.chat !== true
  const models: Json = {}
  for (const entry of provider.models) {
    // OpenCode compacts only when it knows the window (limit.context 0 =
    // never), and asks for limit.output tokens of output.
    models[entry.id] = {
      name: entry.name ?? entry.id,
      ...(entry.contextWindow
        ? {
            limit: {
              context: entry.contextWindow,
              output: customOutputBudget(entry.contextWindow)
            }
          }
        : {})
    }
  }
  if (model && !(model in models)) models[model] = { name: model }
  const base = customProviderBaseUrl(provider, isAnthropic ? 'anthropic' : 'openai')
  return JSON.stringify(
    mergeJson(parseJsonObject(userContent), {
      provider: {
        [OPENCODE_CUSTOM_PROVIDER_ID]: {
          npm: isAnthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
          name: provider.name,
          options: {
            // @ai-sdk/anthropic's baseURL ends in /v1 (it appends /messages).
            baseURL: isAnthropic ? `${base}/v1` : base,
            // By reference: the key stays in the env, not in this variable's text.
            apiKey: `{env:${CUSTOM_PROVIDER_KEY_ENV}}`
          },
          models
        }
      }
    })
  )
}

/**
 * Pure: the recipe for one harness on one of the user's custom providers.
 * Nothing when the harness cannot speak the provider's API, or when Codex
 * needs the gateway and none is given — the host refuses the start then
 * (never the harness's own login, which would send the code elsewhere).
 *
 * The key (if the provider has one) goes into the env only; a provider
 * without one still gets a placeholder where the CLI needs a key at all —
 * for Claude Code that is what keeps the user's own Anthropic login token
 * from being sent to the custom server.
 */
export function customProviderLaunch(
  harness: string,
  provider: CustomProvider,
  key: string | undefined,
  modelId: string | undefined,
  options: CustomProviderLaunchOptions = {}
): ProviderLaunch {
  if (!harnessSupportsCustomProvider(harness, provider)) return NONE
  // It reaches argv (`--model`).
  const model = safeCustomModelId(modelId)
  const token = key || CUSTOM_PROVIDER_PLACEHOLDER_KEY
  const contextWindow = customModelContextWindow(provider, model)

  switch (harness) {
    case 'claude-code':
      return {
        args: [],
        env: {
          ...CLAUDE_CLOUD_SWITCHES_OFF,
          ANTHROPIC_BASE_URL: customProviderBaseUrl(provider, 'anthropic'),
          // `Authorization: Bearer` — and, being set, it keeps Claude Code
          // off the user's own login for this process.
          ANTHROPIC_AUTH_TOKEN: token,
          // Explicitly empty: a set ANTHROPIC_API_KEY goes out as `x-api-key`.
          ANTHROPIC_API_KEY: '',
          ...(model
            ? {
                ANTHROPIC_MODEL: model,
                // Aliases and subagents on the same model: a local server has
                // no `claude-haiku-*` for Claude Code's background calls.
                ANTHROPIC_DEFAULT_OPUS_MODEL: model,
                ANTHROPIC_DEFAULT_SONNET_MODEL: model,
                ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
                CLAUDE_CODE_SUBAGENT_MODEL: model
              }
            : {}),
          // Claude Code assumes 200K for a model it does not know and asks
          // for 32K of output: on a smaller server it overflows mid-session.
          ...(contextWindow
            ? {
                CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow),
                CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(customOutputBudget(contextWindow))
              }
            : {})
        }
      }
    case 'codex-cli': {
      // A model provider of our own id, defined and selected with `-c` (the
      // session-flags layer — config.toml is not written). Responses API only.
      const p = `model_providers.${CODEX_CUSTOM_PROVIDER_ID}`
      if (provider.endpoints.responses !== true) {
        // Chat Completions only: Codex talks to the host's loopback Responses
        // gateway, which calls the provider with the real key. Codex's "key"
        // is the agent's credential at the gateway.
        const gateway = options.codexGateway
        if (!gateway) return NONE
        return {
          args: [
            '-c',
            `model_provider=${CODEX_CUSTOM_PROVIDER_ID}`,
            '-c',
            `${p}.name=${codexProviderName(provider.name)}`,
            '-c',
            `${p}.base_url=${gateway.baseUrl}`,
            '-c',
            `${p}.wire_api=responses`,
            '-c',
            `${p}.env_key=${CUSTOM_PROVIDER_KEY_ENV}`,
            ...(model ? ['--model', model] : []),
            ...codexContextArgs(contextWindow)
          ],
          env: { [CUSTOM_PROVIDER_KEY_ENV]: gateway.key }
        }
      }
      return {
        args: [
          '-c',
          `model_provider=${CODEX_CUSTOM_PROVIDER_ID}`,
          '-c',
          `${p}.name=${codexProviderName(provider.name)}`,
          '-c',
          `${p}.base_url=${customProviderBaseUrl(provider, 'openai')}`,
          '-c',
          `${p}.wire_api=responses`,
          // No key → no env_key at all: Codex then sends no Authorization.
          ...(key ? ['-c', `${p}.env_key=${CUSTOM_PROVIDER_KEY_ENV}`] : []),
          ...(model ? ['--model', model] : []),
          ...codexContextArgs(contextWindow)
        ],
        env: key ? { [CUSTOM_PROVIDER_KEY_ENV]: key } : {}
      }
    }
    case 'opencode':
      // An inline provider in OPENCODE_CONFIG_CONTENT (merged over the
      // agent's OPENCODE_CONFIG and the user's own config files), through the
      // AI SDK package for the provider's API.
      return {
        args: model ? ['--model', `${OPENCODE_CUSTOM_PROVIDER_ID}/${model}`] : [],
        env: {
          [CUSTOM_PROVIDER_KEY_ENV]: token,
          OPENCODE_CONFIG_CONTENT: openCodeConfigWithCustomProvider(
            provider,
            model,
            options.openCodeConfigContent
          )
        }
      }
    default:
      return NONE
  }
}

/**
 * Why an agent cannot start on this provider, or `undefined`. A host refuses
 * such a start instead of falling back to the harness's own login — an agent
 * set to a local server must never send its code to the cloud.
 */
export function customProviderLaunchProblem(
  harness: string,
  provider: CustomProvider | undefined,
  options: { providerId?: string; codexGateway?: boolean } = {}
): string | undefined {
  if (!provider)
    return `the provider ${options.providerId ?? ''} no longer exists`.replace('  ', ' ')
  const problem = customProviderHarnessProblem(harness, provider)
  if (problem) return problem
  if (harness === 'codex-cli' && codexNeedsResponsesGateway(provider) && !options.codexGateway) {
    return `${provider.name} has no /v1/responses and the Responses gateway is not running`
  }
  return undefined
}
