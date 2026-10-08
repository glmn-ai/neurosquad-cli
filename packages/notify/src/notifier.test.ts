import { describe, expect, it } from 'vitest'
import { bundledSound } from './assets.js'
import type { PreparedNotification, SoundBackend, ToastBackend } from './backends/types.js'
import { createNotifier } from './notifier.js'
import { fakeSystem } from './testing/fakes.js'
import type { NotifierOptions } from './types.js'

class FakeToast implements ToastBackend {
  readonly name = 'windows-toast' as const
  readonly replaceable = true
  readonly events: string[] = []
  unavailable: string | null = null
  failShow = false
  failWithdraw = false
  gate: Promise<void> | undefined

  async probe() {
    return this.unavailable
  }
  async show(n: PreparedNotification) {
    if (this.gate) await this.gate
    if (this.failShow) throw new Error('boom')
    this.events.push(`show:${n.key}:${n.kind}:${n.title}|${n.body}`)
  }
  async withdraw(key: string) {
    if (this.failWithdraw) throw new Error('nope')
    this.events.push(`withdraw:${key}`)
  }
  async dispose() {
    this.events.push('dispose')
  }
}

class FakeSound implements SoundBackend {
  readonly name = 'fake-player'
  readonly played: string[] = []
  fail = false
  async play(file: string) {
    this.played.push(file)
    if (this.fail) throw new Error('no audio device')
  }
  async dispose() {}
}

function setup(
  overrides: Partial<NotifierOptions> = {},
  env: Record<string, string | undefined> = {}
) {
  const toast = new FakeToast()
  const sound = new FakeSound()
  const logs: string[] = []
  const written: string[] = []
  const notifier = createNotifier(
    {
      appName: 'NeuroSquad CLI',
      appId: 'ai.neurosquad.cli',
      log: (message) => logs.push(message),
      terminal: { write: (data) => written.push(data), protocol: 'osc9' },
      ...overrides
    },
    { system: fakeSystem({ platform: 'linux', env }), selection: { toast, sound } }
  )
  return { notifier, toast, sound, logs, written }
}

