// Preparing one recorded utterance for transcription: drop the silence the
// model would otherwise process, and cut what is left into pieces that can be
// decoded in parallel. Pure array maths on 16 kHz mono samples.

export const SAMPLE_RATE = 16000
/** 25ms — one energy measurement per frame, matching the model's frame rate. */
const ENERGY_FRAME = 400
/** Below this, splitting costs more than it saves — decode in one go. */
const MIN_SPLIT_SECONDS = 10
/** Aim for roughly this much audio per parallel chunk. */
const TARGET_CHUNK_SECONDS = 8
/** A cut is only allowed inside a silent run at least this long. */
const MIN_SILENCE_FRAMES = 8 // 200ms
/** How far from the ideal cut position to look for that silence. */
const SILENCE_SEARCH_FRAMES = Math.floor((3 * SAMPLE_RATE) / ENERGY_FRAME)
/** Interior pauses longer than this get shortened (see compactSilence). */
const MAX_KEPT_SILENCE_FRAMES = 20 // 500ms
/** What a shortened pause is left at — still audibly a pause, just not a long one. */
const KEPT_SILENCE_FRAMES = 8 // 200ms

function frameEnergies(samples: Float32Array): Float32Array {
  const count = Math.floor(samples.length / ENERGY_FRAME)
  const energies = new Float32Array(count)
  for (let frame = 0; frame < count; frame++) {
    const base = frame * ENERGY_FRAME
    let sum = 0
    for (let i = 0; i < ENERGY_FRAME; i++) {
      const value = samples[base + i]
      sum += value * value
    }
    energies[frame] = Math.sqrt(sum / ENERGY_FRAME)
  }
  return energies
}

/**
 * What counts as "silence" in *this* recording, rather than a fixed number —
 * mic gain, room noise, and a headset vs. a laptop mic move the floor around
 * by orders of magnitude. Derived from the recording's own 10th-percentile
 * (noise floor) and 95th-percentile (speech) levels.
 */
function silenceThreshold(energies: Float32Array): number {
  const sorted = Float32Array.from(energies).sort()
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0
  const peak = sorted[Math.floor(sorted.length * 0.95)] || 0
  return Math.max(floor * 2.5, peak * 0.06, 1e-4)
}

/** Contiguous runs of frames below the silence threshold, as [start, end) frame indices. */
function silentRuns(energies: Float32Array, threshold: number): [number, number][] {
  const runs: [number, number][] = []
  let start = -1
  for (let frame = 0; frame < energies.length; frame++) {
    if (energies[frame] <= threshold) {
      if (start < 0) start = frame
    } else if (start >= 0) {
      runs.push([start, frame])
      start = -1
    }
  }
  if (start >= 0) runs.push([start, energies.length])
  return runs
}

/**
 * Shortens every pause longer than half a second down to 200ms, and trims the
 * lead-in/lead-out. The encoder's cost is proportional to how much audio it's
 * handed and silence contributes nothing to the transcript, so a recording
 * with the pauses a person actually leaves while thinking gets meaningfully
 * cheaper to transcribe. 200ms is left in place rather than zero so sentence
 * boundaries still *sound* like boundaries to the model.
 */
export function compactSilence(samples: Float32Array): Float32Array {
  const energies = frameEnergies(samples)
  if (energies.length === 0) return samples
  const runs = silentRuns(energies, silenceThreshold(energies))
  const longRuns = runs.filter(([start, end]) => end - start > MAX_KEPT_SILENCE_FRAMES)
  if (longRuns.length === 0) return samples

  const pieces: Float32Array[] = []
  let cursor = 0
  for (const [start, end] of longRuns) {
    const isEdge = start === 0 || end === energies.length
    // A pause in the middle keeps a short beat; dead air at either end of the
    // recording (the gap between pressing the hotkey and actually speaking)
    // has nothing to mark and goes entirely.
    const keep = isEdge ? 0 : KEPT_SILENCE_FRAMES
    const runStartSample = start * ENERGY_FRAME
    if (runStartSample > cursor) pieces.push(samples.subarray(cursor, runStartSample))
    if (keep > 0)
      pieces.push(samples.subarray(runStartSample, runStartSample + keep * ENERGY_FRAME))
    cursor = Math.min(end * ENERGY_FRAME, samples.length)
  }
  if (cursor < samples.length) pieces.push(samples.subarray(cursor))

  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  if (total === 0) return samples
  const out = new Float32Array(total)
  let at = 0
  for (const piece of pieces) {
    out.set(piece, at)
    at += piece.length
  }
  return out
}

