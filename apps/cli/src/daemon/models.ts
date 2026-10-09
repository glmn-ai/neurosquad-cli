// OpenRouter's public model list (no key needed), cached for a day in the nsq home.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  filterOpenRouterModels,
  parseOpenRouterModels,
  writeFileAtomic,
  type OpenRouterModel
} from '@neurosquad/core'
import { paths } from '../paths.js'

const CACHE_MS = 24 * 60 * 60_000
const URL = 'https://openrouter.ai/api/v1/models'

let memory: { at: number; models: OpenRouterModel[] } | null = null

function cacheFile(): string {
  return join(paths.home(), 'openrouter-models.json')
}

async function load(): Promise<OpenRouterModel[]> {
  if (memory && Date.now() - memory.at < CACHE_MS) return memory.models
  try {
    const cached = JSON.parse(readFileSync(cacheFile(), 'utf8')) as {
      at: number
      models: OpenRouterModel[]
    }
    if (Date.now() - cached.at < CACHE_MS && Array.isArray(cached.models)) {
      memory = cached
      return cached.models
    }
  } catch {
    // no cache
  }
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const models = parseOpenRouterModels(await response.json())
    memory = { at: Date.now(), models }
    writeFileAtomic(cacheFile(), JSON.stringify(memory))
    return models
  } catch (error) {
    if (memory) return memory.models
    throw new Error(`could not load the OpenRouter model list: ${String(error)}`, {
      cause: error
    })
  }
}

export async function fetchOpenRouterModels(query?: string): Promise<OpenRouterModel[]> {
  const models = await load()
  return query ? filterOpenRouterModels(models, query, 200) : models
}
