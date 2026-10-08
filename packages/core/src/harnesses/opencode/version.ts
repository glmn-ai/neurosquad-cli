// Which OpenCode an agent is about to run (docs/harnesses.md, "OpenCode").
//
// OpenCode 2 (npm `@opencode/cli`, the same `opencode` command) is a separate
// implementation of OpenCode 1.x (npm `opencode-ai`, critical fixes only now):
// another plugin API, another session store, a background service the TUI
// attaches to unless `--standalone`, no `--model` on the full-screen UI. The
// agent picks its launch from the binary it is about to start, asked once per
// file version: `opencode --version` prints "1.18.32" on 1.x and
// "opencode v2.0.24" on 2.x (the Effect CLI's built-in version flag).
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'

export interface OpenCodeVersion {
  version: string
  major: number
}

/** Pure: the version an `opencode --version` printed (ANSI and the "opencode v" prefix allowed). */
export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '')
  const match = /(?:^|[\sv])(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?/.exec(plain)
  if (!match) return null
  return { version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]) }
}

/** OpenCode 2 and later: the 2.x launch path (opencodeLaunch.ts). */
export function isOpenCodeV2(version: OpenCodeVersion | null | undefined): boolean {
  return (version?.major ?? 0) >= 2
}

const cache = new Map<string, { stamp: string; version: OpenCodeVersion | null }>()

function stampOf(path: string): string | null {
  try {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return null
  }
}

/**
 * The version of the OpenCode executable at `command` (absolute — the .exe
 * the agent spawns, not the npm shim), cached until the file changes. Null
 * when it cannot be asked: the agent then keeps the 1.x launch it always had.
 */
export function openCodeVersionOf(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeVersion | null> {
  const stamp = stampOf(command)
  const hit = cache.get(command)
  if (hit && stamp !== null && hit.stamp === stamp) return Promise.resolve(hit.version)
  return new Promise((resolve) => {
    // The .cmd shim (a half-removed install) needs a shell; the .exe does not.
    const viaShell = /\.(cmd|bat)$/i.test(command)
    execFile(
      viaShell ? `"${command}"` : command,
      ['--version'],
      {
        env: { ...env, NO_COLOR: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' },
        timeout: 15_000,
        windowsHide: true,
        shell: viaShell
      },
      (error, stdout, stderr) => {
        const version = error ? null : parseOpenCodeVersion(`${stdout}\n${stderr}`)
        if (stamp !== null && version) cache.set(command, { stamp, version })
        resolve(version)
      }
    )
  })
}
