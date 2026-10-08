#!/usr/bin/env node
// Benchmark: 9 agent tiles fed with the recorded sample streams.
//
//   npm run build && node packages/term-view/bench/bench.mjs [--speed 1] [--fps 30]
//       [--cols 240 --rows 66] [--depth truecolor|256|16] [--tty] [--async] [--json] [--out file]
//
// Nine views (120×40 each, the fake harnesses' size) replay the recordings
// in virtual time; a compositor paints them as a 3×3 grid of cropped tiles
// into a host terminal of --cols × --rows at --fps. For every frame it
// measures the time to parse the output that arrived (xterm) and the time to
// build the frame (snapshot + diff), and the bytes the frame would send.
// --speed 4 replays the same output four times faster (a stress test).
// --tty writes the frames to this terminal in real time (to watch it, e.g.
// in Windows Terminal) and also measures how long the writes take.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'dist', 'index.js')).href)
const { createTermView, createCompositor, parseCast } = lib

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const SPEED = Number(opt('speed', 1))
const FPS = Number(opt('fps', 30))
const onTty = args.includes('--tty') && process.stdout.isTTY
const HOST_COLS = Number(opt('cols', onTty ? process.stdout.columns : 240))
const HOST_ROWS = Number(opt('rows', onTty ? process.stdout.rows : 66))
const depthArg = opt('depth', 'truecolor')
const DEPTH = depthArg === '256' ? 256 : depthArg === '16' ? 16 : depthArg
const TTY = args.includes('--tty')
// xterm parses asynchronously (setTimeout batches). On Windows an idle event
// loop sleeps in ~15 ms timer ticks, so the wall time of an async parse is
// mostly waiting, not work. By default the benchmark parses synchronously
// (xterm's internal writeSync, bench only) to measure the actual CPU cost;
// --async measures the end-to-end latency instead.
const ASYNC = args.includes('--async')
const JSON_OUT = args.includes('--json')

const KINDS = [
  'claude',
  'codex',
  'opencode',
  'build',
  'unicode',
  'claude',
  'codex',
  'opencode',
  'build'
]
const casts = new Map()
for (const kind of new Set(KINDS)) {
  const gz = readFileSync(join(here, '..', 'fixtures', `${kind}.cast.gz`))
  casts.set(kind, parseCast(gunzipSync(gz).toString('utf8')))
}

const heapBefore = process.memoryUsage().heapUsed
const agents = KINDS.map((kind, i) => {
  const cast = casts.get(kind)
  // Stagger the copies so two agents of one kind are not in lockstep.
  const offset = i >= 5 ? 1.3 : 0
  return {
    kind,
    view: (() => {
      const view = createTermView({
        cols: cast.header.width,
        rows: cast.header.height,
        scrollback: 1000
      })
      view.terminal.options.logLevel = 'off' // writeSync warns that it is internal
      return view
    })(),
    events: cast.events.map((e) => ({ time: (e.time + offset) / SPEED, data: e.data })),
    next: 0
  }
})

const ttyWrites = []
const compositor = createCompositor({
  write: (frame) => {
    if (!TTY) return
    const started = performance.now()
    process.stdout.write(frame)
    ttyWrites.push(performance.now() - started)
  },
  fps: FPS,
  paused: true, // frames are driven by the virtual clock below
  colors: { depth: DEPTH }
})

const tileW = Math.floor((HOST_COLS - 2) / 3)
const tileH = Math.floor((HOST_ROWS - 2) / 3)
agents.forEach((agent, i) => {
  const col = i % 3
  const row = Math.floor(i / 3)
  agent.tile = compositor.addTile(agent.view, {
    x: col * (tileW + 1),
    y: row * (tileH + 1),
    width: tileW,
    height: tileH
  })
})

if (TTY) process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J')

const frameInterval = 1000 / FPS
const duration = Math.max(...agents.map((a) => a.events.at(-1)?.time ?? 0)) * 1000 + frameInterval
const parseTimes = []
const frameTimes = []
const frameBytes = []
let inputBytes = 0
const wallStart = performance.now()
const cpuStart = process.cpuUsage()

