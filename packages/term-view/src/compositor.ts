// Several tiles, one host terminal, one write per frame.
//
// Output arrives in bursts — a TUI harness redraws its frame tens of times a
// second, and node-pty hands it over in many small chunks. The compositor
// marks a tile dirty when its view parsed something and paints all dirty
// tiles together at most `fps` times a second: one string, one write.
//
// Each frame is wrapped in synchronized output (`CSI ? 2026 h … l`, a no-op
// where unsupported) and in save/restore cursor, so the host shows it at once
// and the cursor of whoever owns the rest of the screen (the TUI around the
// tiles) ends where it was. A view in the middle of its own synchronized
// update (the agent sent `?2026h` and not yet `?2026l`) is not painted until
// it finishes or `SYNC_TIMEOUT_MS` passes, so half-drawn agent frames never
// show.

import { createGrid, type Grid } from './grid.js'
import {
  createPaintState,
  createTileRenderer,
  type ColorOptions,
  type HostSize,
  type Rect,
  type ResyncMode,
  type TileRenderer
} from './renderer.js'
import type { TermModes, TermView } from './termView.js'
import { NO_INPUT_MODES, hostModeChanges } from './input.js'
import type { FitMode } from './viewport.js'

export interface TileOptions {
  fit?: FitMode
  /** Lines scrolled back from the live screen (normal screen only). */
  scrollOffset?: number
  /**
   * Show the host's cursor at this agent's cursor after each frame (the
   * focused/expanded tile). At most one tile should ask for it.
   */
  showCursor?: boolean
  /**
   * Keep the host terminal's input modes (bracketed paste, focus events,
   * mouse, application cursor keys) in step with this agent's — for the
   * expanded tile whose keys go to the agent. At most one tile.
   */
  syncInputModes?: boolean
}

export interface Tile {
  readonly view: TermView
  readonly renderer: TileRenderer
  setRect(rect: Rect): void
  setView(view: TermView): void
  setOptions(options: TileOptions): void
  /** Repaint this tile completely on the next frame (e.g. after something else drew over it). */
  invalidate(): void
  /** Re-read the view on the next frame and paint what changed (views signal this themselves). */
  update(): void
  remove(): void
}

export interface CompositorOptions {
  /** Where frames go — usually `(s) => process.stdout.write(s)`. */
  write: (frame: string) => void
  /** Frames per second at most (default 30). */
  fps?: number
  colors?: ColorOptions
  resync?: ResyncMode
  /** The host terminal's size; tiles are clipped to it. Update with `setHostSize` on resize. */
  hostSize?: HostSize
  /** Wrap frames in synchronized output (default true). */
  synchronized?: boolean
  /** Start paused: no frames until `resume()`. */
  paused?: boolean
}

export interface FrameStats {
  frames: number
  bytes: number
  /** Time spent building the last frame (snapshot + diff), ms. */
  lastFrameMs: number
  /** Total time spent building frames, ms. */
  totalFrameMs: number
}

export interface Compositor {
  addTile(view: TermView, rect: Rect, options?: TileOptions): Tile
  readonly tiles: readonly Tile[]
  setFps(fps: number): void
  /** The host terminal was resized: clip tiles to the new size and repaint everything. */
  setHostSize(size: HostSize): void
  setColors(colors: ColorOptions): void
  /** Repaint every tile completely on the next frame (host resized, screen cleared…). */
  invalidateAll(): void
  /** Stop painting (e.g. while attached raw); dirty tiles are kept. */
  pause(): void
  resume(): void
  /** Builds and writes a frame now if anything is dirty; returns the frame ('' when none). */
  flush(): string
  /** Builds a frame without writing it — for callers that write it with their own output. */
  renderFrame(): string
  readonly stats: FrameStats
  /** Undo the input modes a `syncInputModes` tile set on the host (call before exiting). */
  restoreInputModes(): string
  dispose(): void
}

/** Longest an agent's own synchronized update may hold its tile back. */
export const SYNC_TIMEOUT_MS = 200

const NO_MODES: TermModes = NO_INPUT_MODES

interface TileState {
  tile: Tile
  view: TermView
  renderer: TileRenderer
  options: TileOptions
  grid: Grid
  dirty: boolean
  syncSince: number
  subscription: { dispose(): void }
}

