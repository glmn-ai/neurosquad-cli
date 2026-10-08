// The dictation pipeline: hotkey -> microphone -> resample to 16 kHz ->
// sherpa-onnx -> `onText`. The text is handed to the app, which pastes it
// where it belongs; nothing here ever presses Enter.
import { MODEL_SAMPLE_RATE, resample } from './audio.js'
import { createMicSource, MicUnavailableError, type MicOptions } from './capture/index.js'
import type { AudioSource, CaptureInfo } from './capture/types.js'
import { HotkeyListener, type HotkeyMode, type KeyHook } from './hotkey/listener.js'
import { loadUiohook } from './hotkey/uiohook.js'
import { DEFAULT_ASR_MODEL_ID, getAsrModel, type AsrModelDescriptor } from './models.js'
import {
  downloadModel,
  isModelInstalled,
  modelDir,
  type DownloadModelOptions,
  type DownloadProgress
} from './modelStore.js'
import { NativeWork } from './nativeWork.js'
import { loadSherpaEngine, type AsrEngine, type LoadSherpaEngineOptions } from './recognizer.js'

export type DictationState =
  | 'idle'
  | 'downloading'
  | 'recording'
  | 'transcribing'
  /** Transient: always followed by the state the pipeline settles in. */
  | 'error'
  | 'disposed'

export type DictationErrorCode =
  | 'unknown-model'
  | 'model-missing'
  | 'download-failed'
  | 'model-load-failed'
  | 'mic-unavailable'
  | 'mic-failed'
  | 'hotkey-unavailable'
  | 'transcribe-failed'

export class DictationError extends Error {
  constructor(
    readonly code: DictationErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'DictationError'
  }
}

export interface DictationStateInfo {
  error?: DictationError
  /** With `recording`: which backend/device is capturing. */
  capture?: CaptureInfo
  /** With `downloading`: progress of the model download. */
  download?: DownloadProgress
}

export interface HotkeyOptions {
  /** Electron-style accelerator, e.g. `CommandOrControl+Shift+Space` or `F9`. */
  accelerator: string
  /** Default `auto`: tap toggles, hold is push-to-talk. */
  mode?: HotkeyMode
}

export interface DictationOptions {
  /** Directory models are downloaded to and loaded from (e.g. `<dataDir>/models`). */
  modelsDir: string
  /** Model id from `ASR_MODELS`, or a descriptor. Default: Parakeet TDT 0.6B v3. */
  model?: string | AsrModelDescriptor
  /** Global hotkey; omit (or `false`) to drive dictation only through the handle. */
  hotkey?: string | HotkeyOptions | false
  /** One finished utterance, single line, never with a trailing newline. */
  onText: (text: string) => void
  onState: (state: DictationState, info?: DictationStateInfo) => void
  /** Approximate live text while recording (re-decodes the audio so far). */
  onPartial?: (text: string) => void
  /** Download the model on `start()` when it is missing. Default `false`. */
  autoDownload?: boolean
  mic?: MicOptions
  /** Stop automatically after this many seconds. Default 300. */
  maxRecordingSeconds?: number
  /** How often partial results are refreshed, ms. Default 1500. */
  partialIntervalMs?: number
  /** ONNX Runtime threads per decode. */
  threads?: number
  /** Advanced/testing: a custom audio input instead of the microphone. */
  audioSource?: AudioSource
  /** Advanced/testing: a custom key hook instead of uiohook-napi. */
  keyHook?: KeyHook
  /** Advanced/testing: a custom recognizer instead of sherpa-onnx. */
  createEngine?: (options: LoadSherpaEngineOptions) => Promise<AsrEngine>
  /** Advanced/testing: forwarded to the model download. */
  fetch?: DownloadModelOptions['fetch']
}

export interface Dictation {
  readonly state: DictationState
  readonly model: AsrModelDescriptor
  /** Whether the global hotkey is installed and listening. */
  readonly hotkeyActive: boolean
  isModelInstalled(): boolean
  /** Downloads the model if missing (progress through `onState('downloading')`). */
  ensureModel(): Promise<void>
  /** Loads the model into memory ahead of the first dictation. */
  preload(): Promise<void>
  /** Starts recording. Never rejects: problems are reported through `onState('error')`. */
  start(): Promise<void>
  /** Stops recording and resolves once the utterance was transcribed. Never rejects. */
  stop(): Promise<void>
  toggle(): Promise<void>
  /** Stops recording and discards the audio. */
  cancel(): Promise<void>
  /**
   * Removes the hotkey, stops the microphone, cancels downloads and waits (at
   * most `timeoutMs`, default 20 s) for in-flight native work before resolving.
   * Call it, and await it, before the process exits.
   */
  dispose(timeoutMs?: number): Promise<{ idle: boolean; waited: number; ms: number }>
}

