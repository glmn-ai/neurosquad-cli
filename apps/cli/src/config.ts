// User settings (`~/.neurosquad-cli/config.json`). Every field is optional;
// a missing or malformed file means the defaults.
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@neurosquad/core'
import { paths } from './paths.js'

export interface NsqConfig {
  /** How harnesses are shown: their logos where the terminal can draw images, or neutral glyphs. */
  logos?: 'auto' | 'images' | 'glyphs' | 'neutral'
  /** Colours: truecolor, 256 colours, or follow the terminal (`auto`). */
  color?: 'auto' | 'truecolor' | '256' | '16'
  /** Notifications: native OS ones, or the terminal bell / OSC 9 in the TUI when none can show. `false` (or NSQ_NO_NOTIFY=1) silences both. */
  notifications?: boolean
  /** A sound with each notification. */
  sound?: boolean
  /** The detach key in full-screen attach (default Ctrl+]). */
  detachKey?: string
  /**
   * Updates: `true` (default) checks the npm registry and installs a new release by itself;
   * `"notify"` only shows that one exists; `false` never checks (NSQ_NO_UPDATE=1 does the same).
   */
  autoUpdate?: boolean | 'notify'
  /** Default layout of the dashboard. */
  layout?: 'grid' | 'focus'
  /** Phone access (`nsq phone on`). */
  phone?: {
    enabled?: boolean
    /** Listen on the local network, not only this machine. */
    lan?: boolean
    port?: number
    /** Reachable from the internet through a Cloudflare tunnel (restored on start only for `named`). */
    online?: boolean
    tunnel?: 'quick' | 'named'
    /** A named tunnel's public hostname; its token lives in the OS keyring. */
    tunnelHostname?: string
    /** The local port a named tunnel forwards to. Default 8767. */
    tunnelPort?: number
    /** Phones pair again once the pairing token is this many hours old. */
    expireHours?: number
  }
  dictation?: {
    enabled?: boolean
    /** A global hotkey, e.g. `F9`, `Ctrl+Alt+Space`. */
    hotkey?: string
    /** `hold` = push-to-talk, `toggle` = press to start / press to stop. */
    mode?: 'hold' | 'toggle'
    /** Model id from the catalog (`nsq dictation models`). */
    model?: string
    language?: string
  }
}

export function readConfig(): NsqConfig {
  try {
    const parsed = JSON.parse(readFileSync(paths.config(), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as NsqConfig) : {}
  } catch {
    return {}
  }
}

export function writeConfig(config: NsqConfig): void {
  writeFileAtomic(paths.config(), `${JSON.stringify(config, null, 2)}\n`)
}
