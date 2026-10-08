// Where the package behind an npm `.cmd` shim lives. A global install puts the
// shim in the prefix folder with the packages in `<prefix>/node_modules`; a
// local one puts it in `node_modules/.bin` beside the packages.
import { basename, dirname, join } from 'node:path'

/** The `node_modules` folders a shim's packages may be in, most likely first. */
export function shimModuleDirs(command: string): string[] {
  const dir = dirname(command)
  const dirs = [join(dir, 'node_modules')]
  if (basename(dir).toLowerCase() === '.bin') dirs.push(dirname(dir))
  return dirs
}
