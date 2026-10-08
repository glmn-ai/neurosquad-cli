export interface CaptureInfo {
  /** Rate of the samples passed to `onSamples`. */
  sampleRate: number
  /** Backend name, e.g. "pvrecorder" or "sox". */
  backend: string
  /** Human-readable input device, when the backend knows it. */
  device?: string
}

/**
 * A microphone (or any other audio input). One `start()`/`stop()` pair per
 * utterance; `stop()` resolves once no more samples will be delivered and
 * every native or child-process resource is released.
 */
export interface AudioSource {
  start(
    onSamples: (samples: Float32Array) => void,
    onError: (error: Error) => void
  ): Promise<CaptureInfo>
  stop(): Promise<void>
}
