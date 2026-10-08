// Microphone capture by spawning a recorder that is already on the system
// (SoX, ALSA arecord, PulseAudio/PipeWire, FFmpeg) and reading raw 16-bit
// mono PCM from its stdout. The fallback when PvRecorder has no binary for
// the platform, or when the user prefers a specific tool.
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_SAMPLE_RATE, pcm16ToFloat32 } from '../audio.js'
import type { AudioSource, CaptureInfo } from './types.js'

export interface RecorderCommand {
  /** Backend name shown to the user, e.g. "sox". */
  name: string
  /** Executable name (looked up on PATH) or absolute path. */
  command: string
  args: string[]
  /** Rate of the PCM the command writes (s16le, mono). */
  sampleRate: number
}

/**
 * Recorder commands to try, in order, for a platform. Each one asks the tool
 * itself to deliver 16 kHz mono s16le on stdout. `device` overrides the
 * tool's default input (FFmpeg on Windows needs one: dshow has no default).
 */
export function recorderCandidates(
  platform: NodeJS.Platform = process.platform,
  device?: string
): RecorderCommand[] {
  const rate = String(MODEL_SAMPLE_RATE)
  const soxOut = ['-q', '-t', 'raw', '-r', rate, '-e', 'signed-integer', '-b', '16', '-c', '1', '-']
  const ffmpegOut = ['-ac', '1', '-ar', rate, '-f', 's16le', '-']
  const ffmpeg = (input: string[]): RecorderCommand => ({
    name: 'ffmpeg',
    command: 'ffmpeg',
    args: ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, ...ffmpegOut],
    sampleRate: MODEL_SAMPLE_RATE
  })
  const candidates: RecorderCommand[] = []
  if (platform === 'win32') {
    candidates.push({
      name: 'sox',
      command: 'sox',
      args: ['-q', '-t', 'waveaudio', device ?? 'default', ...soxOut.slice(1)],
      sampleRate: MODEL_SAMPLE_RATE
    })
    if (device) candidates.push(ffmpeg(['-f', 'dshow', '-i', `audio=${device}`]))
    return candidates
  }
  if (platform === 'linux') {
    candidates.push(
      {
        name: 'arecord',
        command: 'arecord',
        args: [
          '-q',
          ...(device ? ['-D', device] : []),
          '-t',
          'raw',
          '-f',
          'S16_LE',
          '-c',
          '1',
          '-r',
          rate
        ],
        sampleRate: MODEL_SAMPLE_RATE
      },
      {
        name: 'parecord',
        command: 'parecord',
        args: [
          '--raw',
          '--format=s16le',
          '--channels=1',
          `--rate=${rate}`,
          ...(device ? [`--device=${device}`] : [])
        ],
        sampleRate: MODEL_SAMPLE_RATE
      },
      {
        name: 'pw-record',
        command: 'pw-record',
        args: [
          '--format',
          's16',
          '--rate',
          rate,
          '--channels',
          '1',
          ...(device ? ['--target', device] : []),
          '-'
        ],
        sampleRate: MODEL_SAMPLE_RATE
      }
    )
  }
  // SoX's default device (-d) works on macOS (CoreAudio) and Linux.
  candidates.push({
    name: 'sox',
    command: 'sox',
    args: device
      ? ['-q', '-t', platform === 'darwin' ? 'coreaudio' : 'alsa', device, ...soxOut.slice(1)]
      : ['-q', '-d', ...soxOut.slice(1)],
    sampleRate: MODEL_SAMPLE_RATE
  })
  if (platform === 'darwin') {
    candidates.push(ffmpeg(['-f', 'avfoundation', '-i', `:${device ?? 'default'}`]))
  } else if (platform === 'linux') {
    candidates.push(ffmpeg(['-f', 'pulse', '-i', device ?? 'default']))
  }
  return candidates
}

/** Finds an executable on PATH (with PATHEXT on Windows). */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const isFile = (path: string): boolean => {
    try {
      if (!statSync(path).isFile()) return false
      if (platform !== 'win32') accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (name.includes('/') || name.includes('\\')) return isFile(name) ? name : undefined
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)
      : ['']
  const separator = platform === 'win32' ? ';' : ':'
  for (const dir of pathValue.split(separator)) {
    if (!dir) continue
    for (const ext of extensions) {
      // Only real executables: .bat/.cmd shims would need a shell to run.
      if (platform === 'win32' && ext && !/^\.(exe|com)$/i.test(ext)) continue
      const candidate = join(dir, name + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

/** The first recorder command whose executable is on PATH. */
export function detectRecorderCommand(
  platform: NodeJS.Platform = process.platform,
  device?: string,
  env: NodeJS.ProcessEnv = process.env
): RecorderCommand | undefined {
  for (const candidate of recorderCandidates(platform, device)) {
    const resolved = findExecutable(candidate.command, env, platform)
    if (resolved) return { ...candidate, command: resolved }
  }
  return undefined
}

export interface CommandSourceOptions {
  /** How long `stop()` waits after SIGTERM before SIGKILL, ms. */
  stopTimeoutMs?: number
}

export function createCommandSource(
  recorder: RecorderCommand,
  options: CommandSourceOptions = {}
): AudioSource {
  let child: ChildProcess | undefined
  let closed: Promise<void> | undefined
  let stopping = false

  return {
    start(onSamples, onError) {
      if (child) return Promise.reject(new Error('already recording'))
      const current = spawn(recorder.command, recorder.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      child = current
      closed = new Promise((resolve) => current.once('close', () => resolve()))
      stopping = false
      let stderrTail = ''
      // A sample can straddle two stdout chunks; keep the odd byte.
      let carry: Uint8Array = new Uint8Array(0)
      current.stdout!.on('data', (chunk: Buffer) => {
        let bytes: Uint8Array = chunk
        if (carry.length > 0) {
          const joined = new Uint8Array(carry.length + chunk.length)
          joined.set(carry)
          joined.set(chunk, carry.length)
          bytes = joined
        }
        const even = bytes.length - (bytes.length % 2)
        carry = bytes.slice(even)
        if (even > 0) onSamples(pcm16ToFloat32(bytes.subarray(0, even)))
      })
      current.stderr!.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500)
      })
      return new Promise<CaptureInfo>((resolve, reject) => {
        let started = false
        current.once('spawn', () => {
          started = true
          resolve({ sampleRate: recorder.sampleRate, backend: recorder.name })
        })
        current.once('error', (error) => {
          if (child === current) child = undefined
          if (started) onError(error)
          else reject(error)
        })
        current.once('exit', (code, signal) => {
          if (child === current) child = undefined
          if (stopping || !started) return
          const detail = stderrTail.trim()
          onError(
            new Error(
              `${recorder.name} stopped unexpectedly (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : ''}`
            )
          )
        })
      })
    },

    async stop() {
      const current = child
      if (!current) return
      stopping = true
      try {
        current.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        closed!.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), options.stopTimeoutMs ?? 2000)
        })
      ])
      clearTimeout(timer)
      if (timedOut) {
        try {
          current.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        await closed
      }
      child = undefined
    }
  }
}
