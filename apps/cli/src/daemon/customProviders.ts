// The daemon's side of custom providers (../providers.ts): checking an
// agent's choice, the launch context (provider, key, gateway) at start, and
// the Responses gateway for Codex on a server with only chat completions.
//
// A start on a custom provider that cannot work — the provider was removed,
// its server lacks the endpoint the harness needs, the gateway is down — is
// refused, never run on the harness's own login: an agent set to a local
// server must not send its code to the cloud.
import {
  codexNeedsResponsesGateway,
  customProviderBaseUrl,
  customProviderHarnessProblem,
  customProviderLaunchProblem,
  customProviderTransportProblem,
  customProviderTransportWarning,
  safeCustomModelId,
  startResponsesGateway,
  type CustomProvider,
  type HarnessId,
  type LaunchContext,
  type ResponsesGateway
} from '@neurosquad/core'
import { getProvider, providerKey } from '../providers.js'
import type { AgentRecord } from './store.js'

/** What an agent on a custom provider runs with, after the checks. */
export interface CustomChoice {
  provider: CustomProvider
  /** The model: the one asked for, or the provider's only model. */
  model?: string
  warnings: string[]
}

/**
 * Checks a harness + provider + model choice (`nsq run`, `nsq set`, the
 * dashboard form). Throws with the reason; the model defaults to the
 * provider's only model.
 */
export function checkCustomChoice(
  harness: HarnessId,
  providerId: string | undefined,
  model: string | undefined
): CustomChoice {
  const provider = getProvider(providerId)
  if (!provider)
    throw new Error(`no provider "${providerId ?? ''}" (nsq provider list, nsq provider add)`)
  const problem = customProviderHarnessProblem(harness, provider)
  if (problem) throw new Error(problem)
  const transport = customProviderTransportProblem(provider)
  if (transport) throw new Error(transport)
  const warnings: string[] = []
  const warning = customProviderTransportWarning(provider)
  if (warning) warnings.push(warning)
  if (model !== undefined) {
    const id = safeCustomModelId(model)
    if (!id) throw new Error(`not a model id: ${JSON.stringify(model)}`)
    if (provider.models.length > 0 && !provider.models.some((entry) => entry.id === id)) {
      warnings.push(
        `${provider.name} did not list ${id} (nsq provider models ${provider.id}); trying it anyway`
      )
    }
    return { provider, model: id, warnings }
  }
  if (provider.models.length === 1) return { provider, model: provider.models[0]!.id, warnings }
  throw new Error(
    provider.models.length === 0
      ? `${provider.name} lists no models — give one with --model`
      : `which model on ${provider.name}? --model <id> (nsq provider models ${provider.id})`
  )
}

export class CustomProviderRuntime {
  private gateway: Promise<ResponsesGateway> | undefined

  constructor(
    private readonly lookup: (agentId: string) => AgentRecord | undefined,
    private readonly log: (line: string) => void
  ) {}

  /**
   * The launch context's `customProvider` for an agent on one. Throws the
   * reason when the start must be refused.
   */
  async launchContext(record: AgentRecord): Promise<LaunchContext['customProvider']> {
    const provider = getProvider(record.customProviderId)
    const needsGateway =
      record.harness === 'codex-cli' && !!provider && codexNeedsResponsesGateway(provider)
    let codexGateway: { baseUrl: string; key: string } | undefined
    if (needsGateway) {
      try {
        codexGateway = (await this.ensureGateway()).forAgent(record.id)
      } catch (error) {
        this.log(`responses gateway: could not start: ${String(error)}`)
      }
    }
    const problem =
      customProviderLaunchProblem(record.harness, provider, {
        ...(record.customProviderId ? { providerId: record.customProviderId } : {}),
        codexGateway: codexGateway !== undefined
      }) ?? (provider ? customProviderTransportProblem(provider) : undefined)
    if (problem || !provider) throw new Error(`${record.name}: ${problem ?? 'no provider'}`)
    const key = await providerKey(provider.id)
    return { provider, ...(key ? { key } : {}), ...(codexGateway ? { codexGateway } : {}) }
  }

  private ensureGateway(): Promise<ResponsesGateway> {
    this.gateway ??= startResponsesGateway({
      resolve: async (agentId) => {
        const record = this.lookup(agentId)
        if (!record || record.provider !== 'custom')
          return { status: 404, message: 'nsq gateway: unknown agent' }
        const provider = getProvider(record.customProviderId)
        if (!provider || provider.endpoints.chat !== true) {
          return {
            status: 400,
            message: `nsq gateway: the provider of ${record.name} was removed or has no OpenAI chat endpoint`
          }
        }
        const model = record.model ?? provider.models[0]?.id
        if (!model) {
          return {
            status: 400,
            message: `No model on ${provider.name} — nsq set ${record.name} --model <id>`
          }
        }
        const key = await providerKey(provider.id)
        return {
          url: `${customProviderBaseUrl(provider, 'openai')}/chat/completions`,
          ...(key ? { key } : {}),
          model,
          models: provider.models.map((entry) => entry.id),
          label: provider.name
        }
      },
      onError: (error) => this.log(`responses gateway: request failed: ${String(error)}`)
    }).catch((error: unknown) => {
      this.gateway = undefined
      throw error
    })
    return this.gateway
  }

  async close(): Promise<void> {
    const gateway = this.gateway
    this.gateway = undefined
    if (gateway) await (await gateway.catch(() => undefined))?.close()
  }
}
