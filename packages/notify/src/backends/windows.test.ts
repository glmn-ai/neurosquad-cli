import { describe, expect, it } from 'vitest'
import { windowsBridgeScript } from '../assets.js'
import { createSystem } from '../system.js'
import { FakeChild, fakeSystem } from '../testing/fakes.js'
import { WindowsBridge, WindowsSoundBackend, WindowsToastBackend } from './windows.js'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function setup(script: (child: FakeChild, index: number) => void) {
  const children: FakeChild[] = []
  const sys = fakeSystem({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    files: [PS],
    spawn: () => {
      const child = new FakeChild()
      children.push(child)
      script(child, children.length - 1)
      return child
    }
  })
  const bridge = new WindowsBridge(sys, {
    appId: 'ai.neurosquad.cli',
    appName: 'NeuroSquad CLI',
    register: true,
    script: 'C:\\pkg\\assets\\windows\\toast-bridge.ps1'
  })
  return { sys, bridge, children }
}

const READY = { ready: true, winrt: true, registered: true, setting: 'Enabled', error: null }

describe('WindowsBridge', () => {
  it('starts PowerShell once, configured through the environment, and talks JSON lines', async () => {
    const { sys, bridge, children } = setup((child) => {
      child.reply(READY)
      child.autoReply(() => ({ ok: true, setting: 'Enabled' }))
    })
    const toast = new WindowsToastBackend(bridge, 'file:///C:/icon.png')
    expect(await toast.probe()).toBeNull()
    await toast.show({ key: 'a1', title: 'Готово ✓', body: 'b', kind: 'needs-input' })
    await toast.withdraw('a1')
    await new WindowsSoundBackend(bridge).play('C:\\s.wav')

    expect(sys.spawns).toHaveLength(1)
    expect(sys.spawns[0].command).toBe(PS)
    expect(sys.spawns[0].args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command'
    ])
    expect(sys.spawns[0].env).toMatchObject({
      NSQ_NOTIFY_BRIDGE: 'C:\\pkg\\assets\\windows\\toast-bridge.ps1',
      NSQ_NOTIFY_APP_ID: 'ai.neurosquad.cli',
      NSQ_NOTIFY_APP_NAME: 'NeuroSquad CLI',
      NSQ_NOTIFY_REGISTER: '1'
    })
    const ops = children[0].lines.map((line) => line.op)
    expect(ops).toEqual(['ping', 'show', 'withdraw', 'sound'])
    expect(children[0].lines[1]).toMatchObject({
      tag: 'a1',
      group: 'nsq',
      title: 'Готово ✓',
      kind: 'needs-input',
      icon: 'file:///C:/icon.png'
    })
    await bridge.dispose()
    expect(children[0].killed).toBe(true)
  })

  it('sends non-ASCII as \\u escapes (the pipe code page cannot garble it)', async () => {
    const raw: string[] = []
    const { bridge } = setup((child) => {
      child.stdin.on('data', (chunk: string) => raw.push(chunk))
      child.reply(READY)
      child.autoReply(() => ({ ok: true }))
    })
    await bridge.request({ op: 'show', title: 'é ж' })
    expect(raw.join('')).toContain('\\u00e9 \\u0436')
    expect([...raw.join('')].every((c) => c.charCodeAt(0) < 0x80)).toBe(true)
    await bridge.dispose()
  })

  it('reports toasts switched off in Windows settings', async () => {
    const { bridge } = setup((child) => {
      child.reply({ ...READY, setting: 'DisabledForUser' })
      child.autoReply(() => ({ ok: true, setting: 'DisabledForUser' }))
    })
    expect(await new WindowsToastBackend(bridge).probe()).toBe('toasts-disabled:DisabledForUser')
    await bridge.dispose()
  })

  it('a failed request rejects with the helper error', async () => {
    const { bridge } = setup((child) => {
      child.reply(READY)
      child.autoReply(() => ({ ok: false, error: 'Element not found' }))
    })
    await expect(bridge.request({ op: 'show' })).rejects.toThrow('Element not found')
    await bridge.dispose()
  })

  it('ignores noise lines and restarts after a crash, at most three starts', async () => {
    const { bridge, children } = setup((child) => {
      child.stdout.write('WARNING: something from a profile\n')
      child.reply(READY)
      child.autoReply(() => null)
    })
    const pending = bridge.request({ op: 'ping' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    children[0].exit(1)
    await expect(pending).rejects.toThrow(/exited/)

    for (let i = 1; i < 3; i++) {
      const next = bridge.request({ op: 'ping' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      children[i].exit(1)
      await expect(next).rejects.toThrow(/exited/)
    }
    await expect(bridge.request({ op: 'ping' })).rejects.toThrow(/stopped 3 times/)
    expect(children).toHaveLength(3)
  })

  it('a helper that dies before it is ready fails the start, not the caller', async () => {
    const { bridge } = setup((child) => setTimeout(() => child.exit(1), 5))
    expect(await bridge.start()).toMatchObject({ ok: false })
    const toast = new WindowsToastBackend(bridge)
    expect(await toast.probe()).toMatch(/exited|stopped/)
  })

  it('a broken pipe is not an unhandled error in the caller', async () => {
    const { bridge, children } = setup((child) => child.reply(READY))
    expect(await bridge.start()).toMatchObject({ ok: true })
    expect(() => children[0].stdin.emit('error', new Error('EPIPE'))).not.toThrow()
    expect(() => children[0].stdout.emit('error', new Error('EPIPE'))).not.toThrow()
    await bridge.dispose()
  })

  it('no PowerShell: nothing is spawned', async () => {
    const sys = fakeSystem({ platform: 'win32' })
    const bridge = new WindowsBridge(sys, {
      appId: 'a',
      appName: 'a',
      register: false,
      script: 's'
    })
    expect(await bridge.start()).toEqual({ ok: false, error: 'powershell.exe not found' })
    expect(sys.spawns).toHaveLength(0)
  })
})

// The real helper on a real Windows (CI runs this on windows-latest): the
// script parses, loads WinRT, and builds escaped toast XML in dry-run mode.
// No toast is shown and nothing is registered.
describe.runIf(process.platform === 'win32')('toast-bridge.ps1 (real PowerShell)', () => {
  it('starts, answers ping, and escapes XML in a dry run', async () => {
    const bridge = new WindowsBridge(createSystem(), {
      appId: 'ai.neurosquad.cli.test',
      appName: 'nsq test',
      register: false,
      script: windowsBridgeScript()
    })
    try {
      const ready = await bridge.start()
      expect(ready.ok).toBe(true)
      const reply = await bridge.request({
        op: 'show',
        dry: true,
        tag: 't',
        group: 'nsq',
        title: 'a<b & "c" é',
        body: 'ж',
        kind: 'needs-input'
      })
      expect(reply.xml).toContain('<text>a&lt;b &amp; &quot;c&quot; é</text><text>ж</text>')
      expect(reply.xml).toContain('scenario="reminder"')
      expect(reply.xml).toContain('<audio silent="true"/>')
      const ping = await bridge.request({ op: 'ping' })
      expect(typeof ping.setting).toBe('string')
    } finally {
      await bridge.dispose()
    }
  }, 60_000)
})
