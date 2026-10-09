// Which model providers the new-agent form offers for a harness: the
// harness's own login, OpenRouter, and each of the user's own servers
// (../providers.ts) whose API the harness speaks. A server that lacks it is
// not offered — the form says why.
import {
  CUSTOM_PROVIDER_PRESETS,
  customProviderAddress,
  customProviderHarnessProblem,
  type CustomProvider,
  type HarnessId
} from '@neurosquad/core'
import { listProviders } from '../providers.js'

export interface ProviderChoice {
  /** '' = the harness's own login, 'openrouter', or a custom provider's id. */
  id: string
  label: string
  hint: string
}

export const OWN_LOGIN: ProviderChoice = {
  id: '',
  label: 'own login',
  hint: 'the harness’s own account and models'
}

export function providerChoices(
  harness: HarnessId,
  providers: readonly CustomProvider[] = safeList()
): { choices: ProviderChoice[]; unfit: { id: string; reason: string }[] } {
  if (harness === 'command') return { choices: [OWN_LOGIN], unfit: [] }
  const choices: ProviderChoice[] = [
    OWN_LOGIN,
    { id: 'openrouter', label: 'OpenRouter', hint: 'needs a key: nsq openrouter set-key' }
  ]
  const unfit: { id: string; reason: string }[] = []
  for (const provider of providers) {
    const problem = customProviderHarnessProblem(harness, provider)
    if (problem) unfit.push({ id: provider.id, reason: problem })
    else
      choices.push({
        id: provider.id,
        label: provider.id,
        hint: `${customProviderAddress(provider)} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'} · F2 lists them`
      })
  }
  return { choices, unfit }
}

/** The stored providers, or none when the file cannot be read (the form still opens). */
function safeList(): CustomProvider[] {
  try {
    return listProviders()
  } catch {
    return []
  }
}

/** The next/previous preset address for the add form (F2 cycles through them). */
export function nextPreset(current: string, step = 1): { name: string; url: string } {
  const presets = CUSTOM_PROVIDER_PRESETS
  const at = presets.findIndex((preset) => preset.url === current.trim())
  const next = presets[(at + step + presets.length) % presets.length]!
  return { name: next.id, url: next.url }
}

/** One line of the presets for the add form. */
export function presetsLine(): string {
  return CUSTOM_PROVIDER_PRESETS.map(
    (preset) => `${preset.name} :${preset.url.replace(/^.*:/, '')}`
  ).join(' · ')
}
