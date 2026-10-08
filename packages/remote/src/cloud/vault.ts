// Where the cloud tokens live: the OS keyring and nowhere else.
//
// Windows Credential Manager, macOS Keychain, the Secret Service on Linux — through
// `@napi-rs/keyring`, loaded lazily so a machine that never runs `nsq login` never loads the
// native addon. There is deliberately no file fallback: on a Linux box without a Secret Service
// `nsq login` fails with `KeyringUnavailableError` and says why, instead of writing a refresh
// token to disk in clear text.
//
// One keyring entry per API origin (`service = neurosquad-cli`, `account = <origin>`), so tokens
// obtained from a dev or fake server are never presented to production and the other way round.

export interface StoredTokens {
  accessToken: string
  refreshToken: string
}

export interface TokenVault {
  load(origin: string): Promise<StoredTokens | undefined>
  save(origin: string, tokens: StoredTokens): Promise<void>
  /** Resolves even when there was nothing to clear. */
  clear(origin: string): Promise<void>
}

/** The OS keyring cannot be used here (no addon for this platform, no Secret Service, locked). */
export class KeyringUnavailableError extends Error {
  constructor(cause: unknown) {
    // Only the cause's message is kept: keyring errors never contain the secret itself.
    super(
      `The OS keyring is not available: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'KeyringUnavailableError'
  }
}

export const KEYRING_SERVICE = 'neurosquad-cli'

function parseTokens(raw: string | undefined | null): StoredTokens | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<StoredTokens>
    if (typeof value.accessToken === 'string' && typeof value.refreshToken === 'string') {
      return { accessToken: value.accessToken, refreshToken: value.refreshToken }
    }
  } catch {
    // A foreign or damaged entry: treated as no session.
  }
  return undefined
}

export interface KeyringEntry {
  getPassword(): Promise<string | undefined | null>
  setPassword(password: string): Promise<void>
  deletePassword(): Promise<boolean>
}
export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry

let defaultFactory: Promise<KeyringEntryFactory> | undefined

async function loadKeyring(): Promise<KeyringEntryFactory> {
  defaultFactory ??= import('@napi-rs/keyring').then(
    // On Linux the default silently falls back to the kernel keyring (keyutils), which forgets
    // everything at logout/reboot; pinned to the Secret Service it fails loudly instead.
    (mod) => (service: string, account: string) =>
      new mod.AsyncEntry(service, account, { linux: { store: 'secret-service' } })
  )
  try {
    return await defaultFactory
  } catch (error) {
    defaultFactory = undefined
    throw new KeyringUnavailableError(error)
  }
}

export class KeyringVault implements TokenVault {
  /** @param factory for tests; production loads `@napi-rs/keyring` on first use */
  constructor(
    private readonly factory?: KeyringEntryFactory,
    private readonly service = KEYRING_SERVICE
  ) {}

  private async entry(origin: string): Promise<KeyringEntry> {
    const factory = this.factory ?? (await loadKeyring())
    try {
      return factory(this.service, origin)
    } catch (error) {
      throw new KeyringUnavailableError(error)
    }
  }

  async load(origin: string): Promise<StoredTokens | undefined> {
    const entry = await this.entry(origin)
    try {
      return parseTokens(await entry.getPassword())
    } catch (error) {
      throw new KeyringUnavailableError(error)
    }
  }

  async save(origin: string, tokens: StoredTokens): Promise<void> {
    const entry = await this.entry(origin)
    try {
      await entry.setPassword(
        JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken })
      )
    } catch (error) {
      throw new KeyringUnavailableError(error)
    }
  }

  async clear(origin: string): Promise<void> {
    const entry = await this.entry(origin)
    try {
      await entry.deletePassword()
    } catch (error) {
      throw new KeyringUnavailableError(error)
    }
  }
}

/** In-memory vault for tests and for hosts that hold tokens themselves. */
export class MemoryVault implements TokenVault {
  private readonly entries = new Map<string, StoredTokens>()

  async load(origin: string): Promise<StoredTokens | undefined> {
    const tokens = this.entries.get(origin)
    return tokens ? { ...tokens } : undefined
  }

  async save(origin: string, tokens: StoredTokens): Promise<void> {
    this.entries.set(origin, { ...tokens })
  }

  async clear(origin: string): Promise<void> {
    this.entries.delete(origin)
  }

  has(origin: string): boolean {
    return this.entries.has(origin)
  }
}
