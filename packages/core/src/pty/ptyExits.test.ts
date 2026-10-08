import { describe, expect, it } from 'vitest'
import type { IPty } from 'node-pty'
import { livePtyCount, trackPtyExit, waitForPtyExits } from './ptyExits.js'

/** A pty whose process exits `exitAfter` ms after a signal (or never, for `ignore`). */
function fakePty(behaviour: { onHup?: number | 'ignore'; onKill?: number | 'never' }): {
  pty: IPty
  signals: string[]
  exit: () => void
} {
  let listener: (() => void) | undefined
  const signals: string[] = []
  let exited = false
  const exit = (): void => {
    if (exited) return
    exited = true
    listener?.()
  }
  const pty = {
    onExit: (fn: () => void) => {
      listener = fn
      return { dispose: () => undefined }
    },
    kill: (signal?: string) => {
      signals.push(signal ?? 'SIGHUP')
      const after = signal === 'SIGKILL' ? (behaviour.onKill ?? 0) : behaviour.onHup
      if (after === 'ignore' || after === 'never' || after === undefined) return
      setTimeout(exit, after)
    }
  } as unknown as IPty
  return { pty, signals, exit }
}

describe('waitForPtyExits', () => {
  it('waits for a slow exit (the quit crash: exit landing after will-quit)', async () => {
    const slow = fakePty({ onHup: 80 })
    trackPtyExit(slow.pty)
    slow.pty.kill()
    const r = await waitForPtyExits(1000, 500, 'darwin')
    expect(r).toMatchObject({ waited: 1, forced: 0, stuck: 0 })
    expect(r.ms).toBeGreaterThanOrEqual(60)
    expect(livePtyCount()).toBe(0)
  })

  it('SIGKILLs a process that ignores SIGHUP, then sees it exit', async () => {
    const stubborn = fakePty({ onHup: 'ignore', onKill: 10 })
    trackPtyExit(stubborn.pty)
    stubborn.pty.kill()
    const r = await waitForPtyExits(50, 500, 'darwin')
    expect(stubborn.signals).toEqual(['SIGHUP', 'SIGKILL'])
    expect(r).toMatchObject({ waited: 1, forced: 1, stuck: 0 })
  })

  it('Windows: a plain second kill (ConPTY takes no signals); bounded when nothing exits', async () => {
    const hung = fakePty({ onHup: 'ignore', onKill: 'never' })
    trackPtyExit(hung.pty)
    const r = await waitForPtyExits(20, 20, 'win32')
    expect(hung.signals).toEqual(['SIGHUP'])
    expect(r).toMatchObject({ waited: 1, forced: 1, stuck: 1 })
    hung.exit()
    expect(livePtyCount()).toBe(0)
  })

  it('nothing tracked: returns at once', async () => {
    expect(await waitForPtyExits(1000, 1000, 'darwin')).toMatchObject({
      waited: 0,
      forced: 0,
      stuck: 0
    })
  })
})
