// Which model ids an agent may run with which provider. One place for the
// daemon (it refuses), the TUI form (it turns OpenRouter on) and the start of
// an agent saved by an older nsq (it migrates or warns).
import {
  claudeSessionModels,
  claudeSettingsModel,
  codexSessionModels,
  normalizeModelId,
  openRouterOnlyMessage,
  openRouterOnlyModel,
  readCodexUserConfig,
  type HarnessId
} from '@neurosquad/core'

/** True when `model` only exists on OpenRouter for this harness (see `openRouterOnlyModel`). */
export function modelNeedsOpenRouter(harness: HarnessId, model: string | undefined): boolean {
  if (harness !== 'codex-cli') return openRouterOnlyModel(harness, model)
  // Codex on the user's own non-OpenAI provider (Ollama, their own OpenRouter entry…) takes
  // `vendor/model` ids natively.
  const { modelProvider } = readCodexUserConfig(process.env['CODEX_HOME'] || undefined)
  return openRouterOnlyModel(
    harness,
    model,
    modelProvider ? { codexModelProvider: modelProvider } : {}
  )
}

/**
 * The model to resume a session with on the user's own login, when the CLI by itself would
 * resume on an OpenRouter slug the session ran on before: Claude Code restores a session's model
 * when it looks like a Claude one (`anthropic/claude-…` does), Codex always does. The user's own
 * setting wins, then (Codex) the session's last own model, then (Claude Code) its `default`.
 */
export function ownModelOnResume(
  harness: HarnessId,
  sessionId: string
): { model?: string; warning?: string } {
  const own = (model: string | undefined): string | undefined =>
    model && !modelNeedsOpenRouter(harness, model) ? model : undefined
  if (harness === 'claude-code') {
    const last = claudeSessionModels(sessionId).at(-1)
    if (!last || !modelNeedsOpenRouter(harness, last)) return {}
    return { model: own(claudeSettingsModel()) ?? 'default' }
  }
  if (harness === 'codex-cli') {
    const models = codexSessionModels(sessionId)
    const last = models.at(-1)
    if (!last || !modelNeedsOpenRouter(harness, last)) return {}
    const model =
      own(readCodexUserConfig(process.env['CODEX_HOME'] || undefined).model) ??
      [...models].reverse().find((model) => own(model) !== undefined)
    return model
      ? { model }
      : {
          warning: `Codex resumes this session on ${last}, an OpenRouter model: pick one of its own`
        }
  }
  return {}
}

/**
 * Throws when an agent would start with a model it cannot run: not a model id at all, or an
 * OpenRouter-only id without the OpenRouter provider. `clearingProvider`: the request turned
 * OpenRouter off and left the model as it was.
 */
export function checkModelChoice(
  harness: HarnessId,
  provider: 'openrouter' | 'custom' | undefined,
  model: string | undefined,
  clearingProvider = false
): void {
  // One of the user's own servers: its ids are its own (`qwen/qwen3-coder-30b` looks like a slug
  // but is LM Studio's) — checked against that server by the daemon, never taken for OpenRouter's.
  if (model === undefined || provider === 'custom') return
  if (!normalizeModelId(model)) throw new Error(`not a model id: ${JSON.stringify(model)}`)
  if (provider === 'openrouter') {
    // The other way round: a native id on OpenRouter. (OpenCode's recipe prefixes `openrouter/`
    // itself, and its catalogue may list a provider model without a vendor.)
    if ((harness === 'claude-code' || harness === 'codex-cli') && !model.includes('/'))
      throw new Error(
        `${model} is not an OpenRouter model id (vendor/model) — for the harness's own model add --provider none`
      )
    return
  }
  // Only on the CLI's own login: another provider has its own id format.
  if (provider !== undefined || !modelNeedsOpenRouter(harness, model)) return
  throw new Error(
    clearingProvider
      ? `${model} is an OpenRouter model id — to go back to the harness's own login, clear the model too (--model none)`
      : openRouterOnlyMessage(model)
  )
}

export type ModelSwitchApplied = 'now' | 'after-turn' | 'next-start'

/** What the dashboard and `nsq set` say after a model/provider change. */
export function modelSwitchText(
  model: string | undefined,
  provider: 'openrouter' | 'custom' | undefined,
  applied: ModelSwitchApplied | undefined,
  /** The user's own server, with `provider: 'custom'`. */
  customProviderId?: string
): string {
  const where =
    provider === 'openrouter'
      ? ' on OpenRouter'
      : provider === 'custom'
        ? ` on ${customProviderId ?? 'your own server'}`
        : ''
  const what = model
    ? `${model}${where}`
    : provider === 'openrouter'
      ? 'OpenRouter with its default model'
      : 'its own login and default model'
  switch (applied) {
    case 'now':
      return `switched to ${what} (session kept)`
    case 'after-turn':
      return `switches to ${what} when this turn ends (session kept)`
    default:
      return `${what}: applies on the next start`
  }
}
