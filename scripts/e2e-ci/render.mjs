// Turns the dashboard recordings of every OS into pictures:
//
//   <label>/dashboard.gif   the whole session (agg, idle time capped)
//   <label>/dashboard.mp4   the same as video (ffmpeg, when present)
//   <label>/<shot>.png      a screenshot at each moment tui-record.mjs marked
//                           (tui-theme's term-dump + render-frames, Pillow)
//
// <label> is the name of the folder holding shots.json (the artifact name).
//
//   node scripts/e2e-ci/render.mjs --in <dir> --out <dir> --agg <agg binary>
//        [--root <repo under test, for term-dump>] [--python python3]
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { args, rootFrom } from './lib.mjs'

const { get } = args()
const root = rootFrom(get)
const input = resolve(get('in'))
const out = resolve(get('out'))
const agg = get('agg')
const python = get('python', 'python3')
const termDump = join(root, 'packages', 'tui-theme', 'scripts', 'term-dump.mjs')
const renderFrames = join(root, 'packages', 'tui-theme', 'scripts', 'render-frames.py')
const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

const recordings = []
const walk = (at) => {
  for (const name of readdirSync(at)) {
    const path = join(at, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name === 'shots.json') recordings.push(dirname(path))
  }
}
walk(input)

let failed = 0
for (const dir of recordings) {
  // e.g. <in>/e2e-dashboard-macos-15-arm64/recording → e2e-dashboard-macos-15-arm64
  const label = basename(dir) === 'recording' ? basename(dirname(dir)) : basename(dir)
  const target = join(out, label.replace(/^e2e-dashboard-/, ''))
  mkdirSync(target, { recursive: true })
  const meta = JSON.parse(readFileSync(join(dir, 'shots.json'), 'utf8'))
  const cast = join(dir, 'dashboard.cast')
  if (existsSync(cast)) {
    copyFileSync(cast, join(target, 'dashboard.cast'))
    const gif = join(target, 'dashboard.gif')
    const result = spawnSync(
      agg,
      [
        '--quiet',
        '--font-size',
        '14',
        '--line-height',
        '1.2',
        '--idle-time-limit',
        '2',
        '--last-frame-duration',
        '5',
        '--theme',
        'github-dark',
        cast,
        gif
      ],
      { stdio: 'inherit' }
    )
    if (result.status !== 0) {
      console.error(`agg failed for ${label}`)
      failed++
    } else if (ffmpeg) {
      const video = spawnSync(
        'ffmpeg',
        [
          '-loglevel',
          'error',
          '-y',
          '-i',
          gif,
          '-movflags',
          'faststart',
          '-pix_fmt',
          'yuv420p',
          '-vf',
          'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          join(target, 'dashboard.mp4')
        ],
        { stdio: 'inherit' }
      )
      if (video.status !== 0) {
        console.error(`ffmpeg failed for ${label}`)
        failed++
      }
    }
  }
  if (!existsSync(termDump) || !existsSync(renderFrames)) {
    console.warn('no term-dump/render-frames in this build: PNG screenshots skipped')
    continue
  }
  for (const shot of meta.shots) {
    const ansi = join(dir, `${shot}.ansi`)
    const json = join(target, `${shot}.json`)
    try {
      execFileSync(
        process.execPath,
        [termDump, ansi, json, `--cols=${meta.cols}`, `--rows=${meta.rows}`],
        { stdio: 'inherit', cwd: join(root, 'packages', 'tui-theme') }
      )
      execFileSync(python, [renderFrames, json, join(target, `${shot}.png`)], { stdio: 'inherit' })
      rmSync(json, { force: true })
    } catch (error) {
      console.error(`screenshot ${label}/${shot} failed: ${String(error).slice(0, 300)}`)
      failed++
    }
  }
}
console.log(`rendered ${recordings.length} recording(s) into ${out}`)
process.exitCode = failed ? 1 : 0
