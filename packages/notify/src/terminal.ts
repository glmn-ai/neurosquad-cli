// The fallback that works anywhere there is a terminal, including over SSH:
// BEL (most terminals flash the tab/taskbar or ring), plus a notification
// escape sequence where the terminal is known to show one:
//   OSC 9   iTerm2, WezTerm, Ghostty          ESC ] 9 ; text BEL
//   OSC 777 foot, urxvt (notify ext.), WezTerm ESC ] 777 ; notify ; title ; body BEL
//   OSC 99  kitty                              ESC ] 99 ; i=id:d=0 ; title ESC \ …
// Unknown terminals get BEL only: a stray OSC is ignored by most, but not by
// all (ConEmu reads OSC 9 as its own commands), so we only send what we know.
import type { TerminalProtocol } from './types.js'
import { oneLine } from './text.js'

const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`

export function detectTerminalProtocol(env: Record<string, string | undefined>): TerminalProtocol {
  const term = env.TERM ?? ''
  const program = env.TERM_PROGRAM ?? ''
  // GNU screen swallows OSC it does not know; inside tmux we wrap instead.
  if (env.STY && !env.TMUX) return 'bell'
  if (env.ConEmuPID || env.ConEmuANSI) return 'bell'
  if (env.KITTY_WINDOW_ID || term === 'xterm-kitty') return 'osc99'
  if (program === 'iTerm.app' || program === 'WezTerm' || program === 'ghostty') return 'osc9'
  if (term === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'osc9'
  if (term.startsWith('foot') || term.startsWith('rxvt-unicode') || term.startsWith('urxvt')) {
    return 'osc777'
  }
  return 'bell'
}

/** tmux forwards an escape sequence only inside its passthrough DCS (and only with allow-passthrough on). */
function tmuxWrap(sequence: string): string {
  return `${ESC}Ptmux;${sequence.split(ESC).join(ESC + ESC)}${ST}`
}

export interface TerminalSignal {
  key: string
  title: string
  body: string
  bell: boolean
}

/** The bytes to write for one notification (empty when there is nothing to send). */
export function formatTerminalSignal(
  protocol: TerminalProtocol,
  signal: TerminalSignal,
  env: Record<string, string | undefined> = {}
): string {
  const title = oneLine(signal.title, 120)
  const body = oneLine(signal.body, 240)
  let sequence = ''
  switch (protocol) {
    case 'osc9': {
      let text = body ? `${title}: ${body}` : title
      // OSC 9 ; <digit> ; … is a sub-command in some terminals (progress, cwd).
      if (/^\d/.test(text)) text = `nsq: ${text}`
      sequence = `${ESC}]9;${text}${BEL}`
      break
    }
    case 'osc777':
      sequence = `${ESC}]777;notify;${title.replace(/;/g, ',')};${body}${BEL}`
      break
    case 'osc99': {
      const id = signal.key.replace(/[^A-Za-z0-9_+.-]/g, '-')
      sequence = body
        ? `${ESC}]99;i=${id}:d=0;${title}${ST}${ESC}]99;i=${id}:d=1:p=body;${body}${ST}`
        : `${ESC}]99;i=${id};${title}${ST}`
      break
    }
    case 'bell':
      break
  }
  if (sequence && env.TMUX) sequence = tmuxWrap(sequence)
  return sequence + (signal.bell ? BEL : '')
}

/** The default sink: whichever standard stream is a terminal. */
export function defaultTerminalWriter(): ((data: string) => void) | undefined {
  if (process.stderr.isTTY) return (data) => void process.stderr.write(data)
  if (process.stdout.isTTY) return (data) => void process.stdout.write(data)
  return undefined
}
