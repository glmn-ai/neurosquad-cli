#!/usr/bin/env node
// Records the fake harnesses' output into gzipped asciicast v2 files
// (fixtures/<kind>.cast.gz) — the sample streams the tests and the benchmark
// replay. No real CLI, login or network is involved.
//
//   node fixtures/record.mjs [kind…] [--seconds 8]
//
// The harnesses run on a virtual clock (`--cast`): one event per write with
// virtual timestamps, so a re-recording is byte-identical on every machine
// and OS (no timer jitter, no pipe chunking, no ConPTY re-rendering).

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const secondsIndex = args.indexOf('--seconds')
const seconds = secondsIndex === -1 ? 8 : Number(args[secondsIndex + 1])
if (!Number.isFinite(seconds) || seconds <= 0)
  throw new Error('--seconds must be a positive number')
const requested = args.filter((a, i) => !a.startsWith('--') && i !== secondsIndex + 1)
const kinds = requested.length ? requested : ['claude', 'codex', 'opencode', 'build', 'unicode']

for (const kind of kinds) {
  const text = execFileSync(
    process.execPath,
    [
      join(here, 'fake-harness.mjs'),
      kind,
      '--cols',
      '120',
      '--rows',
      '40',
      '--seconds',
      String(seconds),
      '--cast'
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const file = join(here, `${kind}.cast.gz`)
  // mtime 0 in the gzip header keeps the file identical across runs.
  writeFileSync(file, gzipSync(text, { level: 9 }))
  const lines = text.trimEnd().split('\n').length - 1
  console.log(`${kind}: ${lines} events, ${Buffer.byteLength(text)} bytes of cast → ${file}`)
}
