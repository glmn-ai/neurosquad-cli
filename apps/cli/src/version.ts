// The package version and name, read once from package.json next to dist/.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function read(): { version: string; name: string } {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
      name?: string
    }
    return { version: pkg.version ?? '0.0.0', name: pkg.name ?? 'neurosquad' }
  } catch {
    return { version: '0.0.0', name: 'neurosquad' }
  }
}

const pkg = read()

export const VERSION = pkg.version
/** The npm package name (`neurosquad`). */
export const PACKAGE_NAME = pkg.name
/** The folder holding package.json (its real path: Node resolves symlinks for modules). */
export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
