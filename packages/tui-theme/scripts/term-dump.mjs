// Replays terminal output (a raw ANSI file, or an asciinema v2 .cast) through @xterm/headless and
// dumps the cell grid as JSON, for scripts/render-frames.py to turn into PNG / GIF screenshots.
//
//   node scripts/term-dump.mjs <in.ansi|in.cast> <out.json> --cols=130 --rows=60 [--fps=15]
//
// iTerm2 inline images (OSC 1337) are recorded with the cursor cell they were drawn at, so the
// renderer can paint the real logo PNG there: a protocol-driven screenshot, not a mock-up.
// Maintainer tool: needs the repo's dev dependency @xterm/headless.
import { readFileSync, writeFileSync } from 'node:fs'
import xterm from '@xterm/headless'

const [input, output, ...rest] = process.argv.slice(2)
const opt = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')))
const cols = Number(opt.cols ?? 130)
const rows = Number(opt.rows ?? 60)
const fps = Number(opt.fps ?? 15)

const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
const images = []
term.parser.registerOscHandler(1337, (data) => {
  const b = term.buffer.active
  const m = /^File=([^:]*):(.*)$/s.exec(data)
  if (m) images.push({ x: b.cursorX, y: b.cursorY, png: m[2] })
  return true
})
const write = (data) => new Promise((resolve) => term.write(data, resolve))

function snapshot() {
  const b = term.buffer.active
  const cell = b.getNullCell()
  const color = (isRgb, isPalette, value) => (isRgb ? value : isPalette ? -100 - value : -1)
  const grid = []
  for (let y = 0; y < rows; y++) {
    const line = b.getLine(y)
    const row = []
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell)
      row.push([
        cell.getChars(),
        cell.getWidth(),
        color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor()),
        color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor()),
        (cell.isBold() ? 1 : 0) | (cell.isInverse() ? 2 : 0) | (cell.isDim() ? 4 : 0)
      ])
    }
    grid.push(row)
  }
  return { grid, images: images.slice() }
}

const text = readFileSync(input, 'utf8')
const frames = []
if (input.endsWith('.cast')) {
  const events = text
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => JSON.parse(l))
  const end = events[events.length - 1][0]
  let i = 0
  for (let t = 0; t <= end + 1e-9; t += 1 / fps) {
    while (i < events.length && events[i][0] <= t + 1e-9) await write(events[i++][2])
    frames.push({ t, ...snapshot() })
  }
} else {
  await write(text.replace(/\r?\n/g, '\r\n'))
  frames.push({ t: 0, ...snapshot() })
}
writeFileSync(output, JSON.stringify({ cols, rows, frames }))
console.log(`${frames.length} frame(s) -> ${output}`)
