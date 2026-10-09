// The user's own model providers (`nsq provider add …`): local servers —
// llama.cpp, Ollama, LM Studio, vLLM, SGLang, Unsloth Studio — or remote
// OpenAI/Anthropic-compatible APIs. The logic is @neurosquad/core's
// (providers/custom.ts, customProbe.ts); this file stores them.
//
// `providers.json` in the nsq home holds the address, the endpoints and the
// models the last test found — no secret. A provider's key, when it has one,
// is in the OS keyring (`provider:<id>:api-key`), read only by the daemon at
// launch (straight into the harness's env) and by the connection test. The
// CLI, the dashboard and the daemon all read the same file.
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  RESERVED_PROVIDER_IDS,
  customProviderDraftProblem,
  customProviderKeyProblem,
  customProviderOrigin,
  customProviderTransportProblem,
  fetchCustomProviderModels,
  parseCustomProviderUrl,
  readJsonFile,
  testCustomProvider,
  writeFileAtomic,
  type CustomModel,
  type CustomProvider,
  type CustomProviderTestResult
} from '@neurosquad/core'
import { join } from 'node:path'
import { ensureDir, paths } from './paths.js'
import { getSecret, setSecret } from './daemon/secrets.js'

const MAX_PROVIDERS = 50

export const providersFile = (): string => join(paths.home(), 'providers.json')

/** The keyring entry of a provider's key. */
export const providerKeySecret = (id: string): string => `provider:${id}:api-key`

function valid(entry: unknown): entry is CustomProvider {
  if (!entry || typeof entry !== 'object') return false
  const record = entry as CustomProvider
  return (
    typeof record.id === 'string' &&
    CUSTOM_PROVIDER_ID_PATTERN.test(record.id) &&
    !customProviderDraftProblem(record) &&
    Array.isArray(record.models) &&
    !!record.endpoints &&
    typeof record.endpoints === 'object'
  )
}

/** Every stored provider (read fresh: the CLI, the dashboard and the daemon share the file). */
export function listProviders(): CustomProvider[] {
  try {
    const parsed = readJsonFile(providersFile()) as { providers?: unknown[] }
    return (parsed.providers ?? []).filter(valid)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || error instanceof SyntaxError) return []
    throw error
  }
}

export function getProvider(id: string | undefined): CustomProvider | undefined {
  if (!id) return undefined
  const lower = id.toLowerCase()
  return listProviders().find((provider) => provider.id === lower)
}

function writeAll(providers: CustomProvider[]): void {
  ensureDir(paths.home())
  writeFileAtomic(providersFile(), `${JSON.stringify({ version: 1, providers }, null, 2)}\n`)
}

/** The variable a provider's key may come from where no keyring is available: `NSQ_PROVIDER_KEY_LMSTUDIO`. */
export const providerKeyEnv = (id: string): string =>
  `NSQ_PROVIDER_KEY_${id.toUpperCase().replace(/-/g, '_')}`

/** The provider's key: the keyring first, then `NSQ_PROVIDER_KEY_<ID>` in the environment. */
export async function providerKey(id: string): Promise<string | undefined> {
  const stored = await getSecret(providerKeySecret(id))
  if (stored) return stored
  const fromEnv = process.env[providerKeyEnv(id)]?.trim()
  return fromEnv || undefined
}

/** Why `name` cannot be a provider id, or undefined. */
export function providerNameProblem(name: string): string | undefined {
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(name))
    return 'a provider name is lowercase letters, digits and - (up to 40), e.g. lmstudio'
  if (RESERVED_PROVIDER_IDS.includes(name)) return `"${name}" is reserved`
  return undefined
}

export type KeyChange = { set: string } | 'keep' | 'clear'

export type SaveResult =
  | { ok: true; provider: CustomProvider; test: Extract<CustomProviderTestResult, { ok: true }> }
  | { ok: false; error: string; test?: CustomProviderTestResult }

/**
 * Adds or replaces a provider. The connection test runs first: a server that
 * does not answer, rejects the key or speaks neither API is not stored.
 * `url`: undefined keeps the stored address (re-test).
 */
