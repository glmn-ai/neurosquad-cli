import { describe, expect, it } from 'vitest'
import { NativeWork } from './nativeWork.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('NativeWork', () => {
  it('waits for in-flight work, including work started by finishing work', async () => {
    const work = new NativeWork()
    const first = deferred<string>()
    const second = deferred<string>()
    void work.track(first.promise).then(() => work.track(second.promise))
    const closing = work.close(5000)
    first.resolve('a')
    setTimeout(() => second.resolve('b'), 20)
    const result = await closing
    expect(result).toMatchObject({ idle: true, waited: 2 })
    expect(work.count).toBe(0)
  })

  it('refuses to start new work once closing', async () => {
    const work = new NativeWork()
    await work.close(10)
    let started = false
    await expect(
      work.start(async () => {
        started = true
      })
    ).rejects.toThrow(/shutting down/)
    expect(started).toBe(false)
  })

  it('gives up after the timeout', async () => {
    const work = new NativeWork()
    void work.track(new Promise(() => undefined))
    const result = await work.close(30)
    expect(result.idle).toBe(false)
  })

  it('stops tracking rejected work', async () => {
    const work = new NativeWork()
    await expect(work.track(Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(work.count).toBe(0)
  })
})
