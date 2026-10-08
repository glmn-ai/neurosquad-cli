import {
  createCommandSource,
  detectRecorderCommand,
  findExecutable,
  type RecorderCommand
} from './command.js'
import { createPvRecorderSource, pvRecorderSupported, resolvePvRecorder } from './pvrecorder.js'
import type { AudioSource } from './types.js'

export interface MicOptions {
  /**
   * `auto` (default): PvRecorder when it has a binary for this platform,
   * otherwise the first recorder tool found on PATH.
   */
  backend?: 'auto' | 'pvrecorder' | 'command'
  /** PvRecorder device index (-1 = default). */
  deviceIndex?: number
  /** Device name for recorder tools (FFmpeg on Windows requires one). */
  device?: string
  /** An explicit recorder command (s16le mono on stdout) instead of detection. */
  command?: RecorderCommand
}

export class MicUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MicUnavailableError'
  }
}

/** Picks a microphone backend for this machine; throws `MicUnavailableError` if none fits. */
export function createMicSource(options: MicOptions = {}): AudioSource {
  const backend = options.backend ?? 'auto'
  if (backend === 'pvrecorder' || (backend === 'auto' && !options.command)) {
    const usable = pvRecorderSupported() && resolvePvRecorder() !== undefined
    if (usable) return createPvRecorderSource({ deviceIndex: options.deviceIndex })
    if (backend === 'pvrecorder') {
      throw new MicUnavailableError(
        `PvRecorder is not available on ${process.platform}-${process.arch}`
      )
    }
  }
  if (options.command) {
    const resolved = findExecutable(options.command.command)
    if (!resolved) {
      throw new MicUnavailableError(`recorder "${options.command.command}" was not found`)
    }
    return createCommandSource({ ...options.command, command: resolved })
  }
  const detected = detectRecorderCommand(process.platform, options.device)
  if (detected) return createCommandSource(detected)
  throw new MicUnavailableError(
    'no microphone backend: install SoX (sox), FFmpeg, or on Linux alsa-utils (arecord) / pulseaudio-utils (parecord)'
  )
}

export type { AudioSource, CaptureInfo } from './types.js'
export {
  createCommandSource,
  detectRecorderCommand,
  findExecutable,
  recorderCandidates,
  type RecorderCommand
} from './command.js'
export { createBufferSource, type BufferSourceOptions } from './buffer.js'
export { createPvRecorderSource, listPvRecorderDevices, pvRecorderSupported } from './pvrecorder.js'
