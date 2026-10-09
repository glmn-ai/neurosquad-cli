// Voice dictation for nsq (@neurosquad/dictation, an optional dependency):
// speech is recognised on this machine and the text is pasted into the
// focused agent's input — never submitted. Used by the dashboard (key `v`,
// or the global hotkey) and by `nsq dictation …`.
import { readFileSync } from 'node:fs'
import { readConfig } from './config.js'
import { paths } from './paths.js'
import type { ParsedArgs } from './args.js'
import { flagString } from './args.js'

type DictationModule = typeof import('@neurosquad/dictation')

let loaded: DictationModule | null | undefined

/** The dictation package, or null when it (or its native parts) is not installed. */
export async function loadDictation(): Promise<DictationModule | null> {
  if (loaded !== undefined) return loaded
  try {
    loaded = (await import('@neurosquad/dictation')) as DictationModule
  } catch {
    loaded = null
  }
  return loaded
}

export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

export function modelsDir(): string {
  return paths.models()
}

export interface DictationBinding {
  state: string
  detail?: string
  progress?: number
  toggle(): void
  ensureModel(): Promise<void>
  installed(): boolean
  modelName: string
  modelBytes: number
  dispose(): Promise<void>
}

/**
 * Starts dictation for the dashboard. `target()` names the agent the text
 * goes to (the open one, else the selected one); `paste` delivers it.
 */
export async function bindDictation(options: {
  target: () => string | null
  paste: (agentId: string, text: string) => void
  changed: () => void
  /** A one-line notice for the status bar (e.g. the global hotkey cannot run here). */
  notice?: (text: string) => void
}): Promise<DictationBinding | null> {
  const config = readConfig().dictation ?? {}
  if (config.enabled === false) return null
  const mod = await loadDictation()
  if (!mod) return null
  const model =
    mod.getAsrModel(config.model ?? mod.DEFAULT_ASR_MODEL_ID) ??
    mod.getAsrModel(mod.DEFAULT_ASR_MODEL_ID)
  if (!model) return null
  const binding: DictationBinding = {
    state: 'idle',
    modelName: model.name,
    modelBytes: mod.asrModelTotalBytes(model),
    toggle: () => void dictation.toggle(),
    ensureModel: () => dictation.ensureModel(),
    installed: () => dictation.isModelInstalled(),
    dispose: async () => {
      await dictation.dispose()
    }
  }
  const hotkey =
    config.hotkey === undefined || config.hotkey
      ? {
          accelerator: config.hotkey ?? DEFAULT_HOTKEY,
          mode:
            config.mode === 'hold'
              ? ('push-to-talk' as const)
              : config.mode === 'toggle'
                ? ('toggle' as const)
                : ('auto' as const)
        }
      : false
  const dictation = mod.createDictation({
    modelsDir: modelsDir(),
    model,
    hotkey,
    onText: (text) => {
      const id = options.target()
      if (id && text) options.paste(id, text)
    },
    onState: (state, info) => {
      if (info?.error?.code === 'hotkey-unavailable') {
        // Optional: no global hotkey here (no X display over SSH…); the dashboard's key still works.
        binding.state = 'idle'
        binding.detail = undefined
        options.notice?.(`${info.error.message} — press v in the dashboard to dictate`)
        options.changed()
        return
      }
      binding.state = state
      binding.detail = info?.error?.message
      const download = info?.download
      binding.progress = download ? download.fraction : undefined
      options.changed()
    }
  })
  return binding
}

/** `nsq dictation setup | status | test <file.wav>` */
export async function cmdDictation(args: ParsedArgs): Promise<void> {
  const verb = args.positional[0] ?? 'status'
  const mod = await loadDictation()
  if (!mod) {
    throw new Error('dictation is not installed (npm i -g @neurosquad/dictation next to nsq)')
  }
  const config = readConfig().dictation ?? {}
  const model = mod.getAsrModel(
    flagString(args, 'model') ?? config.model ?? mod.DEFAULT_ASR_MODEL_ID
  )
  if (!model)
    throw new Error(`unknown model; one of: ${mod.ASR_MODELS.map((m) => m.id).join(', ')}`)
  const out = (line: string): void => void process.stdout.write(`${line}\n`)
  switch (verb) {
    case 'status': {
      out(
        `model: ${model.name} (${model.id}), ${(mod.asrModelTotalBytes(model) / 1e6).toFixed(0)} MB — ${mod.isModelInstalled(modelsDir(), model) ? 'installed' : 'not downloaded (nsq dictation setup)'}`
      )
      out(`folder: ${mod.modelDir(modelsDir(), model)}`)
      out(
        `hotkey: ${config.hotkey ?? DEFAULT_HOTKEY} (${config.mode ?? 'auto'}); in the dashboard also the key v`
      )
      if (model.attribution) out(`model license: ${model.license} — ${model.attribution}`)
      return
    }
    case 'setup': {
      let last = -1
      await mod.downloadModel(modelsDir(), model, {
        onProgress: (progress) => {
          const pct = Math.floor(progress.fraction * 100)
          if (pct !== last) {
            last = pct
            process.stdout.write(`\rdownloading ${model.name}: ${pct}%   `)
          }
        }
      })
      out(`\r${model.name} is ready (sha256 verified).            `)
      return
    }
    case 'test': {
      const file = args.positional[1]
      if (!file) throw new Error('nsq dictation test <file.wav>')
      const wav = mod.decodeWav(readFileSync(file))
      let text = ''
      const dictation = mod.createDictation({
        modelsDir: modelsDir(),
        model,
        hotkey: false,
        audioSource: mod.createBufferSource(wav.samples, wav.sampleRate),
        onText: (t) => {
          text += t
        },
        onState: (state, info) => {
          if (state === 'error')
            process.stderr.write(`dictation: ${info?.error?.message ?? 'error'}\n`)
        }
      })
      try {
        await dictation.start()
        await new Promise((resolve) =>
          setTimeout(resolve, Math.ceil((wav.samples.length / wav.sampleRate) * 1000) + 300)
        )
        await dictation.stop()
        out(text || '(nothing recognised)')
      } finally {
        await dictation.dispose()
      }
      return
    }
    default:
      throw new Error('nsq dictation setup | status | test <file.wav> [--model id]')
  }
}