/** Text that is safe to paste into a terminal: one line, no control characters. */
export function normalizeTranscript(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** Shorter recordings than this are treated as accidental taps. */
const MIN_UTTERANCE_SECONDS = 0.2
/** Partial results are only computed for this much audio (a decode per tick). */
const MAX_PARTIAL_SECONDS = 30

function concat(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function createDictation(options: DictationOptions): Dictation {
  const model =
    typeof options.model === 'object'
      ? options.model
      : getAsrModel(options.model ?? DEFAULT_ASR_MODEL_ID)
  if (!model) {
    throw new DictationError('unknown-model', `unknown dictation model "${String(options.model)}"`)
  }
  const work = new NativeWork()
  const maxSeconds = options.maxRecordingSeconds ?? 300
  const partialInterval = options.partialIntervalMs ?? 1500

  let state: DictationState = 'idle'
  let disposed = false
  let enginePromise: Promise<AsrEngine> | undefined
  let engineReady: AsrEngine | undefined
  let download: { controller: AbortController; promise: Promise<void> } | undefined

  let recording = false
  let starting: Promise<void> | undefined
  let session = 0
  let source: AudioSource | undefined
  let capture: CaptureInfo | undefined
  let chunks: Float32Array[] = []
  let chunkSamples = 0
  let partialTimer: ReturnType<typeof setInterval> | undefined
  let partialBusy = false

  let pendingTranscriptions = 0
  let queue: Promise<void> = Promise.resolve()

  let hotkey: HotkeyListener | undefined

  const call = <A extends unknown[]>(fn: ((...args: A) => void) | undefined, ...args: A): void => {
    try {
      fn?.(...args)
    } catch {
      // A throwing app callback must not break the pipeline.
    }
  }

  const setState = (next: DictationState, info?: DictationStateInfo): void => {
    if (next === state && !info && next !== 'error') return
    state = next
    call(options.onState, next, info)
  }

  const settle = (): void => {
    if (disposed) return setState('disposed')
    if (recording) return setState('recording', capture ? { capture } : undefined)
    if (download) return setState('downloading')
    if (pendingTranscriptions > 0) return setState('transcribing')
    setState('idle')
  }

  const fail = (code: DictationErrorCode, message: string, cause?: unknown): void => {
    if (disposed) return
    const error = new DictationError(code, message, cause === undefined ? undefined : { cause })
    setState('error', { error })
    settle()
  }

  const loadFailure = (error: unknown): string =>
    `could not load "${model.name}": ${asError(error).message}`

  const installed = (): boolean => isModelInstalled(options.modelsDir, model)

  const engine = (): Promise<AsrEngine> => {
    if (enginePromise) return enginePromise
    if (disposed) return Promise.reject(new Error('dictation was disposed'))
    if (!installed()) {
      return Promise.reject(
        new DictationError('model-missing', `dictation model "${model.name}" is not downloaded`)
      )
    }
    const create = options.createEngine ?? loadSherpaEngine
    const promise = create({
      model,
      dir: modelDir(options.modelsDir, model),
      work,
      threads: options.threads
    }).then(
      (created) => {
        if (enginePromise === promise) engineReady = created
        return created
      },
      (error: unknown) => {
        if (enginePromise === promise) enginePromise = undefined
        throw error
      }
    )
    enginePromise = promise
    return promise
  }

  const stopPartials = (): void => {
    if (partialTimer) clearInterval(partialTimer)
    partialTimer = undefined
  }

  const startPartials = (mySession: number): void => {
    if (!options.onPartial) return
    partialTimer = setInterval(() => {
      const rate = capture?.sampleRate
      if (partialBusy || !recording || session !== mySession || !engineReady || !rate) return
      const seconds = chunkSamples / rate
      if (seconds < 0.5 || seconds > MAX_PARTIAL_SECONDS) return
      partialBusy = true
      const samples = resample(concat(chunks, chunkSamples), rate, MODEL_SAMPLE_RATE)
      engineReady
        .transcribe(samples, { quick: true })
        .then((text) => {
          if (recording && session === mySession) {
            const clean = normalizeTranscript(text)
            if (clean) call(options.onPartial, clean)
          }
        })
        .catch(() => {
          // Partial results are best effort; the final decode reports errors.
        })
        .finally(() => {
          partialBusy = false
        })
    }, partialInterval)
    partialTimer.unref?.()
  }

  /** Ends the current recording; returns its audio (at the capture rate). */
  const endRecording = async (): Promise<{ audio: Float32Array; rate: number } | undefined> => {
    if (starting) await starting.catch(() => undefined)
    if (!recording) return undefined
    recording = false
    hotkey?.syncRecording(false)
    stopPartials()
    // Take the audio before awaiting the recorder: a new start() may reset
    // the buffers while this one is still shutting down.
    const result = { audio: concat(chunks, chunkSamples), rate: capture?.sampleRate ?? 0 }
    chunks = []
    chunkSamples = 0
    const current = source
    source = undefined
    if (current) {
      try {
        await current.stop()
      } catch {
        // The recorder is gone either way; keep what was captured.
      }
    }
    return result
  }

  const ensureModel = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (installed()) return Promise.resolve()
    if (download) return download.promise
    const controller = new AbortController()
    const promise = downloadModel(options.modelsDir, model, {
      signal: controller.signal,
      fetch: options.fetch,
      onProgress: (progress) => {
        if (!disposed && !recording) setState('downloading', { download: progress })
      }
    })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          download = undefined
          fail('download-failed', `model download failed: ${asError(error).message}`, error)
        }
      })
      .finally(() => {
        if (download?.promise === promise) download = undefined
        settle()
      })
    download = { controller, promise }
    setState('downloading')
    return promise
  }

  const start = async (): Promise<void> => {
    if (disposed || recording || starting) return
    if (!installed()) {
      hotkey?.syncRecording(false)
      if (options.autoDownload) {
        void ensureModel()
        return
      }
      fail('model-missing', `dictation model "${model.name}" is not downloaded`)
      return
    }
    // Load the model while the user speaks; a load failure ends the recording.
    engine().catch((error: unknown) => {
      if (disposed) return
      void endRecording().then((ended) => {
        // Already stopped: the pending transcription reports it instead.
        if (ended) fail('model-load-failed', loadFailure(error), error)
      })
    })

    let mic: AudioSource
    try {
      mic = options.audioSource ?? createMicSource(options.mic)
    } catch (error) {
      hotkey?.syncRecording(false)
      const code = error instanceof MicUnavailableError ? 'mic-unavailable' : 'mic-failed'
      fail(code, asError(error).message, error)
      return
    }

    const mySession = ++session
    recording = true
    hotkey?.syncRecording(true)
    chunks = []
    chunkSamples = 0
    capture = undefined
    source = mic
    const onSamples = (samples: Float32Array): void => {
      if (!recording || session !== mySession || samples.length === 0) return
      const limit = capture ? Math.floor(capture.sampleRate * maxSeconds) : Infinity
      const room = limit - chunkSamples
      if (room <= 0) return
      const kept = samples.length > room ? samples.subarray(0, room) : samples
      chunks.push(kept)
      chunkSamples += kept.length
      if (chunkSamples >= limit) void stop()
    }
    const onError = (error: Error): void => {
      if (session !== mySession) return
      fail('mic-failed', `microphone error: ${error.message}`, error)
      void stop()
    }
    starting = (async () => {
      try {
        capture = await mic.start(onSamples, onError)
        if (!recording || session !== mySession) return
        setState('recording', { capture })
        startPartials(mySession)
      } catch (error) {
        if (session === mySession) {
          recording = false
          source = undefined
          void mic.stop().catch(() => undefined)
          hotkey?.syncRecording(false)
          fail('mic-failed', `could not open the microphone: ${asError(error).message}`, error)
        }
      }
    })()
    try {
      await starting
    } finally {
      starting = undefined
    }
  }

  const stop = async (): Promise<void> => {
    const ended = await endRecording()
    if (!ended) return
    const { audio, rate } = ended
    if (!rate || audio.length < rate * MIN_UTTERANCE_SECONDS) {
      settle()
      return
    }
    pendingTranscriptions++
    setState('transcribing')
    const job = queue.then(async () => {
      try {
        const samples = resample(audio, rate, MODEL_SAMPLE_RATE)
        const recognizer = await engine().catch((error: unknown) => {
          if (error instanceof DictationError) throw error
          throw new DictationError('model-load-failed', loadFailure(error), { cause: error })
        })
        const text = normalizeTranscript(await recognizer.transcribe(samples))
        if (text && !disposed) call(options.onText, text)
      } catch (error) {
        const code =
          error instanceof DictationError ? error.code : ('transcribe-failed' as DictationErrorCode)
        fail(code, asError(error).message, error)
      } finally {
        pendingTranscriptions--
        settle()
      }
    })
    queue = job
    await job
  }

  const cancel = async (): Promise<void> => {
    if (await endRecording()) settle()
  }

  if (options.hotkey) {
    const spec: HotkeyOptions =
      typeof options.hotkey === 'string' ? { accelerator: options.hotkey } : options.hotkey
    try {
      const listener = new HotkeyListener({
        accelerator: spec.accelerator,
        mode: spec.mode,
        hook: options.keyHook ?? loadUiohook(),
        onStart: () => void start(),
        onStop: () => void stop()
      })
      listener.start()
      hotkey = listener
    } catch (error) {
      // Reported after the caller has the handle.
      queueMicrotask(() =>
        fail('hotkey-unavailable', `global hotkey unavailable: ${asError(error).message}`, error)
      )
    }
  }

  return {
    get state() {
      return state
    },
    model,
    get hotkeyActive() {
      return hotkey !== undefined
    },
    isModelInstalled: installed,
    ensureModel,
    async preload() {
      if (disposed || !installed()) return
      try {
        await engine()
      } catch (error) {
        fail('model-load-failed', loadFailure(error), error)
      }
    },
    start,
    stop,
    async toggle() {
      if (recording || starting) await stop()
      else await start()
    },
    cancel,
    async dispose(timeoutMs = 20_000) {
      if (!disposed) {
        disposed = true
        try {
          hotkey?.stop()
        } catch {
          // The hook may already be gone.
        }
        hotkey = undefined
        download?.controller.abort()
        await endRecording().catch(() => undefined)
      }
      const result = await work.close(timeoutMs)
      enginePromise = undefined
      engineReady = undefined
      setState('disposed')
      return result
    }
  }
}
