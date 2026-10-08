import type { AudioSource, CaptureInfo } from './types.js'

export interface BufferSourceOptions {
  /** Samples per delivered chunk. Default: 20 ms worth. */
  chunkSamples?: number
  /** Pace delivery at real time instead of as fast as possible. */
  realtime?: boolean
  backend?: string
}

/**
 * An `AudioSource` that plays back samples already in memory (a WAV file, a
 * synthesized signal). Once the samples run out it stays "recording" silently
 * until `stop()`, like a microphone in a quiet room.
 */
export function createBufferSource(
  samples: Float32Array,
  sampleRate: number,
  options: BufferSourceOptions = {}
): AudioSource {
  const chunk = options.chunkSamples ?? Math.max(1, Math.round(sampleRate / 50))
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false

  return {
    async start(onSamples): Promise<CaptureInfo> {
      if (running) throw new Error('already recording')
      running = true
      let at = 0
      const pump = (): void => {
        timer = undefined
        if (!running || at >= samples.length) return
        const end = Math.min(samples.length, at + chunk)
        onSamples(samples.slice(at, end))
        at = end
        const delay = options.realtime ? (chunk / sampleRate) * 1000 : 0
        timer = setTimeout(pump, delay)
      }
      timer = setTimeout(pump, 0)
      return { sampleRate, backend: options.backend ?? 'buffer' }
    },
    async stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = undefined
    }
  }
}
