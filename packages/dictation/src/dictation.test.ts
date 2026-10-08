import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeWav, encodeWav } from './audio.js'
import { createBufferSource } from './capture/buffer.js'
import type { AudioSource } from './capture/types.js'
import {
  createDictation,
  normalizeTranscript,
  type DictationOptions,
  type DictationState,
  type DictationStateInfo
} from './dictation.js'
import type { FetchLike } from './download.js'
import type { KeyEvent, KeyHook } from './hotkey/listener.js'
import { KEY_BY_NAME } from './hotkey/keycodes.js'
import type { AsrModelDescriptor } from './models.js'
import type { AsrEngine, LoadSherpaEngineOptions } from './recognizer.js'

const FILE_DATA = new TextEncoder().encode('fake model bytes')
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

const MODEL: AsrModelDescriptor = {
  id: 'test-model',
  kind: 'whisper',
  name: 'Test model',
  vendor: 'test',
  params: '0',
  license: 'MIT',
  attribution: 'test',
  dirName: 'test-model',
  files: (['encoder', 'decoder', 'tokens'] as const).map((role) => ({
    name: `${role}.bin`,
    role,
    url: `https://models.invalid/${role}.bin`,
    bytes: FILE_DATA.length,
    sha256: sha256(FILE_DATA)
  })),
  targetChunkSeconds: 8,
  parallelDecodes: 2,
  maxChunkSeconds: 0
}

/**
 * A synthesized utterance as a WAV file: 44.1 kHz, three "words" (voiced
 * harmonic bursts with an amplitude envelope) separated by pauses.
 */
function synthesizedUtteranceWav(rate = 44100): Uint8Array {
  const seconds = 2
  const samples = new Float32Array(rate * seconds)
  const words = [
    [0.2, 0.55, 140],
    [0.8, 1.2, 180],
    [1.4, 1.8, 120]
  ]
  for (const [from, to, pitch] of words) {
    for (let i = Math.floor(from * rate); i < to * rate; i++) {
      const t = i / rate
      const envelope = Math.sin((Math.PI * (t - from)) / (to - from))
      let value = 0
      for (let harmonic = 1; harmonic <= 5; harmonic++) {
        value += Math.sin(2 * Math.PI * pitch * harmonic * t) / harmonic
      }
      samples[i] = 0.3 * envelope * value
    }
  }
  return encodeWav(samples, rate)
}

interface FakeEngine {
  create: (options: LoadSherpaEngineOptions) => Promise<AsrEngine>
  received: Float32Array[]
  loads: number
  /** When set, decodes wait for this before resolving. */
  gate?: Promise<void>
}

function fakeEngine(reply: (samples: Float32Array) => string): FakeEngine {
  const engine: FakeEngine = {
    received: [],
    loads: 0,
    async create({ work }) {
      engine.loads++
      await work.start(async () => undefined)
      return {
        transcribe: (samples) =>
          // Like the real engine: every native call goes through the tracker.
          work.start(async () => {
            if (engine.gate) await engine.gate
            engine.received.push(samples)
            return reply(samples)
          })
      }
    }
  }
  return engine
}

class FakeHook extends EventEmitter implements KeyHook {
  start(): void {}
  stop(): void {}
  tap(keycode: number): void {
    this.emit('keydown', { keycode } satisfies KeyEvent)
    this.emit('keyup', { keycode } satisfies KeyEvent)
  }
}

let modelsDir: string
beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), 'nsq-dictation-'))
})
afterEach(() => {
  rmSync(modelsDir, { recursive: true, force: true })
})

function installModel(): void {
  const dir = join(modelsDir, MODEL.dirName)
  mkdirSync(dir, { recursive: true })
  for (const file of MODEL.files) writeFileSync(join(dir, file.name), FILE_DATA)
}

function setup(overrides: Partial<DictationOptions> = {}, wav = synthesizedUtteranceWav()) {
  const { sampleRate, samples } = decodeWav(wav)
  const engine = fakeEngine(() => 'Hello,\nworld\u001b[0m\r\n')
  const texts: string[] = []
  const states: { state: DictationState; info?: DictationStateInfo }[] = []
  const dictation = createDictation({
    modelsDir,
    model: MODEL,
    audioSource: createBufferSource(samples, sampleRate, { chunkSamples: samples.length }),
    createEngine: engine.create,
    onText: (text) => texts.push(text),
    onState: (state, info) => states.push({ state, info }),
    ...overrides
  })
  return { dictation, engine, texts, states, sampleRate, samples }
}

/** Lets the buffer source deliver everything (it pumps on timers). */
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

