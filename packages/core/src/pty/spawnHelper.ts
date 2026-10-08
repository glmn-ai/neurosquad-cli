// node-pty on macOS/Linux starts every process through a tiny `spawn-helper`
// executable next to its pty.node. Some npm tarballs of node-pty ship it
// without the executable bit, and every spawn then fails with
// "posix_spawnp failed.". This restores the bit once per process, before the
// first spawn.
import { accessSync, chmodSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

let checked = false

export function ensureSpawnHelperExecutable(): void {
  if (checked || process.platform === 'win32') return
  checked = true
  let root: string
  try {
    root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  } catch {
    return
  }
  // The helper node-pty itself runs: app.asar → app.asar.unpacked.
  for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
    const helper = join(root, dir, 'spawn-helper')
    if (!existsSync(helper)) continue
    try {
      accessSync(helper, constants.X_OK)
    } catch {
      try {
        chmodSync(helper, 0o755)
        console.log(`ptyManager: made ${helper} executable`)
      } catch (error) {
        console.error(`ptyManager: ${helper} is not executable and cannot be fixed`, error)
      }
    }
  }
}
