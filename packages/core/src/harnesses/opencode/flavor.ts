// The OpenCode engine's names: environment variables, XDG folders, database
// file, config schema. A descriptor rather than constants so a fork of
// OpenCode can be described by another one. Pure data.
import { homedir } from 'node:os'
import { join } from 'node:path'

export type OpenCodeFamilyHarness = 'opencode'

export interface OpenCodeFlavor {
  harness: OpenCodeFamilyHarness
  /** Product name in the texts shown to the user ("OpenCode needs your permission: …"). */
  label: string
  /** Last segment of the hook URL the plugin posts to. */
  hookEvent: string
  /** Folder for the plugin and per-agent config files. */
  dirName: string
  /** Its folder name under the XDG data/config/cache dirs. */
  xdgName: string
  /** Its database file in the XDG data folder. */
  dbFile: string
  /** Environment variables, by role. */
  env: {
    /** A config FILE merged over the user's global config. */
    config: string
    /** Inline config JSON merged last. */
    configContent: string
    /** "Run without external plugins" — must not leak in from a parent shell. */
    pure: string
    /** Database path override. */
    db: string
  }
  /** `$schema` of its config files. */
  schema: string
  /** Record-id prefix and source id of its usage records (../../usage/sources/opencode.ts). */
  usageSource: string
  /**
   * An env variable that, when set, moves all four base dirs under one root
   * (`<root>/data`, `/config`, `/cache`, `/state`) (none for OpenCode).
   */
  homeEnv?: string
  /**
   * Its `message` table has an `agent_id` column: in-session subagents
   * ("actors", MiMo Code) write their rows into the parent's session under
   * their own id, the main conversation under `main`.
   */
  actorColumn?: boolean
}

export const OPENCODE_FLAVOR: OpenCodeFlavor = {
  harness: 'opencode',
  label: 'OpenCode',
  hookEvent: 'OpenCode',
  dirName: 'opencode',
  xdgName: 'opencode',
  dbFile: 'opencode.db',
  env: {
    config: 'OPENCODE_CONFIG',
    configContent: 'OPENCODE_CONFIG_CONTENT',
    pure: 'OPENCODE_PURE',
    db: 'OPENCODE_DB'
  },
  schema: 'https://opencode.ai/config.json',
  usageSource: 'opencode'
}

export function openCodeFlavorOf(harness: string): OpenCodeFlavor | null {
  return harness === 'opencode' ? OPENCODE_FLAVOR : null
}

/** `<home>/<sub>` when the flavor's home variable is set (an absolute path). */
function flavorHome(flavor: OpenCodeFlavor, sub: string): string | null {
  const home = flavor.homeEnv ? process.env[flavor.homeEnv] : undefined
  return home && /^([A-Za-z]:[\\/]|[\\/])/.test(home) ? join(home, sub) : null
}

/** `<XDG data>/<name>` — `%USERPROFILE%\.local\share\<name>` on Windows too (xdg-basedir). */
export function flavorDataDir(flavor: OpenCodeFlavor): string {
  const home = flavorHome(flavor, 'data')
  if (home) return home
  return join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), flavor.xdgName)
}

/** `<XDG config>/<name>` — where the user's global config lives. */
export function flavorConfigDir(flavor: OpenCodeFlavor): string {
  const home = flavorHome(flavor, 'config')
  if (home) return home
  return join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), flavor.xdgName)
}

/** `<XDG cache>/<name>` — its models.dev cache (`models.json`). */
export function flavorCacheDir(flavor: OpenCodeFlavor): string {
  const home = flavorHome(flavor, 'cache')
  if (home) return home
  return join(process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), flavor.xdgName)
}

/**
 * Its database: the `*_DB` override when set — absolute, or a name inside the
 * data folder (core/src/database/database.ts) — else the default file.
 */
export function flavorDbPath(flavor: OpenCodeFlavor): string {
  const override = process.env[flavor.env.db]
  if (override && override !== ':memory:') {
    return /^([A-Za-z]:[\\/]|[\\/])/.test(override)
      ? override
      : join(flavorDataDir(flavor), override)
  }
  return join(flavorDataDir(flavor), flavor.dbFile)
}
