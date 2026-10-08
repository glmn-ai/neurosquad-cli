# The Windows half of @neurosquad/notify: a long-lived Windows PowerShell 5.1
# process that shows, replaces and withdraws toasts through WinRT
# (Windows.UI.Notifications) and plays sounds (System.Media.SoundPlayer).
#
# Started by src/backends/windows.ts as
#   powershell.exe -NoLogo -NoProfile -NonInteractive -Command <bootstrap>
# where the bootstrap reads this file into a scriptblock, so the machine's
# execution policy does not apply and nothing is written to disk.
# Configuration comes from the environment (no quoting games):
#   NSQ_NOTIFY_APP_ID    the AppUserModelID toasts go out under
#   NSQ_NOTIFY_APP_NAME  what Windows shows as the sender
#   NSQ_NOTIFY_ICON      optional absolute path to a .png/.ico for the sender
#   NSQ_NOTIFY_REGISTER  "1" registers the AppUserModelID (see below)
#
# The only thing it ever writes is the app's own AppUserModelID entry under
# HKCU\Software\Classes\AppUserModelId\<id> (DisplayName, IconUri): the
# per-user registration Windows needs before it shows toasts from an
# unpackaged app. No shortcut, no machine-wide setting, nothing of anyone else's.
#
# Protocol: one JSON object per line on stdin, one JSON object per line on
# stdout. The first line out is {"ready":true,...}; every request carries a
# "seq" that its answer repeats.
#   {"seq":1,"op":"show","tag":"a1","group":"nsq","title":"...","body":"...","kind":"needs-input","icon":"file:///...","dry":false}
#   {"seq":2,"op":"withdraw","tag":"a1","group":"nsq"}
#   {"seq":3,"op":"sound","path":"C:\\...\\finished.wav"}
#   {"seq":4,"op":"ping"}   -> {"setting":"Enabled"|"DisabledForUser"|...}
# The bridge exits when stdin closes (its parent went away).

$ErrorActionPreference = 'Stop'

$AppId = $env:NSQ_NOTIFY_APP_ID
$AppName = $env:NSQ_NOTIFY_APP_NAME
$IconPath = $env:NSQ_NOTIFY_ICON
$Register = $env:NSQ_NOTIFY_REGISTER -eq '1'

# ASCII only on the wire (non-ASCII as \uXXXX): the pipe's code page then
# cannot garble a localized error message.
function Send($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 3
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  return [System.Security.SecurityElement]::Escape($s)
}

$winrt = $true
$startError = $null
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
} catch {
  $winrt = $false
  $startError = 'WinRT unavailable: ' + $_.Exception.Message
}

$registered = $false
if ($winrt -and $Register -and $AppId) {
  try {
    $key = 'HKCU:\Software\Classes\AppUserModelId\' + $AppId
    if (-not (Test-Path -LiteralPath $key)) { $null = New-Item -Path $key -Force }
    $current = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
    if ($current.DisplayName -ne $AppName) {
      Set-ItemProperty -LiteralPath $key -Name DisplayName -Value $AppName
    }
    if ($IconPath -and $current.IconUri -ne $IconPath) {
      Set-ItemProperty -LiteralPath $key -Name IconUri -Value $IconPath
    }
    $registered = $true
  } catch {
    $startError = 'AppUserModelID registration failed: ' + $_.Exception.Message
  }
}

$notifier = $null
if ($winrt) {
  try {
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
  } catch {
    $startError = 'CreateToastNotifier failed: ' + $_.Exception.Message
  }
}

function Get-RegDword([string]$path, [string]$name) {
  try { return (Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop).$name } catch { return $null }
}

# Whether Windows will show our toasts. ToastNotifier.Setting cannot tell
# (it throws ERROR_NOT_FOUND for unpackaged apps), so read what Settings >
# System > Notifications writes: the group policy, the switch for all apps,
# the switch for this app.
function Get-ToastSetting {
  if ($null -eq $notifier) { return 'Unavailable' }
  $policy = 'HKCU:\Software\Policies\Microsoft\Windows\CurrentVersion\PushNotifications'
  $push = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications'
  $app = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\' + $AppId
  if ((Get-RegDword $policy 'NoToastApplicationNotification') -eq 1) { return 'DisabledByGroupPolicy' }
  if ((Get-RegDword $push 'ToastEnabled') -eq 0) { return 'DisabledForUser' }
  if ((Get-RegDword $app 'Enabled') -eq 0) { return 'DisabledForApplication' }
  return 'Enabled'
}

$setting = Get-ToastSetting
Send @{ ready = $true; winrt = $winrt; registered = $registered; setting = $setting; error = $startError }

$player = $null

function Build-ToastXml($m) {
  $scenario = ''
  $actions = ''
  if ($m.kind -eq 'needs-input') {
    # Stays on screen until answered or dismissed; a "reminder" toast needs a
    # button, so it gets the system's own Dismiss.
    $scenario = ' scenario="reminder"'
    $actions = '<actions><action activationType="system" arguments="dismiss" content=""/></actions>'
  }
  $image = ''
  if ($m.icon) { $image = '<image placement="appLogoOverride" src="' + (Esc $m.icon) + '"/>' }
  # Silent: the sound is played separately (and obeys the mute setting).
  return '<toast' + $scenario + '><visual><binding template="ToastGeneric"><text>' + (Esc $m.title) +
    '</text><text>' + (Esc $m.body) + '</text>' + $image + '</binding></visual>' + $actions +
    '<audio silent="true"/></toast>'
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $seq = $null
  try {
    $m = $line | ConvertFrom-Json
    $seq = $m.seq
    switch ($m.op) {
      'show' {
        $text = Build-ToastXml $m
        if ($m.dry) { Send @{ seq = $seq; ok = $true; xml = $text }; break }
        if ($null -eq $notifier) { throw 'toasts unavailable' }
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($text)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        $toast.Tag = $m.tag
        $toast.Group = $m.group
        $notifier.Show($toast)
        Send @{ seq = $seq; ok = $true }
      }
      'withdraw' {
        if ($winrt) {
          [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($m.tag, $m.group, $AppId)
        }
        Send @{ seq = $seq; ok = $true }
      }
      'sound' {
        if ($null -eq $player) { $player = New-Object System.Media.SoundPlayer }
        $player.SoundLocation = $m.path
        $player.Play()
        Send @{ seq = $seq; ok = $true }
      }
      'ping' {
        $setting = Get-ToastSetting
        Send @{ seq = $seq; ok = $true; setting = $setting }
      }
      default { throw ('unknown op: ' + $m.op) }
    }
  } catch {
    Send @{ seq = $seq; ok = $false; error = $_.Exception.Message }
  }
}
