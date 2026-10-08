// Opt-in end-to-end test with a real (small) model and real speech:
//   NSQ_DICTATION_REAL_MODEL=1 npx vitest run packages/dictation/src/recognizer.real.test.ts
// Downloads ~104 MB (Whisper tiny.en int8, MIT) into NSQ_DICTATION_MODELS_DIR,
// or into a temporary directory that is deleted afterwards.
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decodeWav } from './audio.js'
import { createBufferSource } from './capture/buffer.js'
import { createDictation } from './dictation.js'
import type { AsrModelDescriptor } from './models.js'

const REPO =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/d026532c022fa99fd789d6b32446a1df7b6bfc43'

const WHISPER_TINY_EN: AsrModelDescriptor = {
  id: 'whisper-tiny.en-test',
  kind: 'whisper',
  name: 'Whisper tiny.en (test)',
  vendor: 'OpenAI',
  params: '39M',
  license: 'MIT',
  attribution: 'OpenAI Whisper tiny.en, licensed under MIT.',
  dirName: 'sherpa-onnx-whisper-tiny.en',
  files: [
    {
      name: 'tiny.en-encoder.int8.onnx',
      role: 'encoder',
      url: `${REPO}/tiny.en-encoder.int8.onnx`,
      bytes: 12937772,
      sha256: '0ce578b827c94a961aacb8fa14b02f096504b337e5c94be37c36238cbe3e8bc6'
    },
    {
      name: 'tiny.en-decoder.int8.onnx',
      role: 'decoder',
      url: `${REPO}/tiny.en-decoder.int8.onnx`,
      bytes: 89853865,
      sha256: '06c0e6ff6348d427e51839219d1c886c18cfdf411e629e33f5e1679bff9c1527'
    },
    {
      name: 'tiny.en-tokens.txt',
      role: 'tokens',
      url: `${REPO}/tiny.en-tokens.txt`,
      bytes: 835554,
      sha256: '306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930'
    }
  ],
  targetChunkSeconds: 25,
  parallelDecodes: 1,
  maxChunkSeconds: 28,
  language: 'en'
}

const SPEECH_WAV = {
  url: `${REPO}/test_wavs/0.wav`,
  sha256: '6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f'
}

const enabled = process.env.NSQ_DICTATION_REAL_MODEL === '1'
const ownDir = enabled && !process.env.NSQ_DICTATION_MODELS_DIR
const modelsDir = enabled
  ? (process.env.NSQ_DICTATION_MODELS_DIR ?? mkdtempSync(join(tmpdir(), 'nsq-dictation-real-')))
  : ''

afterAll(() => {
  if (ownDir) rmSync(modelsDir, { recursive: true, force: true })
})

describe.runIf(enabled)('real sherpa-onnx recognizer (opt-in)', () => {
  it('downloads a model, transcribes real speech and shuts down cleanly', async () => {
    const response = await fetch(SPEECH_WAV.url)
    const wav = new Uint8Array(await response.arrayBuffer())
    expect(createHash('sha256').update(wav).digest('hex')).toBe(SPEECH_WAV.sha256)
    const { samples, sampleRate } = decodeWav(wav)

    const texts: string[] = []
    const errors: string[] = []
    const dictation = createDictation({
      modelsDir,
      model: WHISPER_TINY_EN,
      audioSource: createBufferSource(samples, sampleRate, { chunkSamples: samples.length }),
      onText: (text) => texts.push(text),
      onState: (state, info) => {
        if (state === 'error') errors.push(info?.error?.message ?? 'error')
      }
    })
    await dictation.ensureModel()
    expect(dictation.isModelInstalled()).toBe(true)
    await dictation.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await dictation.stop()
    const result = await dictation.dispose()

    expect(errors).toEqual([])
    expect(result.idle).toBe(true)
    expect(texts).toHaveLength(1)
    // Reference: "AFTER EARLY NIGHTFALL THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE ..."
    expect(texts[0].toLowerCase()).toMatch(/yellow lamps/)
  }, 600_000)
})
