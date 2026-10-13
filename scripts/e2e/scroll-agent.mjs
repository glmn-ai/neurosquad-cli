// A stand-in agent for the dashboard's scrollback e2e (scripts/e2e-ci/scrollback.mjs).
//
//   node scripts/e2e/scroll-agent.mjs lines           prints `line 1` … `line 300` on the
//       normal screen, then `tick 1`, `tick 2`… every 400 ms — new output while the person
//       is scrolled back
//   node scripts/e2e/scroll-agent.mjs mouse <log>     asks for the mouse (SGR reports), prints
//       a few lines, and appends everything it reads on stdin to <log>
//   node scripts/e2e/scroll-agent.mjs alt <log>       full screen on the alternate screen, no
//       mouse; appends its stdin to <log> (a wheel notch arrives as cursor keys)
//   node scripts/e2e/scroll-agent.mjs text            a line to select and a link to click
//       (scripts/e2e-ci/selection.mjs)
import { appendFileSync, writeFileSync } from 'node:fs'

const [mode = 'lines', log] = process.argv.slice(2)
const out = (text) => process.stdout.write(text)

if (mode === 'text') {
  out('pick me: alpha beta gamma\r\n')
  out('docs at https://example.com/nsq/docs?x=1. thanks\r\n')
  setInterval(() => {}, 60_000)
} else if (mode === 'lines') {
  let text = ''
  for (let i = 1; i <= 300; i++) text += `line ${i}\r\n`
  out(text)
  let tick = 0
  setInterval(() => out(`tick ${++tick}\r\n`), 400)
} else {
  if (!log) throw new Error('scroll-agent: a log file is needed')
  writeFileSync(log, '')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (data) => appendFileSync(log, data))
  if (mode === 'mouse') {
    out('\x1b[?1000h\x1b[?1006h')
    for (let i = 1; i <= 5; i++) out(`mouse agent ${i}\r\n`)
  } else {
    out('\x1b[?1049h\x1b[H\x1b[2Jalt screen agent\r\n')
  }
  setInterval(() => {}, 60_000)
}
