// Secrets (the OpenRouter key, a cloud session) live in the OS keyring —
// Windows Credential Manager, macOS Keychain, the Secret Service on Linux —
// through @napi-rs/keyring. Where no keyring is available they can come from
// the environment instead; nothing secret is ever written to nsq's own files,
// logs or the agents' argv.
import { createHash } from 'node:crypto'
import { nsqHome } from '../paths.js'

const SERVICE = 'neurosquad-cli'

/** Account names are bound to the nsq home, so an isolated home has its own secrets. */
function account(name: string): string {
  const tag = createHash('sha256').update(nsqHome().toLowerCase()).digest('hex').slice(0, 8)
  return `${name}@${tag}`
}

type KeyringModule = typeof import('@napi-rs/keyring')
let keyring: KeyringModule | null | undefined

async function load(): Promise<KeyringModule | null> {
  if (keyring !== undefined) return keyring
  try {
    keyring = (await import('@napi-rs/keyring')) as KeyringModule
  } catch {
    keyring = null
  }
  return keyring
}

export async function getSecret(name: string): Promise<string | undefined> {
  const mod = await load()
  if (!mod) return undefined
  try {
    const value = new mod.Entry(SERVICE, account(name)).getPassword()
    return value ?? undefined
  } catch {
    return undefined
  }
}

/** Stores (or with `undefined`, removes) a secret. Throws when no keyring is available. */
export async function setSecret(name: string, value: string | undefined): Promise<void> {
  const mod = await load()
  if (!mod)
    throw new Error('no OS keyring is available here; set the value in the environment instead')
  const entry = new mod.Entry(SERVICE, account(name))
  if (value === undefined) {
    try {
      entry.deletePassword()
    } catch {
      // nothing stored
    }
    return
  }
  entry.setPassword(value)
}

export const OPENROUTER_SECRET = 'openrouter-api-key'

/** The OpenRouter key: the keyring first, then `OPENROUTER_API_KEY` in the daemon's environment. */
export async function openRouterKey(): Promise<string | undefined> {
  const stored = await getSecret(OPENROUTER_SECRET)
  if (stored) return stored
  const fromEnv = process.env['OPENROUTER_API_KEY']
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined
}