export async function saveProvider(
  name: string,
  url: string | undefined,
  keyChange: KeyChange
): Promise<SaveResult> {
  const id = name.trim().toLowerCase()
  const nameProblem = providerNameProblem(id)
  if (nameProblem) return { ok: false, error: nameProblem }
  const existing = getProvider(id)
  if (!existing && url === undefined) return { ok: false, error: `no provider "${id}"` }
  if (!existing && listProviders().length >= MAX_PROVIDERS)
    return { ok: false, error: `at most ${MAX_PROVIDERS} providers` }
  let draft
  try {
    draft = url === undefined ? existing! : parseCustomProviderUrl(id, url)
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
  const transport = customProviderTransportProblem(draft)
  if (transport) return { ok: false, error: transport }
  // A stored key belongs to the address it was given for: never sent to a new one.
  const moved = !!existing && customProviderOrigin(existing) !== customProviderOrigin(draft)
  if (moved && keyChange === 'keep') keyChange = 'clear'
  const key =
    keyChange === 'clear'
      ? undefined
      : keyChange === 'keep'
        ? await providerKey(id)
        : keyChange.set.trim() || undefined
  if (key) {
    const problem = customProviderKeyProblem(key)
    if (problem) return { ok: false, error: problem }
  }
  const test = await testCustomProvider(draft, key)
  if (!test.ok) return { ok: false, error: test.error, test }
  const now = new Date().toISOString()
  const provider: CustomProvider = {
    name: id,
    protocol: draft.protocol,
    host: draft.host,
    port: draft.port,
    pathPrefix: draft.pathPrefix,
    id,
    models: test.models,
    modelsFetchedAt: now,
    endpoints: test.endpoints,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  try {
    if (keyChange === 'clear') await setSecret(providerKeySecret(id), undefined)
    else if (typeof keyChange === 'object' && key) await setSecret(providerKeySecret(id), key)
  } catch (error) {
    return {
      ok: false,
      error: `${(error as Error).message} (or give the key as ${providerKeyEnv(id)} in nsq's environment)`
    }
  }
  const others = listProviders().filter((entry) => entry.id !== id)
  writeAll(
    existing ? listProviders().map((e) => (e.id === id ? provider : e)) : [...others, provider]
  )
  return { ok: true, provider, test }
}

/** Removes a provider and its key. False when there was none. */
export async function removeProvider(name: string): Promise<boolean> {
  const id = name.trim().toLowerCase()
  const all = listProviders()
  if (!all.some((provider) => provider.id === id)) return false
  writeAll(all.filter((provider) => provider.id !== id))
  await setSecret(providerKeySecret(id), undefined).catch(() => undefined)
  return true
}

/** The provider's models — asked from the server now, stored; the stored list when it does not answer. */
export async function providerModels(
  name: string
): Promise<{ models: CustomModel[]; error?: string }> {
  const provider = getProvider(name)
  if (!provider) return { models: [], error: `no provider "${name}"` }
  try {
    const models = await fetchCustomProviderModels(provider, await providerKey(provider.id))
    const current = getProvider(provider.id)
    // Edited meanwhile (another address): that answer is another server's.
    if (current && current.updatedAt === provider.updatedAt) {
      writeAll(
        listProviders().map((entry) =>
          entry.id === provider.id
            ? { ...entry, models, modelsFetchedAt: new Date().toISOString() }
            : entry
        )
      )
    }
    return { models }
  } catch (error) {
    return { models: provider.models, error: (error as Error).message }
  }
}

/** What the endpoints the test found mean, in a few words: `chat, responses, messages`. */
export function endpointsLabel(provider: Pick<CustomProvider, 'endpoints'>): string {
  const e = provider.endpoints
  const found = [
    e.chat ? 'chat' : '',
    e.responses ? 'responses' : '',
    e.messages ? 'messages' : ''
  ].filter(Boolean)
  return found.length ? found.join(', ') : 'none'
}
