// Regression tests for robustness fixes across the core.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from './util/atomicWrite.js'
import { listCost } from './usage/pricing.js'
import { OpenCodeSource } from './usage/sources/opencode.js'
import { startHookServer } from './hooks/server.js'
import { codexUserConfigFrom, parseToml } from './harnesses/codex/config.js'
import type { UsageRecord } from './usage/types.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-core-'))
  dirs.push(dir)
  return dir
}

const record = (extra: Partial<UsageRecord> = {}): UsageRecord => ({
  id: 'openrouter:1',
  source: 'openrouter',
  provider: 'openrouter',
  model: 'x/y',
  at: 1,
  sessionId: 's',
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  webSearches: 0,
  ...extra
})

describe('writeFileAtomic', () => {
  it('drops a backup an earlier process left behind', () => {
    const dir = scratch()
    const file = join(dir, 'store.json')
    writeFileSync(`${file}.bak`, '{"old":true}')
    writeFileAtomic(file, '{"new":true}')
    expect(existsSync(`${file}.bak`)).toBe(false)
  })
})

describe('listCost', () => {
  it('a rate that is not an integer is no price, not a crash', () => {
    const rates = { input: 37_499.99999999, output: 1_000_000 }
    expect(listCost(record(), () => rates)).toEqual({ reason: 'unpublished-rate' })
  })
})

describe('OpenCodeSource.importState', () => {
  it('keeps only well-formed records from a damaged cache', () => {
    const source = new OpenCodeSource(() => join(scratch(), 'none.db'))
    source.importState({
      v: 5,
      stamp: 'x',
      records: [null, 7, record({ id: 'opencode:a', source: 'opencode' })]
    })
    expect(source.records().map((r) => r.id)).toEqual(['opencode:a'])
  })
})

describe('Codex user config', () => {
  it('only plain provider ids can carry the attribution headers', () => {
    const config = parseToml(
      [
        '[model_providers.ok]',
        'base_url = "https://openrouter.ai/api/v1"',
        '[model_providers."my=prov"]',
        'base_url = "https://openrouter.ai/api/v1"'
      ].join('\n')
    )
    expect(codexUserConfigFrom(config).openRouterProviderIds).toEqual(['ok'])
  })
})

describe('hook server', () => {
  it('answers 500 when the host throws, and keeps serving', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    let fail = true
    const server = await startHookServer({
      knows: () => {
        if (fail) throw new Error('boom')
        return true
      },
      arrive: () => 0,
      handle: () => '{}'
    })
    try {
      const url = `${server.baseFor(id)}/Stop`
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(500)
      fail = false
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(200)
    } finally {
      await server.close()
    }
  })
})
