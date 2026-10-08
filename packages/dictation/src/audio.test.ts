import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav, pcm16ToFloat32, resample } from './audio.js'
import { compactSilence, splitAtPauses } from './audioSegments.js'

function sine(freq: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++)
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, to - from))
}

/** Zero crossings per second -> frequency of a pure tone. */
function toneFrequency(samples: Float32Array, rate: number): number {
  let crossings = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 !== samples[i] < 0) crossings++
  }
  return crossings / 2 / (samples.length / rate)
}

describe('resample', () => {
  it('returns the input unchanged when the rates match', () => {
    const input = sine(440, 16000, 0.1)
    expect(resample(input, 16000, 16000)).toBe(input)
  })

  it('keeps a speech-band tone (pitch and level) when going 48 kHz -> 16 kHz', () => {
    const out = resample(sine(440, 48000, 1), 48000, 16000)
    expect(out.length).toBe(16000)
    const middle = out.subarray(1000, 15000)
    expect(toneFrequency(middle, 16000)).toBeCloseTo(440, -1)
    expect(rms(middle)).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })

  it('filters out content above the new Nyquist frequency instead of aliasing it', () => {
    const out = resample(sine(12000, 48000, 1), 48000, 16000)
    expect(rms(out, 1000, 15000)).toBeLessThan(0.02)
  })

  it('upsamples 8 kHz -> 16 kHz with unity DC gain', () => {
    const out = resample(new Float32Array(8000).fill(0.25), 8000, 16000)
    expect(out.length).toBe(16000)
    for (const value of out) expect(value).toBeCloseTo(0.25, 5)
  })

  it('handles 44.1 kHz (non-integer ratio)', () => {
    const out = resample(sine(300, 44100, 0.5), 44100, 16000)
    expect(out.length).toBe(8000)
    expect(toneFrequency(out.subarray(500, 7500), 16000)).toBeCloseTo(300, -1)
  })
})

describe('WAV', () => {
  it('round-trips 16-bit mono PCM', () => {
    const input = sine(1000, 22050, 0.05)
    const decoded = decodeWav(encodeWav(input, 22050))
    expect(decoded.sampleRate).toBe(22050)
    expect(decoded.samples.length).toBe(input.length)
    for (let i = 0; i < input.length; i++) expect(decoded.samples[i]).toBeCloseTo(input[i], 3)
  })

  it('averages stereo down to mono', () => {
    const wav = encodeWav(new Float32Array([0.5, -0.5, 0.25, 0.25]), 8000)
    // Re-label the same bytes as 2 channels: frames (0.5,-0.5) and (0.25,0.25).
    const view = new DataView(wav.buffer)
    view.setUint16(22, 2, true)
    view.setUint16(32, 4, true)
    const decoded = decodeWav(wav)
    expect(decoded.samples.length).toBe(2)
    expect(decoded.samples[0]).toBeCloseTo(0, 3)
    expect(decoded.samples[1]).toBeCloseTo(0.25, 3)
  })

  it('rejects malformed headers with a clear message', () => {
    const wav = encodeWav(new Float32Array(4), 8000)
    const zeroBits = Uint8Array.from(wav)
    new DataView(zeroBits.buffer).setUint16(34, 0, true)
    expect(() => decodeWav(zeroBits)).toThrow(/bit depth 0/)
    const shortFmt = Uint8Array.from(wav)
    new DataView(shortFmt.buffer).setUint32(16, 8, true)
    expect(() => decodeWav(shortFmt)).toThrow(/fmt chunk is truncated/)
  })

  it('rejects non-WAV data', () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/RIFF/)
  })

  it('converts raw s16le bytes', () => {
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00])
    const out = pcm16ToFloat32(bytes)
    expect(Array.from(out)).toEqual([-1, 32767 / 32768, 0])
  })
})

describe('audio segments', () => {
  const rate = 16000
  const speech = (seconds: number): Float32Array => sine(200, rate, seconds, 0.4)
  const silence = (seconds: number): Float32Array => new Float32Array(Math.round(rate * seconds))
  const join = (...parts: Float32Array[]): Float32Array => {
    const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.length
    }
    return out
  }

  it('drops lead-in/lead-out silence and shortens long pauses', () => {
    const input = join(silence(1), speech(1), silence(2), speech(1), silence(1))
    const out = compactSilence(input)
    // 2 s of speech + a ~200 ms kept pause, give or take a frame at each edge.
    expect(out.length / rate).toBeGreaterThan(2.1)
    expect(out.length / rate).toBeLessThan(2.4)
  })

  it('splits long utterances only inside pauses', () => {
    const input = join(speech(7), silence(0.5), speech(7), silence(0.5), speech(7))
    const chunks = splitAtPauses(input, 4, 8)
    expect(chunks.length).toBe(3)
    for (const chunk of chunks) expect(chunk.length / rate).toBeGreaterThan(6.5)
  })
})
