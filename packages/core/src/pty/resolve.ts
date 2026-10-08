// Finds a harness's executable on PATH and returns an absolute path with
// forward slashes (node-pty on Windows mishandles backslashes in some
// arguments; Windows itself accepts forward slashes).
import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** The names tried per harness, in order. Windows: the native exe first, then npm's `.cmd` shim. */
export function harnessCommandNames(
  harness: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const win = platform === 'win32'
  switch (harness) {
    case 'claude-code':
      return win ? ['claude.exe', 'claude.cmd'] : ['claude']
    case 'codex-cli':
      return win ? ['codex.exe', 'codex.cmd'] : ['codex']
    case 'opencode':
      return win ? ['opencode.exe', 'opencode.cmd'] : ['opencode']
    default:
      return []
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The first match of `name` on `pathValue` (the `PATH` string). On Windows a
 * name without an extension is tried with each of PATHEXT's.
 */
export function findOnPath(
  name: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
  pathExt = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD'
): string | null {
  const normalize = (path: string): string =>
    platform === 'win32' ? path.replaceAll('\\', '/') : path
  if (isAbsolute(name) || name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    return isFile(name) ? normalize(name) : null
  }
  const hasExt = /\.[A-Za-z0-9]+$/.test(name)
  const exts = platform === 'win32' && !hasExt ? pathExt.split(';').filter(Boolean) : ['']
  const sep = platform === 'win32' ? ';' : delimiter
  for (const dir of (pathValue ?? '').split(sep)) {
    const clean = dir.trim().replace(/^"(.*)"$/, '$1')
    if (!clean) continue
    for (const ext of exts) {
      const candidate = join(clean, name + ext.toLowerCase())
      if (isFile(candidate)) return normalize(candidate)
    }
  }
  return null
}

/** The harness's executable, or null when it is not installed. */
export function resolveHarnessCommand(
  harness: string,
  pathValue: string | undefined = process.env['PATH'] ?? process.env['Path'],
  platform: NodeJS.Platform = process.platform
): string | null {
  for (const name of harnessCommandNames(harness, platform)) {
    const found = findOnPath(name, pathValue, platform)
    if (found) return found
  }
  return null
}

/** The marker an unresolvable harness raises (hosts show "not installed" instead of a spawn error). */
export const HARNESS_NOT_INSTALLED = 'NEUROSQUAD_HARNESS_NOT_INSTALLED'

export function harnessNotInstalledError(harness: string): Error {
  return new Error(`${HARNESS_NOT_INSTALLED}:${harness}`)
}
