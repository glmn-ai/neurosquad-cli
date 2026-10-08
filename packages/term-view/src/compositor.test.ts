import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCompositor, SYNC_TIMEOUT_MS } from './compositor.js'
import { gridToText } from './grid.js'
import { makeHost, makeView, write } from './__test__/helpers.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('compositor', () => {
  it('paints all tiles in one synchronized frame and restores the host cursor', async () => {
    const frames: string[] = []
    const compositor = createCompositor({ write: (f) => frames.push(f), paused: true })
    const a = makeView({ cols: 4, rows: 1 })
    const b = makeView({ cols: 4, rows: 1 })
    await write(a, 'left')
    await write(b, 'righ')
    compositor.addTile(a, { x: 0, y: 0, width: 4, height: 1 })
    compositor.addTile(b, { x: 5, y: 0, width: 4, height: 1 })
    const frame = compositor.flush()
    expect(frame.startsWith('\x1b[?2026h\x1b7')).toBe(true)
    expect(frame.endsWith('\x1b[0m\x1b8\x1b[?2026l')).toBe(true)
    const host = makeHost(9, 1)
    await write(host, frame)
    expect(gridToText(host.snapshot())).toBe('left righ')
    expect(compositor.flush()).toBe('')
    expect(frames).toHaveLength(1)
  })

  it('coalesces bursts of output into frames at the caller-set rate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const frames: string[] = []
    const compositor = createCompositor({ write: (f) => frames.push(f), fps: 10 })
    const view = makeView({ cols: 10, rows: 2 })
    compositor.addTile(view, { x: 0, y: 0, width: 10, height: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(frames).toHaveLength(1) // first paint
    for (let i = 0; i < 50; i++) {
      view.write(String(i % 10))
      await vi.advanceTimersByTimeAsync(2) // 50 chunks over 100 ms
    }
    await vi.advanceTimersByTimeAsync(200)
    // 10 fps: at most one frame per 100 ms of output, plus the trailing one.
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(frames.length).toBeLessThanOrEqual(4)
    compositor.dispose()
    vi.useRealTimers() // xterm parses on timers
    const host = makeHost(10, 2)
    for (const f of frames) await write(host, f)
    expect(gridToText(host.snapshot())).toBe(gridToText(view.snapshot()))
  })

  it("holds a tile back during the agent's own synchronized update", async () => {
    const frames: string[] = []
    const compositor = createCompositor({ write: (f) => frames.push(f), paused: true })
    const view = makeView({ cols: 10, rows: 1 })
    compositor.addTile(view, { x: 0, y: 0, width: 10, height: 1 })
    compositor.flush()
    await write(view, '\x1b[?2026hhalf')
    expect(compositor.flush()).toBe('')
    await write(view, ' done\x1b[?2026l')
    const host = makeHost(10, 1)
    await write(host, compositor.flush())
    expect(gridToText(host.snapshot())).toBe('half done')
  })

  it('gives up waiting for a synchronized update after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const compositor = createCompositor({ write: () => {}, paused: true })
    const view = makeView({ cols: 10, rows: 1 })
    compositor.addTile(view, { x: 0, y: 0, width: 10, height: 1 })
    compositor.flush()
    await write(view, '\x1b[?2026hstuck')
    expect(compositor.flush()).toBe('')
    vi.setSystemTime(Date.now() + SYNC_TIMEOUT_MS + 1)
    expect(compositor.flush()).toContain('stuck')
  })

  it("places and shows the host cursor at the focused tile's agent cursor", async () => {
    const compositor = createCompositor({ write: () => {}, paused: true })
    const view = makeView({ cols: 10, rows: 2 })
    await write(view, 'ab\r\nc')
    compositor.addTile(view, { x: 3, y: 2, width: 10, height: 2 }, { showCursor: true })
    const frame = compositor.flush()
    expect(frame).toContain('\x1b[?25l')
    expect(frame).toContain('\x1b8\x1b[4;5H\x1b[?25h')
  })

  it("mirrors the expanded agent's input modes onto the host and undoes them", async () => {
    const compositor = createCompositor({ write: () => {}, paused: true })
    const view = makeView()
    const tile = compositor.addTile(
      view,
      { x: 0, y: 0, width: 20, height: 5 },
      { syncInputModes: true }
    )
    compositor.flush()
    await write(view, '\x1b[?2004h\x1b[?1004h')
    expect(compositor.flush()).toContain('\x1b[?2004h\x1b[?1004h')
    tile.setOptions({ syncInputModes: false })
    expect(compositor.flush()).toContain('\x1b[?2004l\x1b[?1004l')
    expect(compositor.restoreInputModes()).toBe('')
  })

  it('undoes the input modes of a removed tile on the next frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const frames: string[] = []
    const compositor = createCompositor({ write: (f) => frames.push(f) })
    const view = makeView()
    view.terminal.write('\x1b[?1003h')
    await vi.advanceTimersByTimeAsync(50)
    const tile = compositor.addTile(
      view,
      { x: 0, y: 0, width: 20, height: 5 },
      { syncInputModes: true }
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(frames.join('')).toContain('\x1b[?1003h')
    frames.length = 0
    tile.remove()
    await vi.advanceTimersByTimeAsync(50)
    expect(frames.join('')).toContain('\x1b[?1003l')
    compositor.dispose()
  })

  it('undoes them on resume when the tile was removed while paused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const frames: string[] = []
    const compositor = createCompositor({ write: (f) => frames.push(f) })
    const view = makeView()
    view.terminal.write('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(50)
    const tile = compositor.addTile(
      view,
      { x: 0, y: 0, width: 20, height: 5 },
      { syncInputModes: true }
    )
    await vi.advanceTimersByTimeAsync(50)
    compositor.pause()
    tile.remove()
    frames.length = 0
    await vi.advanceTimersByTimeAsync(100)
    expect(frames).toHaveLength(0)
    compositor.resume()
    await vi.advanceTimersByTimeAsync(100)
    expect(frames.join('')).toContain('\x1b[?2004l')
    compositor.dispose()
  })

  it('follows a tile to a new view and a new rect', async () => {
    const compositor = createCompositor({ write: () => {}, paused: true })
    const a = makeView({ cols: 3, rows: 1 })
    const b = makeView({ cols: 3, rows: 1 })
    await write(a, 'aaa')
    await write(b, 'bbb')
    const tile = compositor.addTile(a, { x: 0, y: 0, width: 3, height: 1 })
    compositor.flush()
    tile.setView(b)
    expect(compositor.flush()).toContain('bbb')
    tile.setRect({ x: 4, y: 0, width: 3, height: 1 })
    expect(compositor.flush()).toContain('\x1b[1;5H')
    tile.remove()
    expect(compositor.tiles).toHaveLength(0)
  })

  it('stops painting while paused and catches up on resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const frames: string[] = []
    const compositor = createCompositor({ write: (f) => frames.push(f) })
    const view = makeView({ cols: 5, rows: 1 })
    compositor.addTile(view, { x: 0, y: 0, width: 5, height: 1 })
    await vi.advanceTimersByTimeAsync(50)
    compositor.pause()
    frames.length = 0
    view.write('x')
    await vi.advanceTimersByTimeAsync(200)
    expect(frames).toHaveLength(0)
    compositor.resume()
    await vi.advanceTimersByTimeAsync(100)
    expect(frames.join('')).toContain('x')
    compositor.dispose()
  })
})
