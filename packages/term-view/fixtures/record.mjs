#!/usr/bin/env node
// Records the fake harnesses' output into gzipped asciicast v2 files
// (fixtures/<kind>.cast.gz) — the sample streams the tests and the benchmark
// replay. No real CLI, login or network is involved.
//
//   node fixtures/record.mjs [kind…] [--seconds 8]
//
// Output is captured from a pipe, byte for byte as the program wrote it, in
// the chunks the OS delivered — not through a pty, so recordings are the
// same on every OS (ConPTY on Windows would re-render them).

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const secondsIndex = args.indexOf('--seconds')
const seconds = secondsIndex === -1 ? 8 : Number(args[secondsIndex + 1])
const requested = args.filter((a, i) => !a.startsWith('--') && i !== secondsIndex + 1)
const kinds = requested.length ? requested : ['claude', 'codex', 'opencode', 'build', 'unicode']
const COLS = 120
const ROWS = 40

function record(kind) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(here, 'fake-harness.mjs'),
        kind,
        '--cols',
        String(COLS),
        '--rows',
        String(ROWS),
        '--seconds',
        String(seconds)
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )
    const decoder = new StringDecoder('utf8')
    const started = process.hrtime.bigint()
    const events = []
    child.stdout.on('data', (chunk) => {
      const data = decoder.write(chunk)
      if (data) events.push([Number(process.hrtime.bigint() - started) / 1e9, 'o', data])
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${kind} exited with ${code}`))
      const tail = decoder.end()
      if (tail) events.push([Number(process.hrtime.bigint() - started) / 1e9, 'o', tail])
      let text =
        JSON.stringify({ version: 2, width: COLS, height: ROWS, title: `fake-${kind}` }) + '\n'
      for (const [time, type, data] of events)
        text += JSON.stringify([Number(time.toFixed(6)), type, data]) + '\n'
      const file = join(here, `${kind}.cast.gz`)
      writeFileSync(file, gzipSync(text, { level: 9 }))
      const bytes = events.reduce((n, e) => n + Buffer.byteLength(e[2]), 0)
      console.log(`${kind}: ${events.length} chunks, ${bytes} bytes → ${file}`)
      resolve()
    })
  })
}

await Promise.all(kinds.map(record))
