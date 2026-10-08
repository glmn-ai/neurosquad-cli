// Microphone capture through PvRecorder (@picovoice/pvrecorder-node,
// Apache-2.0): prebuilt binaries for Windows (x64/arm64), macOS (x64/arm64)
// and Linux x64, 16 kHz mono 16-bit, no access key needed.
//
// Its reads block until a frame is ready, so it runs in a worker thread: the
// main thread (hotkey events, the TUI) never waits on the microphone. The
// worker is told to stop through shared memory because its event loop is
// busy in that blocking read.
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { AudioSource, CaptureInfo } from './types.js'
import { int16ToFloat32 } from '../audio.js'

const FRAME_LENGTH = 512

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { PvRecorder } = require(workerData.modulePath)
const stopFlag = new Int32Array(workerData.stopBuffer)
let recorder
try {
  recorder = new PvRecorder(workerData.frameLength, workerData.deviceIndex)
  recorder.start()
  let device
  try { device = recorder.getSelectedDevice() } catch {}
  parentPort.postMessage({ type: 'started', sampleRate: recorder.sampleRate, device })
  while (Atomics.load(stopFlag, 0) === 0) {
    const frame = recorder.readSync()
    parentPort.postMessage({ type: 'frame', frame }, [frame.buffer])
  }
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) })
} finally {
  if (recorder) {
    try { recorder.stop() } catch {}
    try { recorder.release() } catch {}
  }
  parentPort.close()
}
`

/** Resolves the PvRecorder module path, or `undefined` when it is not installed. */
export function resolvePvRecorder(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('@picovoice/pvrecorder-node')
  } catch {
    return undefined
  }
}

/** Platforms PvRecorder ships a binary for (Raspberry Pi aside). */
export function pvRecorderSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  if (platform === 'win32' || platform === 'darwin') return arch === 'x64' || arch === 'arm64'
  if (platform === 'linux') return arch === 'x64'
  return false
}

/** Lists capture devices (index = position), or `[]` when PvRecorder is unavailable. */
export function listPvRecorderDevices(): string[] {
  const modulePath = resolvePvRecorder()
  if (!modulePath) return []
  try {
    const { PvRecorder } = createRequire(import.meta.url)(modulePath) as {
      PvRecorder: { getAvailableDevices(): string[] }
    }
    return PvRecorder.getAvailableDevices()
  } catch {
    return []
  }
}

export interface PvRecorderSourceOptions {
  /** Device index from `listPvRecorderDevices()`; -1 (default) = system default. */
  deviceIndex?: number
  /** How long `stop()` waits for the worker before terminating it, ms. */
  stopTimeoutMs?: number
}

export function createPvRecorderSource(options: PvRecorderSourceOptions = {}): AudioSource {
  let worker: Worker | undefined
  let stopFlag: Int32Array | undefined
  let exited: Promise<void> | undefined

  return {
    start(onSamples, onError) {
      if (worker) return Promise.reject(new Error('already recording'))
      const modulePath = resolvePvRecorder()
      if (!modulePath) {
        return Promise.reject(new Error('@picovoice/pvrecorder-node is not installed'))
      }
      const stopBuffer = new SharedArrayBuffer(4)
      stopFlag = new Int32Array(stopBuffer)
      const current = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          modulePath,
          stopBuffer,
          frameLength: FRAME_LENGTH,
          deviceIndex: options.deviceIndex ?? -1
        }
      })
      worker = current
      exited = new Promise((resolve) => current.once('exit', () => resolve()))
      return new Promise<CaptureInfo>((resolve, reject) => {
        let started = false
        current.on('message', (message: { type: string; [key: string]: unknown }) => {
          if (message.type === 'frame') {
            onSamples(int16ToFloat32(message.frame as Int16Array))
          } else if (message.type === 'started') {
            started = true
            resolve({
              sampleRate: message.sampleRate as number,
              backend: 'pvrecorder',
              device: (message.device as string | undefined) || undefined
            })
          } else if (message.type === 'error') {
            const error = new Error(`microphone: ${String(message.message)}`)
            if (started) onError(error)
            else reject(error)
          }
        })
        current.on('error', (error) => {
          if (started) onError(error)
          else reject(error)
        })
        current.once('exit', () => {
          if (worker === current) worker = undefined
          if (!started) reject(new Error('microphone: recorder exited before starting'))
        })
      })
    },

    async stop() {
      const current = worker
      if (!current) return
      if (stopFlag) Atomics.store(stopFlag, 0, 1)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        exited!.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), options.stopTimeoutMs ?? 2000)
        })
      ])
      clearTimeout(timer)
      if (timedOut) await current.terminate()
      worker = undefined
    }
  }
}
