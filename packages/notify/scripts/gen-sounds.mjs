// Regenerates assets/sounds/*.wav: short synthesized chimes, written from
// scratch by this script (no samples), dedicated to the public domain (CC0 1.0,
// see assets/sounds/LICENSE.md). 22.05 kHz, 16-bit mono PCM WAV — the one
// format every player we use understands (SoundPlayer, afplay, paplay, aplay).
//
//   node scripts/gen-sounds.mjs
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RATE = 22050

/** A bell-ish note: fundamental + a quiet octave, fast attack, exponential decay. */
function note(freq, start, length, gain) {
  return { freq, start, length, gain }
}

function render(notes, total) {
  const samples = new Float64Array(Math.round(total * RATE))
  for (const n of notes) {
    const from = Math.round(n.start * RATE)
    const count = Math.round(n.length * RATE)
    for (let i = 0; i < count && from + i < samples.length; i++) {
      const t = i / RATE
      const attack = Math.min(1, t / 0.006)
      const decay = Math.exp((-5 * t) / n.length)
      const tone =
        Math.sin(2 * Math.PI * n.freq * t) + 0.25 * Math.sin(2 * Math.PI * n.freq * 2 * t)
      samples[from + i] += n.gain * attack * decay * tone
    }
  }
  // Short fade-out so the last sample is silence (no click).
  const fade = Math.round(0.02 * RATE)
  for (let i = 0; i < fade; i++) samples[samples.length - 1 - i] *= i / fade
  return samples
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const sounds = {
  // Rising two-note chime: "your turn".
  'needs-input': render([note(659.25, 0, 0.22, 0.45), note(880, 0.14, 0.34, 0.45)], 0.5),
  // One soft note: "done, read it whenever".
  finished: render([note(783.99, 0, 0.4, 0.4)], 0.42),
  // Falling two-note: "something went wrong".
  error: render([note(440, 0, 0.2, 0.45), note(329.63, 0.15, 0.32, 0.45)], 0.5)
}

for (const [name, samples] of Object.entries(sounds)) {
  const file = fileURLToPath(new URL(`../assets/sounds/${name}.wav`, import.meta.url))
  writeFileSync(file, wav(samples))
  console.log(`${name}.wav  ${samples.length} samples`)
}