for (let t = 0; t <= duration; t += frameInterval) {
  const parseStarted = performance.now()
  const flushes = []
  for (const agent of agents) {
    let wrote = false
    while (agent.next < agent.events.length && agent.events[agent.next].time * 1000 <= t) {
      const data = agent.events[agent.next++].data
      inputBytes += data.length
      if (ASYNC) agent.view.write(data)
      else agent.view.terminal._core.writeSync(data)
      wrote = true
    }
    if (wrote && !ASYNC) agent.tile.update() // writeSync does not fire onWriteParsed
    if (wrote && ASYNC) flushes.push(agent.view.flush())
  }
  await Promise.all(flushes)
  const parsed = performance.now()
  const frame = compositor.flush()
  parseTimes.push(parsed - parseStarted)
  if (frame) {
    frameTimes.push(compositor.stats.lastFrameMs)
    frameBytes.push(Buffer.byteLength(frame))
  }
  if (TTY) {
    // Real-time pacing so the frames can be watched.
    const due = wallStart + t + frameInterval
    const wait = due - performance.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
}

const wallMs = performance.now() - wallStart
const cpu = process.cpuUsage(cpuStart)
if (TTY) process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l')

const heapAfter = process.memoryUsage().heapUsed
const pct = (list, p) => {
  if (list.length === 0) return 0
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
const sum = (list) => list.reduce((a, b) => a + b, 0)
const virtualSeconds = duration / 1000
const workMs = sum(parseTimes) + sum(frameTimes)
const result = {
  platform: `${process.platform} ${process.arch}, node ${process.version}`,
  tiles: agents.length,
  host: `${HOST_COLS}x${HOST_ROWS}`,
  tile: `${tileW}x${tileH}`,
  agentScreen: '120x40',
  fps: FPS,
  speed: SPEED,
  depth: DEPTH,
  streamSeconds: Number(virtualSeconds.toFixed(2)),
  inputKiBPerSecond: Number((inputBytes / 1024 / virtualSeconds).toFixed(1)),
  framesPainted: frameTimes.length,
  frameTicks: parseTimes.length,
  frameBuildMs: {
    p50: +pct(frameTimes, 50).toFixed(2),
    p95: +pct(frameTimes, 95).toFixed(2),
    max: +Math.max(0, ...frameTimes).toFixed(2)
  },
  parseMode: ASYNC ? 'async (wall time incl. timer waits)' : 'sync (CPU)',
  parseMsPerTick: {
    p50: +pct(parseTimes, 50).toFixed(2),
    p95: +pct(parseTimes, 95).toFixed(2),
    max: +Math.max(0, ...parseTimes).toFixed(2)
  },
  bytesPerFrame: {
    avg: Math.round(sum(frameBytes) / Math.max(1, frameBytes.length)),
    max: Math.max(0, ...frameBytes)
  },
  outputKiBPerSecond: Number((sum(frameBytes) / 1024 / virtualSeconds).toFixed(1)),
  // Share of the frame budget (1000/fps ms per tick) spent parsing + building frames.
  budgetUsedPercent: Number(((workMs / (parseTimes.length * frameInterval)) * 100).toFixed(1)),
  cpuPercentOfStreamTime: Number(
    (((cpu.user + cpu.system) / 1000 / (TTY ? wallMs : virtualSeconds * 1000)) * 100).toFixed(1)
  ),
  ttyWriteMs: TTY
    ? {
        p50: +pct(ttyWrites, 50).toFixed(2),
        p95: +pct(ttyWrites, 95).toFixed(2),
        max: +Math.max(0, ...ttyWrites).toFixed(2)
      }
    : undefined,
  realFps: TTY ? Number((frameTimes.length / (wallMs / 1000)).toFixed(1)) : undefined,
  heapMiB: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(1))
}

const OUT = opt('out', '')
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2))
if (JSON_OUT) console.log(JSON.stringify(result))
else
  console.table(
    Object.entries(result).map(([k, v]) => ({
      metric: k,
      value: typeof v === 'object' ? JSON.stringify(v) : v
    }))
  )