describe('createDictation pipeline', () => {
  it('records a WAV, resamples to 16 kHz and emits one clean line of text', async () => {
    installModel()
    const { dictation, engine, texts, states, samples, sampleRate } = setup()
    await dictation.start()
    expect(dictation.state).toBe('recording')
    await drain()
    await dictation.stop()

    expect(engine.received).toHaveLength(1)
    const received = engine.received[0]
    expect(received.length).toBe(Math.floor((samples.length * 16000) / sampleRate))
    // Text goes out as-is for pasting: no newline, no escape sequences, nothing that submits.
    expect(texts).toEqual(['Hello, world [0m'])
    expect(texts[0]).not.toMatch(/[\r\n]/)
    expect(texts[0]).not.toContain(String.fromCharCode(27))
    expect(states.map((s) => s.state)).toEqual(['recording', 'transcribing', 'idle'])
    expect(states[0].info?.capture).toEqual({ sampleRate: 44100, backend: 'buffer' })
    await dictation.dispose()
  })

  it('loads the model once, while the first utterance is being recorded', async () => {
    installModel()
    const { dictation, engine } = setup()
    await dictation.start()
    expect(engine.loads).toBe(1)
    await drain()
    await dictation.stop()
    await dictation.start()
    await drain()
    await dictation.stop()
    expect(engine.loads).toBe(1)
    expect(engine.received).toHaveLength(2)
    await dictation.dispose()
  })

  it('treats an accidental tap (too little audio) as nothing', async () => {
    installModel()
    const { dictation, engine, texts, states } = setup({
      audioSource: createBufferSource(new Float32Array(100), 16000)
    })
    await dictation.start()
    await drain()
    await dictation.stop()
    expect(engine.received).toHaveLength(0)
    expect(texts).toEqual([])
    expect(states.at(-1)?.state).toBe('idle')
    await dictation.dispose()
  })

  it('keeps an utterance when a new recording starts while the recorder is still stopping', async () => {
    installModel()
    const { samples, sampleRate } = decodeWav(synthesizedUtteranceWav())
    const inner = createBufferSource(samples, sampleRate, { chunkSamples: samples.length })
    let releaseStop!: () => void
    let slowStop = true
    const source: AudioSource = {
      start: (onSamples, onError) => inner.start(onSamples, onError),
      stop: async () => {
        await inner.stop()
        if (slowStop) await new Promise<void>((resolve) => (releaseStop = resolve))
      }
    }
    const { dictation, engine } = setup({ audioSource: source })
    await dictation.start()
    await drain()
    const firstStop = dictation.stop()
    await drain()
    slowStop = false
    await dictation.start() // starts while the first stop is still awaiting the recorder
    releaseStop()
    await firstStop
    expect(engine.received).toHaveLength(1)
    expect(engine.received[0].length).toBe(32000)
    await dictation.cancel()
    await dictation.dispose()
  })

  it('cancel() discards the audio', async () => {
    installModel()
    const { dictation, engine, texts } = setup()
    await dictation.start()
    await drain()
    await dictation.cancel()
    expect(engine.received).toHaveLength(0)
    expect(texts).toEqual([])
    expect(dictation.state).toBe('idle')
    await dictation.dispose()
  })

  it('does not emit empty transcripts', async () => {
    installModel()
    const engine = fakeEngine(() => '  \n ')
    const { dictation, texts } = setup({ createEngine: engine.create })
    await dictation.start()
    await drain()
    await dictation.stop()
    expect(texts).toEqual([])
    await dictation.dispose()
  })

  it('reports a missing model instead of recording', async () => {
    const { dictation, states } = setup()
    await dictation.start()
    expect(states.map((s) => s.state)).toEqual(['error', 'idle'])
    expect(states[0].info?.error?.code).toBe('model-missing')
    await dictation.dispose()
  })

  it('downloads a missing model on demand (autoDownload) with progress', async () => {
    const requested: string[] = []
    const fetch: FetchLike = async (url) => {
      requested.push(url)
      return new Response(FILE_DATA, { status: 200 })
    }
    const { dictation, states } = setup({ autoDownload: true, fetch })
    expect(dictation.isModelInstalled()).toBe(false)
    await dictation.start()
    await dictation.ensureModel()
    expect(dictation.isModelInstalled()).toBe(true)
    expect(requested).toHaveLength(3)
    const downloads = states.filter((s) => s.state === 'downloading')
    expect(downloads.length).toBeGreaterThan(0)
    expect(downloads.at(-1)?.info?.download).toMatchObject({ done: true, fraction: 1 })
    expect(states.at(-1)?.state).toBe('idle')
    // Now dictation works.
    await dictation.start()
    expect(dictation.state).toBe('recording')
    await dictation.cancel()
    await dictation.dispose()
  })

  it('reports a failed download', async () => {
    const fetch: FetchLike = async () => new Response('nope', { status: 503 })
    const { dictation, states } = setup({ fetch })
    await dictation.ensureModel()
    const error = states.find((s) => s.state === 'error')?.info?.error
    expect(error?.code).toBe('download-failed')
    expect(error?.message).toMatch(/HTTP 503/)
    expect(dictation.state).toBe('idle')
    await dictation.dispose()
  })

  it('reports a model that fails to load', async () => {
    installModel()
    const { dictation, states } = setup({
      createEngine: async () => {
        throw new Error('bad model file')
      }
    })
    await dictation.start()
    await drain()
    await dictation.stop()
    const errors = states.filter((s) => s.state === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].info?.error?.code).toBe('model-load-failed')
    expect(errors[0].info?.error?.message).toMatch(/bad model file/)
    expect(dictation.state).toBe('idle')
    await dictation.dispose()
  })

  it('reports a microphone that cannot be opened', async () => {
    installModel()
    const broken: AudioSource = {
      start: async () => {
        throw new Error('permission denied')
      },
      stop: async () => undefined
    }
    const { dictation, states } = setup({ audioSource: broken })
    await dictation.start()
    expect(states.map((s) => s.state)).toEqual(['error', 'idle'])
    expect(states[0].info?.error?.code).toBe('mic-failed')
    await dictation.dispose()
  })

  it('drives start/stop from the global hotkey', async () => {
    installModel()
    const hook = new FakeHook()
    const { dictation, texts } = setup({
      hotkey: { accelerator: 'F9', mode: 'toggle' },
      keyHook: hook
    })
    expect(dictation.hotkeyActive).toBe(true)
    hook.tap(KEY_BY_NAME.F9)
    await drain()
    expect(dictation.state).toBe('recording')
    hook.tap(KEY_BY_NAME.F9)
    for (let i = 0; i < 50 && texts.length === 0; i++) await drain()
    expect(texts).toEqual(['Hello, world [0m'])
    await dictation.dispose()
    expect(hook.listenerCount('keydown')).toBe(0)
  })

  it('keeps working without a hotkey when the hook cannot start', async () => {
    installModel()
    const hook = new FakeHook()
    hook.start = () => {
      throw new Error('no display')
    }
    const { dictation, states } = setup({ hotkey: 'F9', keyHook: hook })
    await Promise.resolve()
    expect(dictation.hotkeyActive).toBe(false)
    expect(states[0].info?.error?.code).toBe('hotkey-unavailable')
    await dictation.toggle()
    expect(dictation.state).toBe('recording')
    await dictation.dispose()
  })

  it('emits partial results while recording', async () => {
    installModel()
    const partials: string[] = []
    const { dictation } = setup({
      partialIntervalMs: 20,
      onPartial: (text) => partials.push(text),
      audioSource: (() => {
        const { samples, sampleRate } = decodeWav(synthesizedUtteranceWav())
        return createBufferSource(samples, sampleRate, { chunkSamples: 4410, realtime: true })
      })()
    })
    await dictation.start()
    for (let i = 0; i < 40 && partials.length === 0; i++) await drain()
    expect(partials.length).toBeGreaterThan(0)
    expect(partials[0]).toBe('Hello, world [0m')
    await dictation.cancel()
    await dictation.dispose()
  })

  it('stops automatically at maxRecordingSeconds', async () => {
    installModel()
    const { dictation, engine } = setup({ maxRecordingSeconds: 0.5 })
    await dictation.start()
    for (let i = 0; i < 20 && engine.received.length === 0; i++) await drain()
    expect(engine.received).toHaveLength(1)
    expect(engine.received[0].length).toBeLessThan(16000 * 0.7)
    expect(dictation.state).toBe('idle')
    await dictation.dispose()
  })

  it('dispose() waits for an in-flight decode before resolving', async () => {
    installModel()
    const { dictation, engine, states } = setup()
    let release!: () => void
    engine.gate = new Promise<void>((resolve) => (release = resolve))
    await dictation.start()
    await drain()
    const stopping = dictation.stop()
    await drain()
    let disposed = false
    const disposing = dictation.dispose(5000).then((result) => {
      disposed = true
      return result
    })
    await drain()
    expect(disposed).toBe(false)
    release()
    const result = await disposing
    await stopping
    expect(result.idle).toBe(true)
    expect(result.waited).toBeGreaterThanOrEqual(1)
    expect(states.at(-1)?.state).toBe('disposed')
    // Nothing starts after dispose.
    await dictation.start()
    expect(dictation.state).toBe('disposed')
  })

  it('rejects an unknown model id', () => {
    expect(() =>
      createDictation({
        modelsDir,
        model: 'nope',
        onText: () => undefined,
        onState: () => undefined
      })
    ).toThrow(/unknown dictation model/)
  })
})

describe('normalizeTranscript', () => {
  it('collapses newlines and strips control characters', () => {
    expect(normalizeTranscript(' a\r\nb\tc\u0003d\u001b[2J \u009b ')).toBe('a b c d [2J')
  })
})
