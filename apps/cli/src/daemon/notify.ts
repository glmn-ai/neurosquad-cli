// Native OS notifications without Electron: one per agent at a time,
// replaced by a newer one and withdrawn when the agent works again.
//
// - Windows: a toast through WinRT from one long-lived, hidden PowerShell
//   process (no console window, no per-toast start-up cost), under nsq's own
//   AppUserModelID registered for the current user (HKCU only), with sound.
// - macOS: `osascript` `display notification … sound name`.
// - Linux: `notify-send` (replacing the agent's previous one) and a sound
//   through `canberra-gtk-play` or `paplay` when available.
//
// The dashboard also rings the terminal (BEL + OSC 9 / OSC 777) — that works
// over SSH too.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

export const WINDOWS_APP_ID = 'NeuroSquad.nsq'

export interface Notifier {
  show(agentId: string, title: string, body: string, sound: boolean): void
  close(agentId: string): void
  dispose(): void
}

/** PowerShell single-quoted string literal. */
const psQuote = (text: string): string => `'${text.replaceAll("'", "''")}'`

const xmlEscape = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/** The toast XML for one notification. */
export function toastXml(title: string, body: string, sound: boolean): string {
  return (
    '<toast><visual><binding template="ToastGeneric">' +
    `<text>${xmlEscape(title)}</text><text>${xmlEscape(body.slice(0, 300))}</text>` +
    '</binding></visual>' +
    (sound ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '<audio silent="true"/>') +
    '</toast>'
  )
}

/** The helper's start-up script: registers the AppUserModelID, then reads one command per line. */
export function windowsHelperScript(appId = WINDOWS_APP_ID): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$appId = ${psQuote(appId)}`,
    '$key = "HKCU:\\Software\\Classes\\AppUserModelId\\$appId"',
    'if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }',
    "Set-ItemProperty -Path $key -Name DisplayName -Value 'nsq (NeuroSquad)'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)',
    '$history = [Windows.UI.Notifications.ToastNotificationManager]::History',
    'while ($true) {',
    '  $line = [Console]::In.ReadLine()',
    '  if ($line -eq $null) { break }',
    '  try {',
    '    $cmd = $line | ConvertFrom-Json',
    "    if ($cmd.op -eq 'show') {",
    '      $xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '      $xml.LoadXml($cmd.xml)',
    '      $toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    '      $toast.Tag = $cmd.tag',
    "      $toast.Group = 'nsq'",
    '      $notifier.Show($toast)',
    "    } elseif ($cmd.op -eq 'close') {",
    "      $history.Remove($cmd.tag, 'nsq', $appId)",
    '    }',
    '  } catch {}',
    '}'
  ].join('\n')
}

/** Toast tags are at most 64 characters. */
const tagOf = (agentId: string): string => agentId.replaceAll('-', '').slice(0, 32)

class WindowsNotifier implements Notifier {
  private helper: ChildProcess | null = null

  private ensure(): ChildProcess | null {
    if (this.helper && this.helper.exitCode === null && !this.helper.killed) return this.helper
    try {
      const encoded = Buffer.from(windowsHelperScript(), 'utf16le').toString('base64')
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }
      )
      child.on('error', () => {
        this.helper = null
      })
      child.on('exit', () => {
        if (this.helper === child) this.helper = null
      })
      child.stdin?.on('error', () => {})
      this.helper = child
      return child
    } catch {
      return null
    }
  }

  private send(command: Record<string, string>): void {
    this.ensure()?.stdin?.write(`${JSON.stringify(command)}\n`)
  }

  show(agentId: string, title: string, body: string, sound: boolean): void {
    this.send({ op: 'show', tag: tagOf(agentId), xml: toastXml(title, body, sound) })
  }

  close(agentId: string): void {
    if (this.helper) this.send({ op: 'close', tag: tagOf(agentId) })
  }

  dispose(): void {
    this.helper?.stdin?.end()
    this.helper = null
  }
}

/** AppleScript string literal. */
const asQuote = (text: string): string =>
  `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

export function macNotificationScript(title: string, body: string, sound: boolean): string {
  return `display notification ${asQuote(body.slice(0, 300))} with title ${asQuote(title)}${
    sound ? ' sound name "Glass"' : ''
  }`
}

function run(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: false })
    child.on('error', () => {})
    child.unref()
  } catch {
    // not available
  }
}

class MacNotifier implements Notifier {
  show(_agentId: string, title: string, body: string, sound: boolean): void {
    run('osascript', ['-e', macNotificationScript(title, body, sound)])
  }
  close(): void {
    // osascript notifications cannot be withdrawn.
  }
  dispose(): void {}
}

const LINUX_SOUNDS = [
  '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga',
  '/usr/share/sounds/freedesktop/stereo/message.oga'
]

class LinuxNotifier implements Notifier {
  show(agentId: string, title: string, body: string, sound: boolean): void {
    run('notify-send', [
      '--app-name=nsq',
      `--hint=string:x-canonical-private-synchronous:nsq-${tagOf(agentId)}`,
      title,
      body.slice(0, 300)
    ])
    if (!sound) return
    const file = LINUX_SOUNDS.find((path) => existsSync(path))
    if (file) run('paplay', [file])
    else run('canberra-gtk-play', ['-i', 'message-new-instant'])
  }
  close(): void {}
  dispose(): void {}
}

class SilentNotifier implements Notifier {
  show(): void {}
  close(): void {}
  dispose(): void {}
}

export function createNotifier(enabled: boolean): Notifier {
  if (!enabled || process.env['NSQ_NO_NOTIFY'] === '1') return new SilentNotifier()
  if (process.platform === 'win32') return new WindowsNotifier()
  if (process.platform === 'darwin') return new MacNotifier()
  return new LinuxNotifier()
}
