// Bundled files, resolved next to this module: `src/` in development and
// tests, `dist/` once built — both sit one level below the package root.
import { fileURLToPath } from 'node:url'
import type { NotificationKind } from './types.js'

const assetPath = (relative: string) =>
  fileURLToPath(new URL(`../assets/${relative}`, import.meta.url))

/** The bundled CC0 chime for each kind (assets/sounds/LICENSE.md). */
export function bundledSound(kind: NotificationKind): string {
  return assetPath(`sounds/${kind}.wav`)
}

/** The PowerShell/WinRT helper behind the Windows backend. */
export function windowsBridgeScript(): string {
  return assetPath('windows/toast-bridge.ps1')
}