/**
 * Splits an utterance into chunks that can be decoded in parallel, cutting
 * ONLY inside a real pause — never mid-word. For each ideal boundary it looks
 * within ±3s for the longest run of silent frames and, if that run is long
 * enough, splits there; a boundary with no usable pause nearby is skipped
 * (fewer, larger chunks) rather than forced.
 *
 * Both sides keep the *whole* silent run rather than meeting at its midpoint,
 * so every chunk still begins and ends in silence — the encoder gets the same
 * lead-in and lead-out it would have had in the unsplit audio. This keeps
 * the word error rate of the split transcript on par with a single decode.
 */
export function splitAtPauses(
  samples: Float32Array,
  maxParts: number,
  targetSeconds: number = TARGET_CHUNK_SECONDS
): Float32Array[] {
  const seconds = samples.length / SAMPLE_RATE
  if (seconds < Math.min(MIN_SPLIT_SECONDS, targetSeconds)) return [samples]
  const targetParts = Math.min(maxParts, Math.round(seconds / targetSeconds))
  if (targetParts < 2) return [samples]

  const energies = frameEnergies(samples)
  if (energies.length === 0) return [samples]
  const threshold = silenceThreshold(energies)

  // [start, end) sample offsets of each chosen silent run.
  const cuts: [number, number][] = []
  for (let part = 1; part < targetParts; part++) {
    const ideal = Math.floor((energies.length * part) / targetParts)
    const from = Math.max(1, ideal - SILENCE_SEARCH_FRAMES)
    const to = Math.min(energies.length - 1, ideal + SILENCE_SEARCH_FRAMES)
    let bestStart = -1
    let bestLength = 0
    let runStart = -1
    for (let frame = from; frame <= to; frame++) {
      if (energies[frame] > threshold) {
        runStart = -1
        continue
      }
      if (runStart < 0) runStart = frame
      const length = frame - runStart + 1
      const closer =
        Math.abs(runStart + length / 2 - ideal) < Math.abs(bestStart + bestLength / 2 - ideal)
      if (length > bestLength || (length === bestLength && closer)) {
        bestLength = length
        bestStart = runStart
      }
    }
    if (bestLength < MIN_SILENCE_FRAMES) continue
    const runStartSample = bestStart * ENERGY_FRAME
    const runEndSample = (bestStart + bestLength) * ENERGY_FRAME
    // Never produce a sliver: two boundaries landing in the same pause would
    // otherwise create a chunk that's nothing but silence.
    const previousEnd = cuts.length > 0 ? cuts[cuts.length - 1][1] : 0
    if (runStartSample - previousEnd > SAMPLE_RATE) cuts.push([runStartSample, runEndSample])
  }
  if (cuts.length === 0) return [samples]

  const chunks: Float32Array[] = []
  let previousStart = 0
  for (const [runStart, runEnd] of cuts) {
    chunks.push(samples.subarray(previousStart, runEnd))
    previousStart = runStart
  }
  chunks.push(samples.subarray(previousStart))
  return chunks
}

/**
 * A hard ceiling on chunk length, for models that have one. Whisper encodes a
 * fixed 30-second window and silently *truncates* anything longer rather than
 * failing, so a long utterance that `splitAtPauses` couldn't cut (no usable
 * pause anywhere near the ideal boundary) would otherwise lose its tail with
 * no error anywhere.
 *
 * Tries a pause-aware split of the oversized chunk first, at a tighter
 * target, and only falls back to slicing at a fixed offset — which can land
 * mid-word — when even that leaves something too long. Chunks already within
 * the limit are passed through untouched.
 */
export function limitChunkDuration(chunks: Float32Array[], maxSeconds: number): Float32Array[] {
  if (maxSeconds <= 0) return chunks
  const maxSamples = Math.floor(maxSeconds * SAMPLE_RATE)
  const out: Float32Array[] = []
  for (const chunk of chunks) {
    if (chunk.length <= maxSamples) {
      out.push(chunk)
      continue
    }
    const parts = Math.ceil(chunk.length / maxSamples)
    for (const piece of splitAtPauses(chunk, parts, chunk.length / parts / SAMPLE_RATE)) {
      if (piece.length <= maxSamples) {
        out.push(piece)
        continue
      }
      for (let at = 0; at < piece.length; at += maxSamples) {
        out.push(piece.subarray(at, Math.min(at + maxSamples, piece.length)))
      }
    }
  }
  return out
}
