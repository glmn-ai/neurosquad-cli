// Handing things to the person's desktop: a link to the browser, text to the clipboard.
import { spawn } from 'node:child_process'

/**
 * Opens an http(s) link in the default browser; anything else is refused. Returns false when it
 * could not even start; `onError` hears of an opener that turned out to be missing (ENOENT
 * arrives after the spawn).
 */
export function openInBrowser(url: string, onError?: () => void): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  if (process.env['NSQ_NO_BROWSER'] === '1') return false
  try {
    const [command, args] =
      process.platform === 'win32'
        ? ['explorer.exe', [url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => onError?.())
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Text for the host terminal's clipboard (OSC 52) — the only way that reaches
 * the person's own clipboard over SSH. Windows Terminal, iTerm2, kitty,
 * WezTerm, Alacritty and foot honour it.
 */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
}

/** Puts text on this machine's clipboard with the system tool; quietly does nothing without one. */
export function copyToSystemClipboard(text: string): void {
  const run = (command: string, args: string[], input: Buffer, next?: () => void): void => {
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      child.on('error', () => next?.())
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    } catch {
      next?.()
    }
  }
  const utf8 = Buffer.from(text, 'utf8')
  if (process.platform === 'win32') {
    // clip.exe reads UTF-16 with a byte order mark as Unicode; anything else as the console code page.
    run('clip.exe', [], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
  } else if (process.platform === 'darwin') run('pbcopy', [], utf8)
  else if (process.env['WAYLAND_DISPLAY']) {
    run('wl-copy', [], utf8, () => run('xclip', ['-selection', 'clipboard'], utf8))
  } else if (process.env['DISPLAY']) run('xclip', ['-selection', 'clipboard'], utf8)
}