export function createCompositor(options: CompositorOptions): Compositor {
  const write = options.write
  let interval = 1000 / Math.max(1, options.fps ?? 30)
  let colors: ColorOptions = { ...options.colors }
  let hostSize: HostSize | undefined = options.hostSize
  const synchronized = options.synchronized ?? true
  let paused = options.paused ?? false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFrameAt = -Infinity
  let hostModes: TermModes = NO_MODES
  let forceModes = false
  const states: TileState[] = []
  const stats: FrameStats = { frames: 0, bytes: 0, lastFrameMs: 0, totalFrameMs: 0 }

  const schedule = (delay?: number): void => {
    if (disposed || paused || timer) return
    const wait = delay ?? Math.max(0, lastFrameAt + interval - performance.now())
    timer = setTimeout(() => {
      timer = null
      compositor.flush()
    }, wait)
    timer.unref?.()
  }

  const markDirty = (state: TileState): void => {
    state.dirty = true
    schedule()
  }

  const subscribe = (state: TileState): void => {
    state.subscription.dispose()
    state.subscription = state.view.onChange(() => markDirty(state))
  }

  const buildFrame = (): string => {
    const started = performance.now()
    const now = Date.now()
    const paint = createPaintState()
    let body = ''
    let cursorAt: { x: number; y: number } | null = null
    let wantsCursor = false
    let modesTile: TileState | null = null
    let heldBack = false
    for (const state of states) {
      if (state.options.syncInputModes) modesTile = state
      if (state.options.showCursor) wantsCursor = true
      if (!state.dirty) {
        if (state.options.showCursor) cursorAt = state.renderer.cursorPosition(state.grid)
        continue
      }
      if (state.view.modes().synchronizedOutput) {
        if (state.syncSince === 0) state.syncSince = now
        if (now - state.syncSince < SYNC_TIMEOUT_MS) {
          heldBack = true
          continue
        }
      }
      state.syncSince = 0
      state.dirty = false
      state.grid = state.view.snapshot(state.grid, { scrollOffset: state.options.scrollOffset })
      body += state.renderer.render(state.grid, paint)
      if (state.options.showCursor) cursorAt = state.renderer.cursorPosition(state.grid)
    }
    let modeChanges = ''
    if (modesTile) {
      const next = modesTile.view.modes()
      modeChanges = hostModeChanges(hostModes, next, forceModes)
      hostModes = next
      forceModes = false
    } else if (hostModes !== NO_MODES) {
      modeChanges = hostModeChanges(hostModes, NO_MODES)
      hostModes = NO_MODES
    }
    if (heldBack) schedule(Math.min(interval, SYNC_TIMEOUT_MS))
    if (body === '' && modeChanges === '') {
      stats.lastFrameMs = performance.now() - started
      return ''
    }
    let frame = ''
    if (synchronized) frame += '\x1b[?2026h'
    if (wantsCursor) frame += '\x1b[?25l'
    frame += '\x1b7' + body + '\x1b[0m\x1b8'
    if (cursorAt) frame += `\x1b[${cursorAt.y + 1};${cursorAt.x + 1}H\x1b[?25h`
    frame += modeChanges
    if (synchronized) frame += '\x1b[?2026l'
    stats.lastFrameMs = performance.now() - started
    stats.totalFrameMs += stats.lastFrameMs
    stats.frames++
    stats.bytes += frame.length
    return frame
  }

  const compositor: Compositor = {
    addTile(view, rect, tileOptions = {}) {
      const renderer = createTileRenderer({
        rect,
        hostSize,
        fit: tileOptions.fit,
        resync: options.resync,
        ...colors
      })
      const state: TileState = {
        tile: undefined as unknown as Tile,
        view,
        renderer,
        options: { ...tileOptions },
        grid: createGrid(view.cols, view.rows),
        dirty: true,
        syncSince: 0,
        subscription: { dispose() {} }
      }
      const tile: Tile = {
        get view() {
          return state.view
        },
        renderer,
        setRect(next) {
          renderer.setRect(next)
          markDirty(state)
        },
        setView(next) {
          if (next === state.view) return
          state.view = next
          state.grid = createGrid(next.cols, next.rows)
          renderer.invalidate()
          subscribe(state)
          markDirty(state)
        },
        setOptions(next) {
          state.options = { ...state.options, ...next }
          if (next.fit) renderer.setFit(next.fit)
          renderer.invalidate()
          markDirty(state)
        },
        invalidate() {
          renderer.invalidate()
          markDirty(state)
        },
        update() {
          markDirty(state)
        },
        remove() {
          const index = states.indexOf(state)
          if (index === -1) return
          states.splice(index, 1)
          state.subscription.dispose()
        }
      }
      state.tile = tile
      states.push(state)
      subscribe(state)
      schedule()
      return tile
    },

    get tiles() {
      return states.map((s) => s.tile)
    },

    setFps(fps) {
      interval = 1000 / Math.max(1, fps)
    },

    setHostSize(size) {
      hostSize = { ...size }
      for (const state of states) state.renderer.setHostSize(hostSize)
      compositor.invalidateAll()
    },

    setColors(next) {
      colors = { ...colors, ...next }
      for (const state of states) {
        state.renderer.setColors(colors)
        state.dirty = true
      }
      schedule()
    },

    invalidateAll() {
      for (const state of states) {
        state.renderer.invalidate()
        state.dirty = true
      }
      forceModes = hostModes !== NO_MODES
      schedule()
    },

    pause() {
      paused = true
      if (timer) clearTimeout(timer)
      timer = null
    },

    resume() {
      paused = false
      if (states.some((s) => s.dirty)) schedule()
    },

    renderFrame() {
      lastFrameAt = performance.now()
      return buildFrame()
    },

    flush() {
      if (disposed) return ''
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const frame = compositor.renderFrame()
      if (frame) write(frame)
      return frame
    },

    get stats() {
      return { ...stats }
    },

    restoreInputModes() {
      const reset = hostModeChanges(hostModes, NO_MODES)
      hostModes = NO_MODES
      return reset
    },

    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      for (const state of states) state.subscription.dispose()
      states.length = 0
    }
  }
  return compositor
}
