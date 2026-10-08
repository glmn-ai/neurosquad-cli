// The non-secret half of a session, as a small JSON file the host chooses the path of
// (e.g. `~/.neurosquad-cli/cloud.json`): the install id, who is signed in, when the session was
// last confirmed and when the access token expires. Tokens are never written here (vault.ts).
//
// Written atomically (temp file + rename) with mode 0600 — the content is not secret, but the
// account e-mail is personal and has no business being world-readable.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface CloudUser {
  id: string
  email: string
  name: string | null
  initials?: string
  avatarColor?: string
  role?: string
}

export interface CloudPlan {
  id: string
  name: string
  unlimited?: boolean
  trialEndsAt?: string | null
}

export interface OriginSession {
  user: CloudUser
  plan?: CloudPlan
  /** ms epoch of the last successful `/me`, refresh or sign-in. */
  lastVerifiedAt: number
  /** ms epoch the access token in the vault stops being valid. */
  accessExpiresAt?: number
}

export interface PersistedCloud {
  /** Identifies this CLI install to the cloud (refresh tokens are bound to it). */
  installId: string
  /** Keyed by API origin, like the vault. */
  sessions: Record<string, OriginSession>
}

export interface SessionStore {
  read(): PersistedCloud
  write(value: PersistedCloud): void
}

const INSTALL_ID = /^[A-Za-z0-9-]{8,64}$/

function sanitize(value: unknown): PersistedCloud | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.installId !== 'string' || !INSTALL_ID.test(record.installId)) return undefined
  const sessions: Record<string, OriginSession> = {}
  if (record.sessions && typeof record.sessions === 'object') {
    for (const [origin, raw] of Object.entries(record.sessions as Record<string, unknown>)) {
      const session = raw as Partial<OriginSession> | undefined
      if (
        session &&
        typeof session === 'object' &&
        session.user &&
        typeof session.user.id === 'string' &&
        typeof session.user.email === 'string' &&
        typeof session.lastVerifiedAt === 'number'
      ) {
        sessions[origin] = session as OriginSession
      }
    }
  }
  return { installId: record.installId, sessions }
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly file: string) {}

  read(): PersistedCloud {
    try {
      const parsed = sanitize(JSON.parse(readFileSync(this.file, 'utf8')))
      if (parsed) return parsed
    } catch {
      // Missing or damaged: a fresh install id, no sessions.
    }
    const fresh: PersistedCloud = { installId: randomUUID(), sessions: {} }
    this.write(fresh)
    return fresh
  }

  write(value: PersistedCloud): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, this.file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
}

export class MemorySessionStore implements SessionStore {
  private value: PersistedCloud

  constructor(value?: PersistedCloud) {
    this.value = value ?? { installId: randomUUID(), sessions: {} }
  }

  read(): PersistedCloud {
    return structuredClone(this.value)
  }

  write(value: PersistedCloud): void {
    this.value = structuredClone(value)
  }
}
