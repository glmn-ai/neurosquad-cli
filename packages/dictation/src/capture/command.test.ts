import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBufferSource } from './buffer.js'
import { createCommandSource, findExecutable, recorderCandidates } from './command.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nsq-dictation-cmd-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('recorderCandidates', () => {
  it('asks every tool for 16 kHz mono s16le on stdout', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const candidates = recorderCandidates(platform)
      expect(candidates.length).toBeGreaterThan(0)
      for (const candidate of candidates) {
        expect(candidate.sampleRate).toBe(16000)
        expect(candidate.args.join(' ')).toMatch(/16000/)
      }
    }
  })

  it('offers dshow FFmpeg on Windows only with a device name', () => {
    expect(recorderCandidates('win32').map((c) => c.name)).toEqual(['sox'])
    const withDevice = recorderCandidates('win32', 'Microphone (USB)')
    expect(withDevice.map((c) => c.name)).toEqual(['sox', 'ffmpeg'])
    expect(withDevice[1].args).toContain('audio=Microphone (USB)')
  })

  it('prefers ALSA/Pulse/PipeWire tools on Linux', () => {
    expect(recorderCandidates('linux').map((c) => c.name)).toEqual([
      'arecord',
      'parecord',
      'pw-record',
      'sox',
      'ffmpeg'
    ])
  })
})

describe('findExecutable', () => {
  it('finds a binary on PATH', () => {
    const tool = join(dir, process.platform === 'win32' ? 'rec-tool.exe' : 'rec-tool')
    writeFileSync(tool, '#!/bin/sh')
    chmodSync(tool, 0o755)
    const env = { PATH: dir, PATHEXT: '.CMD;.EXE' }
    // Windows paths are case-insensitive; the match may carry PATHEXT's casing.
    expect(findExecutable('rec-tool', env)?.toLowerCase()).toBe(tool.toLowerCase())
    expect(findExecutable('missing', env)).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('skips .cmd shims on Windows', () => {
    writeFileSync(join(dir, 'shim.cmd'), '')
    expect(findExecutable('shim', { Path: dir, PATHEXT: '.CMD;.EXE' })).toBeUndefined()
  })

  it.runIf(process.platform !== 'win32')('skips files that are not executable', () => {
    writeFileSync(join(dir, 'plain'), '')
    chmodSync(join(dir, 'plain'), 0o644)
    expect(findExecutable('plain', { PATH: dir })).toBeUndefined()
  })
})

/** A stand-in recorder: writes s16le PCM in odd-sized pieces, then idles until killed. */
function fakeRecorderScript(samples: number[], exitEarly = false): string {
  const script = join(dir, 'fake-recorder.cjs')
  writeFileSync(
    script,
    `const values = ${JSON.stringify(samples)}
const buf = Buffer.alloc(values.length * 2)
values.forEach((v, i) => buf.writeInt16LE(v, i * 2))
let at = 0
const step = () => {
  if (at >= buf.length) {
    if (${exitEarly}) { process.stderr.write('device lost'); process.exit(3) }
    return
  }
  process.stdout.write(buf.subarray(at, at + 3))
  at += 3
  setTimeout(step, 1)
}
step()
setInterval(() => {}, 1000)
`
  )
  return script
}

describe('createCommandSource', () => {
  it('streams PCM from a child process and stops it', async () => {
    const values = [0, 16384, -16384, 32767, -32768, 1, 2, 3]
    const source = createCommandSource({
      name: 'fake',
      command: process.execPath,
      args: [fakeRecorderScript(values)],
      sampleRate: 16000
    })
    const received: number[] = []
    const errors: Error[] = []
    const info = await source.start(
      (samples) => received.push(...samples),
      (error) => errors.push(error)
    )
    expect(info).toEqual({ sampleRate: 16000, backend: 'fake' })
    for (let i = 0; i < 1000 && received.length < values.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await source.stop()
    expect(received).toEqual(values.map((v) => v / 32768))
    expect(errors).toEqual([])
  })

  it('reports a recorder that dies while recording', async () => {
    const source = createCommandSource({
      name: 'fake',
      command: process.execPath,
      args: [fakeRecorderScript([1, 2], true)],
      sampleRate: 16000
    })
    const error = await new Promise<Error>((resolve) => {
      void source.start(() => undefined, resolve)
    })
    expect(error.message).toMatch(/fake stopped unexpectedly \(exit 3\): device lost/)
    await source.stop()
  })

  it('rejects start() when the executable cannot be spawned', async () => {
    const source = createCommandSource({
      name: 'missing',
      command: join(dir, 'does-not-exist'),
      args: [],
      sampleRate: 16000
    })
    await expect(
      source.start(
        () => undefined,
        () => undefined
      )
    ).rejects.toThrow()
  })
})

describe('createBufferSource', () => {
  it('plays back samples in chunks and goes quiet after the end', async () => {
    const source = createBufferSource(Float32Array.from([1, 2, 3, 4, 5]), 8000, { chunkSamples: 2 })
    const chunks: number[][] = []
    await source.start(
      (samples) => chunks.push(Array.from(samples)),
      () => undefined
    )
    // Each chunk is its own setTimeout; Windows timers tick at ~15 ms, so a
    // fixed wait can end after two chunks. Wait for all three, then a little
    // longer to see that nothing more comes after the end.
    for (let i = 0; i < 200 && chunks.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    await source.stop()
    expect(chunks).toEqual([[1, 2], [3, 4], [5]])
  })
})
