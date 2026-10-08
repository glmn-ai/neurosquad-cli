// Sample-format helpers: PCM16 <-> float, band-limited resampling, and a
// minimal WAV (RIFF PCM) reader/writer.

/** The rate every model in the catalogue expects. */
export const MODEL_SAMPLE_RATE = 16000

/** Signed 16-bit little-endian PCM bytes to floats in [-1, 1). */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

export function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768
  return out
}

/** Half-width of the sinc kernel, in input samples at the passband rate. */
const KERNEL_HALF_WIDTH = 16

/**
 * Resamples mono audio with a Hann-windowed sinc kernel. When downsampling,
 * the kernel's cutoff moves to the new Nyquist frequency, so content above it
 * is filtered out instead of aliasing into the speech band.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive')
  if (fromRate === toRate || samples.length === 0) return samples
  const ratio = fromRate / toRate
  const cutoff = Math.min(1, toRate / fromRate)
  const halfWidth = Math.ceil(KERNEL_HALF_WIDTH / cutoff)
  const outLength = Math.floor((samples.length * toRate) / fromRate)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const center = i * ratio
    const first = Math.max(0, Math.ceil(center - halfWidth))
    const last = Math.min(samples.length - 1, Math.floor(center + halfWidth))
    let sum = 0
    let weightSum = 0
    for (let k = first; k <= last; k++) {
      const distance = center - k
      const x = distance * cutoff
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / (halfWidth + 1))
      const weight = sinc * window
      sum += samples[k] * weight
      weightSum += weight
    }
    // Normalising by the kernel's own sum keeps DC gain at exactly 1, edges included.
    out[i] = weightSum !== 0 ? sum / weightSum : 0
  }
  return out
}

export interface WavAudio {
  sampleRate: number
  /** Mono samples in [-1, 1]; multi-channel files are averaged down. */
  samples: Float32Array
}

/** Parses a PCM WAV file (8/16/24/32-bit integer or 32-bit float). */
export function decodeWav(data: Uint8Array): WavAudio {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const tag = (at: number): string =>
    String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3])
  if (data.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let at = 12
  while (at + 8 <= data.length) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > data.length) throw new Error('WAV fmt chunk is truncated')
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      if (!channels || !sampleRate) throw new Error('WAV data chunk before fmt chunk')
      if (![8, 16, 24, 32].includes(bits)) throw new Error(`unsupported WAV bit depth ${bits}`)
      const bytesPerSample = bits / 8
      const end = Math.min(data.length, body + size)
      const frames = Math.floor((end - body) / (bytesPerSample * channels))
      const samples = new Float32Array(frames)
      const read = (offset: number): number => {
        if (format === 3 && bits === 32) return view.getFloat32(offset, true)
        if (format !== 1) throw new Error(`unsupported WAV format ${format}`)
        if (bits === 8) return (view.getUint8(offset) - 128) / 128
        if (bits === 16) return view.getInt16(offset, true) / 32768
        if (bits === 24) {
          const value =
            view.getUint8(offset) |
            (view.getUint8(offset + 1) << 8) |
            (view.getInt8(offset + 2) << 16)
          return value / 8388608
        }
        if (bits === 32) return view.getInt32(offset, true) / 2147483648
        throw new Error(`unsupported WAV bit depth ${bits}`)
      }
      for (let frame = 0; frame < frames; frame++) {
        let sum = 0
        for (let channel = 0; channel < channels; channel++) {
          sum += read(body + (frame * channels + channel) * bytesPerSample)
        }
        samples[frame] = sum / channels
      }
      return { sampleRate, samples }
    }
    at = body + size + (size % 2)
  }
  throw new Error('WAV file has no data chunk')
}

/** Encodes mono floats as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(out.buffer)
  const writeTag = (at: number, value: string): void => {
    for (let i = 0; i < 4; i++) out[at + i] = value.charCodeAt(i)
  }
  writeTag(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeTag(8, 'WAVE')
  writeTag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeTag(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }
  return out
}
