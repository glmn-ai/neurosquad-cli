import { describe, expect, it } from 'vitest'
import { fakeSystem } from '../testing/fakes.js'
import { GdbusBackend, gvariantString, NotifySendBackend } from './linux.js'
import { OsascriptBackend, TerminalNotifierBackend } from './macos.js'
import { selectBackends, type SelectOptions } from './select.js'
import type { PreparedNotification } from './types.js'

const base: SelectOptions = {
  appName: 'NeuroSquad CLI',
  appId: 'ai.neurosquad.cli',
  native: true,
  nativeOverSsh: false,
  registerAppId: true
}

const needs: PreparedNotification = {
  key: 'agent-1',
  title: "Claude's turn",
  body: 'Allow Bash?\nrm -rf build',
  kind: 'needs-input'
}

describe('selectBackends', () => {
  it('windows: one PowerShell helper for toasts and sound', () => {
    const sys = fakeSystem({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      files: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']
    })
    const selection = selectBackends(sys, base)
    expect(selection.toast?.name).toBe('windows-toast')
    expect(selection.sound?.name).toBe('SoundPlayer')
  })

  it('windows without PowerShell: nothing native', () => {
    const selection = selectBackends(fakeSystem({ platform: 'win32' }), base)
    expect(selection).toEqual({ reason: 'powershell-not-found' })
  })

  it('macOS: terminal-notifier when installed, else osascript; afplay for sound', () => {
    const withTn = selectBackends(
      fakeSystem({
        platform: 'darwin',
        files: ['/usr/bin/afplay', '/usr/bin/osascript'],
        binaries: { 'terminal-notifier': '/opt/homebrew/bin/terminal-notifier' }
      }),
      base
    )
    expect(withTn.toast?.name).toBe('macos-terminal-notifier')
    expect(withTn.sound?.name).toBe('afplay')
    const plain = selectBackends(
      fakeSystem({ platform: 'darwin', files: ['/usr/bin/afplay', '/usr/bin/osascript'] }),
      base
    )
    expect(plain.toast?.name).toBe('macos-osascript')
  })

  it('linux: gdbus first, notify-send second, first available player', () => {
    const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
    const gd = selectBackends(
      fakeSystem({
        platform: 'linux',
        env,
        binaries: { gdbus: '/usr/bin/gdbus', 'notify-send': '/usr/bin/notify-send', aplay: '/a' }
      }),
      base
    )
    expect(gd.toast?.name).toBe('linux-gdbus')
    expect(gd.sound?.name).toBe('aplay')
    const ns = selectBackends(
      fakeSystem({ platform: 'linux', env, binaries: { 'notify-send': '/usr/bin/notify-send' } }),
      base
    )
    expect(ns.toast?.name).toBe('linux-notify-send')
    expect(ns.sound).toBeUndefined()
  })

  it('linux without a session bus (a server, a container): nothing native', () => {
    const selection = selectBackends(
      fakeSystem({ platform: 'linux', binaries: { gdbus: '/usr/bin/gdbus', paplay: '/p' } }),
      base
    )
    expect(selection.toast).toBeUndefined()
    expect(selection.reason).toBe('no-session-bus')
    expect(selection.sound?.name).toBe('paplay')
  })

  it('SSH: no native toast and no native sound, unless asked for', () => {
    const sys = fakeSystem({
      platform: 'darwin',
      env: { SSH_TTY: '/dev/ttys001' },
      files: ['/usr/bin/afplay', '/usr/bin/osascript']
    })
    expect(selectBackends(sys, base)).toEqual({ reason: 'ssh' })
    expect(selectBackends(sys, { ...base, nativeOverSsh: true }).toast?.name).toBe(
      'macos-osascript'
    )
  })

  it('native: false keeps sound', () => {
    const selection = selectBackends(
      fakeSystem({ platform: 'darwin', files: ['/usr/bin/afplay', '/usr/bin/osascript'] }),
      { ...base, native: false }
    )
    expect(selection.toast).toBeUndefined()
    expect(selection.reason).toBe('disabled')
    expect(selection.sound?.name).toBe('afplay')
  })
})

