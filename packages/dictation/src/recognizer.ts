// Offline speech recognition through sherpa-onnx (Apache-2.0,
// https://github.com/k2-fsa/sherpa-onnx). Only the async API is used
// (`OfflineRecognizer.createAsync`, `decodeAsync`): the sync variants block
// the event loop for seconds on load and hundreds of ms per decode, during
// which hotkey events and the TUI would stall.
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { compactSilence, limitChunkDuration, splitAtPauses } from './audioSegments.js'
import { MODEL_SAMPLE_RATE } from './audio.js'
import type { AsrFileRole, AsrModelDescriptor } from './models.js'
import type { NativeWork } from './nativeWork.js'

/** What the dictation pipeline needs from a recognizer. */
export interface AsrEngine {
  /**
   * Transcribes one utterance of 16 kHz mono samples. `quick` skips silence
   * compaction and splitting (used for live partial results).
   */
  transcribe(samples: Float32Array, options?: { quick?: boolean }): Promise<string>
}

interface OfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}

interface OfflineRecognizer {
  createStream(): OfflineStream
  decodeAsync(stream: OfflineStream): Promise<{ text: string }>
}

interface SherpaOnnxModule {
  OfflineRecognizer: { createAsync(config: unknown): Promise<OfflineRecognizer> }
}

let sherpaModule: SherpaOnnxModule | undefined

/** Loads `sherpa-onnx-node` on first use (it pulls in a native addon). */
function loadSherpa(): SherpaOnnxModule {
  if (!sherpaModule) {
    const require = createRequire(import.meta.url)
    sherpaModule = require('sherpa-onnx-node') as SherpaOnnxModule
  }
  return sherpaModule
}

/**
 * ONNX Runtime threads per decode. One decode scales poorly past a few
 * threads (it is memory-bound), so the parallelism comes from decoding
 * several chunks at once instead.
 */
export function defaultDecodeThreads(): number {
  return Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)))
}

function fileFor(model: AsrModelDescriptor, dir: string, role: AsrFileRole): string {
  const file = model.files.find((candidate) => candidate.role === role)
  if (!file) throw new Error(`model ${model.id} has no ${role} file`)
  return join(dir, file.name)
}

/** The sherpa-onnx `modelConfig` for one model. */
export function buildModelConfig(
  model: AsrModelDescriptor,
  dir: string,
  threads: number
): Record<string, unknown> {
  const shared = { tokens: fileFor(model, dir, 'tokens'), numThreads: threads, provider: 'cpu' }
  if (model.kind === 'whisper') {
    return {
      ...shared,
      whisper: {
        encoder: fileFor(model, dir, 'encoder'),
        decoder: fileFor(model, dir, 'decoder'),
        language: model.language ?? '',
        // 'transcribe', not 'translate': keep the spoken language.
        task: 'transcribe',
        tailPaddings: -1
      }
    }
  }
  return {
    ...shared,
    transducer: {
      encoder: fileFor(model, dir, 'encoder'),
      decoder: fileFor(model, dir, 'decoder'),
      joiner: fileFor(model, dir, 'joiner')
    },
    modelType: 'nemo_transducer'
  }
}

export interface LoadSherpaEngineOptions {
  model: AsrModelDescriptor
  dir: string
  work: NativeWork
  threads?: number
}

/** Loads the model (async, tracked) and runs one warm-up decode. */
export async function loadSherpaEngine(options: LoadSherpaEngineOptions): Promise<AsrEngine> {
  const { model, dir, work } = options
  const sherpa = loadSherpa()
  const recognizer = await work.start(() =>
    sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: MODEL_SAMPLE_RATE, featureDim: 80 },
      modelConfig: buildModelConfig(model, dir, options.threads ?? defaultDecodeThreads())
    })
  )

  const decode = async (chunk: Float32Array): Promise<string> => {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: MODEL_SAMPLE_RATE, samples: chunk })
    const result = await work.start(() => recognizer.decodeAsync(stream))
    return result.text.trim()
  }

  // ONNX Runtime defers a lot of work to the first run (kernel selection,
  // paging the weights in); do it now rather than on the first utterance.
  try {
    if (!work.isClosing) await decode(new Float32Array(MODEL_SAMPLE_RATE / 2))
  } catch {
    // Non-fatal: the first real decode simply pays that cost instead.
  }

  return {
    async transcribe(samples, transcribeOptions) {
      if (transcribeOptions?.quick) return decode(samples)
      const chunks = limitChunkDuration(
        splitAtPauses(compactSilence(samples), model.parallelDecodes, model.targetChunkSeconds),
        model.maxChunkSeconds
      )
      if (chunks.length === 1) return decode(chunks[0])
      const parallel = Math.max(1, Math.floor(model.parallelDecodes) || 1)
      const texts: string[] = []
      for (let at = 0; at < chunks.length; at += parallel) {
        const batch = chunks.slice(at, at + parallel)
        texts.push(...(await Promise.all(batch.map(decode))))
      }
      return texts
        .filter((text) => text.length > 0)
        .join(' ')
        .trim()
    }
  }
}