describe('createNotifier', () => {
  it('shows a native toast and plays the bundled sound for the kind', async () => {
    const { notifier, toast, sound, written } = setup()
    const result = await notifier.show({
      id: 'agent-1',
      title: 'Claude needs you',
      body: 'Allow Bash?',
      kind: 'needs-input'
    })
    expect(result).toEqual({ via: 'os', sound: true })
    expect(toast.events).toEqual(['show:agent-1:needs-input:Claude needs you|Allow Bash?'])
    expect(sound.played).toEqual([bundledSound('needs-input')])
    expect(written).toEqual([])
  })

  it('withdraws only what it showed, after the show it follows', async () => {
    const { notifier, toast } = setup()
    toast.gate = new Promise((resolve) => setTimeout(resolve, 20))
    const shown = notifier.show({ id: 'a', title: 't', body: 'b', kind: 'finished' })
    const withdrawn = notifier.withdraw('a')
    await Promise.all([shown, withdrawn])
    // The withdraw came before the show ran, so the show was dropped and
    // there was nothing to take down.
    expect(toast.events).toEqual([])

    await notifier.show({ id: 'a', title: 't', body: 'b', kind: 'finished' })
    await notifier.withdraw('a')
    await notifier.withdraw('a')
    await notifier.withdraw('never-shown')
    expect(toast.events).toEqual(['show:a:finished:t|b', 'withdraw:a'])
  })

  it('keeps only the latest of a burst for one id', async () => {
    const { notifier, toast } = setup()
    toast.gate = new Promise((resolve) => setTimeout(resolve, 10))
    const first = notifier.show({ id: 'a', title: 'one', body: '', kind: 'finished' })
    const second = notifier.show({ id: 'a', title: 'two', body: '', kind: 'needs-input' })
    const other = notifier.show({ id: 'b', title: 'three', body: '', kind: 'finished' })
    expect((await first).via).toBe('none')
    expect((await second).via).toBe('os')
    expect((await other).via).toBe('os')
    expect(toast.events.sort()).toEqual(['show:a:needs-input:two|', 'show:b:finished:three|'])
  })

  it('falls back to the terminal when the toast fails, ringing the bell only without a sound file', async () => {
    const { notifier, toast, sound, logs, written } = setup()
    toast.failShow = true
    const result = await notifier.show({ id: 'a', title: 'Done', body: 'ok', kind: 'finished' })
    expect(result).toEqual({ via: 'terminal', sound: true })
    expect(sound.played).toHaveLength(1)
    expect(written).toEqual(['\x1b]9;Done: ok\x07'])
    expect(logs.some((line) => line.includes('boom'))).toBe(true)
  })

  it('uses the terminal (with the bell as the sound) when native toasts are unavailable', async () => {
    const toast = new FakeToast()
    toast.unavailable = 'toasts-disabled:DisabledForUser'
    const written: string[] = []
    const logs: string[] = []
    const notifier = createNotifier(
      {
        appName: 'x',
        appId: 'ai.neurosquad.cli',
        log: (m) => logs.push(m),
        terminal: { write: (d) => written.push(d), protocol: 'osc777' }
      },
      { system: fakeSystem({ platform: 'linux' }), selection: { toast } }
    )
    const result = await notifier.show({ id: 'a', title: 'T;x', body: 'B', kind: 'error' })
    expect(result).toEqual({ via: 'terminal', sound: true })
    expect(written).toEqual(['\x1b]777;notify;T,x;B\x07\x07'])
    expect(logs.join('\n')).toContain('DisabledForUser')
    expect(await notifier.status()).toMatchObject({
      backend: null,
      reason: 'toasts-disabled:DisabledForUser',
      soundPlayer: null,
      terminal: 'osc777'
    })
  })

  it('mute: no sound file and no bell, the notification still shows', async () => {
    const written: string[] = []
    const { notifier, toast, sound } = setup({
      muted: true,
      terminal: { mode: 'always', protocol: 'bell', write: (d) => written.push(d) }
    })
    let result = await notifier.show({ id: 'a', title: 't', body: 'b', kind: 'needs-input' })
    expect(result).toEqual({ via: 'os', sound: false })
    expect(sound.played).toEqual([])
    expect(toast.events).toHaveLength(1)
    expect(written).toEqual([])

    notifier.setMuted(false)
    result = await notifier.show({ id: 'a', title: 't', body: 'b', kind: 'needs-input' })
    expect(result.sound).toBe(true)
    expect(sound.played).toHaveLength(1)
  })

  it('sound: false updates silently; a string plays that file; per-kind overrides apply', async () => {
    const { notifier, sound } = setup({ sounds: { finished: '/custom/done.wav' } })
    await notifier.show({ id: 'a', title: 't', body: 'b', kind: 'needs-input', sound: false })
    await notifier.show({ id: 'a', title: 't', body: 'b', kind: 'needs-input', sound: '/x.wav' })
    await notifier.show({ id: 'b', title: 't', body: 'b', kind: 'finished' })
    expect(sound.played).toEqual(['/x.wav', '/custom/done.wav'])
  })

  it('never rejects: a failing player, a failing withdraw and a throwing logger are absorbed', async () => {
    const toast = new FakeToast()
    const sound = new FakeSound()
    sound.fail = true
    toast.failWithdraw = true
    const notifier = createNotifier(
      {
        appName: 'x',
        appId: 'ai.neurosquad.cli',
        log: () => {
          throw new Error('logger down')
        },
        terminal: { mode: 'never' }
      },
      { system: fakeSystem({ platform: 'linux' }), selection: { toast, sound } }
    )
    await expect(
      notifier.show({ id: 'a', title: 't', body: 'b', kind: 'finished' })
    ).resolves.toEqual({ via: 'os', sound: true })
    await expect(notifier.withdraw('a')).resolves.toBeUndefined()
  })

  it('cleans text: control characters out, empty title becomes the app name, long ids hashed', async () => {
    const { notifier, toast } = setup()
    await notifier.show({
      id: 'workspace/agent with spaces/' + 'x'.repeat(80),
      title: '',
      body: 'line\x1b]0;evil\x07 two',
      kind: 'finished'
    })
    expect(toast.events[0]).toMatch(
      /^show:h[0-9a-f]{40}:finished:NeuroSquad CLI\|line\]0;evil two$/
    )
  })

  it('an invalid appId turns native toasts off instead of throwing', async () => {
    const logs: string[] = []
    const written: string[] = []
    const notifier = createNotifier(
      {
        appName: 'x',
        appId: 'bad id!',
        log: (m) => logs.push(m),
        terminal: { write: (d) => written.push(d), protocol: 'osc9' }
      },
      { system: fakeSystem({ platform: 'linux', env: { DISPLAY: ':0' } }) }
    )
    const result = await notifier.show({ id: 'a', title: 't', body: 'b', kind: 'finished' })
    expect(result.via).toBe('terminal')
    expect(logs[0]).toContain('invalid appId')
  })

  it('over SSH: terminal only, no native sound (the remote machine has the speakers)', async () => {
    const written: string[] = []
    const notifier = createNotifier(
      {
        appName: 'x',
        appId: 'ai.neurosquad.cli',
        log: () => {},
        terminal: { write: (d) => written.push(d) }
      },
      {
        system: fakeSystem({
          platform: 'linux',
          env: { SSH_CONNECTION: '1 2 3 4', DISPLAY: ':0', TERM_PROGRAM: 'WezTerm' },
          binaries: { gdbus: '/usr/bin/gdbus', paplay: '/usr/bin/paplay' }
        })
      }
    )
    const result = await notifier.show({ id: 'a', title: 't', body: 'b', kind: 'needs-input' })
    expect(result).toEqual({ via: 'terminal', sound: true })
    expect(written).toEqual(['\x1b]9;t: b\x07\x07'])
    expect(await notifier.status()).toMatchObject({
      backend: null,
      reason: 'ssh',
      soundPlayer: null
    })
  })

  it('dispose stops the backends and later calls are no-ops', async () => {
    const { notifier, toast } = setup()
    await notifier.dispose()
    expect(toast.events).toEqual(['dispose'])
    expect(await notifier.show({ id: 'a', title: 't', body: 'b', kind: 'finished' })).toEqual({
      via: 'none',
      sound: false
    })
  })
})