describe('linux gdbus', () => {
  it('quotes GVariant strings', () => {
    expect(gvariantString("it's a \\ path\nnext")).toBe("'it\\'s a \\\\ path\\nnext'")
  })

  it('replaces by the server id and closes it on withdraw', async () => {
    let next = 41
    const sys = fakeSystem({
      platform: 'linux',
      respond: ({ args }) =>
        args.includes('org.freedesktop.Notifications.Notify')
          ? { stdout: `(uint32 ${++next},)\n` }
          : {}
    })
    const backend = new GdbusBackend(sys, '/usr/bin/gdbus', 'NeuroSquad CLI', '/i.png')
    expect(await backend.probe()).toBeNull()
    await backend.show(needs)
    await backend.show({ ...needs, kind: 'finished', title: 'done' })
    await backend.withdraw('agent-1')
    await backend.withdraw('agent-1')

    const [probe, first, second, close] = sys.calls
    expect(probe.args).toContain('org.freedesktop.Notifications.GetServerInformation')
    expect(first.args.slice(-8)).toEqual([
      "'NeuroSquad CLI'",
      'uint32 0',
      "'/i.png'",
      "'Claude\\'s turn'",
      "'Allow Bash?\\nrm -rf build'",
      '@as []',
      "{'urgency': <byte 2>, 'suppress-sound': <true>}",
      'int32 0'
    ])
    expect(second.args.slice(-8)[1]).toBe('uint32 42')
    expect(second.args.slice(-8)[6]).toContain('<byte 1>')
    expect(second.args.slice(-1)[0]).toBe('int32 -1')
    expect(close.args.slice(-2)).toEqual([
      'org.freedesktop.Notifications.CloseNotification',
      'uint32 43'
    ])
    expect(sys.calls).toHaveLength(4)
  })

  it('reports a missing notification server and failures', async () => {
    const sys = fakeSystem({ platform: 'linux', respond: () => ({ code: 1, stderr: 'no bus' }) })
    const backend = new GdbusBackend(sys, '/usr/bin/gdbus', 'x')
    expect(await backend.probe()).toBe('no-notification-server')
    await expect(backend.show(needs)).rejects.toThrow(/no bus/)
  })
})

describe('linux notify-send', () => {
  it('uses --print-id / --replace-id when supported', async () => {
    const sys = fakeSystem({
      platform: 'linux',
      respond: ({ args }) =>
        args[0] === '--help'
          ? { stdout: '  -p, --print-id   Print the notification ID.' }
          : { stdout: '7\n' }
    })
    const backend = new NotifySendBackend(sys, '/usr/bin/notify-send', 'NeuroSquad CLI')
    await backend.show(needs)
    await backend.show(needs)
    const [, first, second] = sys.calls
    expect(first.args).toEqual([
      '-a',
      'NeuroSquad CLI',
      '-u',
      'critical',
      '-t',
      '0',
      '-h',
      'boolean:suppress-sound:true',
      '-p',
      '--',
      "Claude's turn",
      'Allow Bash?\nrm -rf build'
    ])
    expect(second.args).toContain('-r')
    expect(second.args[second.args.indexOf('-r') + 1]).toBe('7')
  })

  it('old notify-send: no ids, still shows', async () => {
    const sys = fakeSystem({ platform: 'linux', respond: () => ({ stdout: 'Usage: …' }) })
    const backend = new NotifySendBackend(sys, '/usr/bin/notify-send', 'x', '/icon.png')
    await backend.show({ ...needs, kind: 'finished' })
    expect(sys.calls[1].args).toEqual([
      '-a',
      'x',
      '-u',
      'normal',
      '-i',
      '/icon.png',
      '-h',
      'boolean:suppress-sound:true',
      '--',
      "Claude's turn",
      'Allow Bash?\nrm -rf build'
    ])
  })
})

describe('macOS', () => {
  it('terminal-notifier: group per id, -remove to withdraw', async () => {
    const sys = fakeSystem({ platform: 'darwin' })
    const backend = new TerminalNotifierBackend(
      sys,
      '/opt/homebrew/bin/terminal-notifier',
      'ai.nsq'
    )
    await backend.show({ ...needs, title: '-dash', body: '' })
    await backend.withdraw('agent-1')
    expect(sys.calls[0].args).toEqual([
      '-title',
      '\u200b-dash',
      '-message',
      '\u200b-dash',
      '-group',
      'ai.nsq.agent-1'
    ])
    expect(sys.calls[1].args).toEqual(['-remove', 'ai.nsq.agent-1'])
  })

  it('osascript: text goes as arguments, never into the script', async () => {
    const sys = fakeSystem({ platform: 'darwin' })
    const backend = new OsascriptBackend(sys)
    await backend.show({ ...needs, title: 'a" & do shell script "x' })
    expect(sys.calls[0].command).toBe('/usr/bin/osascript')
    expect(sys.calls[0].args.slice(-2)).toEqual(['a" & do shell script "x', needs.body])
    expect(sys.calls[0].args.filter((a) => a.includes('do shell script'))).toHaveLength(1)
    await backend.withdraw()
    expect(sys.calls).toHaveLength(1)
  })

  it('a failing command rejects (the notifier logs and falls back)', async () => {
    const sys = fakeSystem({ platform: 'darwin', respond: () => ({ code: 1, stderr: 'denied' }) })
    await expect(new OsascriptBackend(sys).show(needs)).rejects.toThrow(/denied/)
  })
})
