import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexSessionModels, codexUserConfigFrom, parseToml } from '../harnesses/codex/config.js'
import {
  OPENROUTER_ATTRIBUTION,
  openCodeConfigWithAttribution,
  openRouterLaunch,
  openRouterOnlyMessage,
  openRouterOnlyModel
} from './openrouter.js'

describe('OpenRouter-only model ids', () => {
  it('Claude Code: a slash is OpenRouter, except a Bedrock ARN', () => {
    expect(openRouterOnlyModel('claude-code', 'anthropic/claude-sonnet-5.5')).toBe(true)
    expect(openRouterOnlyModel('claude-code', 'openai/gpt-6-sol')).toBe(true)
    expect(openRouterOnlyModel('claude-code', 'claude-sonnet-4-5')).toBe(false)
    expect(openRouterOnlyModel('claude-code', 'opus')).toBe(false)
    expect(
      openRouterOnlyModel(
        'claude-code',
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc'
      )
    ).toBe(false)
  })

  it('Codex: a slash is OpenRouter on its own (OpenAI) provider, not on the user’s own provider', () => {
    expect(openRouterOnlyModel('codex-cli', 'openai/gpt-5')).toBe(true)
    expect(openRouterOnlyModel('codex-cli', 'openai/gpt-5', { codexModelProvider: 'openai' })).toBe(
      true
    )
    expect(openRouterOnlyModel('codex-cli', 'gpt-5-codex')).toBe(false)
    expect(openRouterOnlyModel('codex-cli', 'qwen/qwen3', { codexModelProvider: 'ollama' })).toBe(
      false
    )
  })

  it('OpenCode: native ids are provider/model, only the ~ alias is OpenRouter’s', () => {
    expect(openRouterOnlyModel('opencode', 'anthropic/claude-sonnet-4-5')).toBe(false)
    expect(openRouterOnlyModel('opencode', 'openrouter/openai/gpt-5')).toBe(false)
    expect(openRouterOnlyModel('opencode', '~anthropic/claude-sonnet-latest')).toBe(true)
  })

  it('the ~ alias on every harness; nothing for a command, no model or garbage', () => {
    expect(openRouterOnlyModel('claude-code', '~anthropic/claude-opus-latest')).toBe(true)
    expect(openRouterOnlyModel('codex-cli', '~openai/gpt-sol-latest')).toBe(true)
    expect(openRouterOnlyModel('command', 'openai/gpt-5')).toBe(false)
    expect(openRouterOnlyModel('claude-code', undefined)).toBe(false)
    expect(openRouterOnlyModel('claude-code', 'a b/c')).toBe(false)
  })

  it('says how to fix it', () => {
    expect(openRouterOnlyMessage('openai/gpt-5')).toBe(
      'openai/gpt-5 is an OpenRouter model id — add --provider openrouter'
    )
  })
})

describe('OpenCode on OpenRouter: the model is declared', () => {
  it('a slug the catalog may not have yet is declared on the provider', () => {
    const content = JSON.parse(
      openRouterLaunch('opencode', 'k', 'moonshotai/kimi-k3').env.OPENCODE_CONFIG_CONTENT
    )
    expect(content.provider.openrouter.models).toEqual({ 'moonshotai/kimi-k3': {} })
    expect(content.provider.openrouter.options.headers).toEqual(OPENROUTER_ATTRIBUTION)
  })

  it('the user’s own entry for that model is kept', () => {
    const user = JSON.stringify({
      provider: { openrouter: { models: { 'x/y': { name: 'Mine', limit: { context: 9 } } } } }
    })
    const content = JSON.parse(openCodeConfigWithAttribution(user, undefined, 'x/y'))
    expect(content.provider.openrouter.models['x/y']).toEqual({
      name: 'Mine',
      limit: { context: 9 }
    })
  })

  it('no model, no declaration', () => {
    const content = JSON.parse(
      openRouterLaunch('opencode', 'k', undefined).env.OPENCODE_CONFIG_CONTENT
    )
    expect(content.provider.openrouter.models).toBeUndefined()
  })
})

describe('Codex user config: model_provider', () => {
  it('root, or the selected profile’s', () => {
    expect(codexUserConfigFrom(parseToml('model_provider = "ollama"')).modelProvider).toBe('ollama')
    expect(
      codexUserConfigFrom(
        parseToml(
          'model_provider = "openai"\nprofile = "local"\n[profiles.local]\nmodel_provider = "lmstudio"'
        )
      ).modelProvider
    ).toBe('lmstudio')
    expect(codexUserConfigFrom(parseToml('model = "gpt-5"')).modelProvider).toBeUndefined()
  })
})

describe('Codex session models', () => {
  it('every turn’s model from the session’s rollout, oldest first', () => {
    const home = mkdtempSync(join(tmpdir(), 'nsq-codex-rollout-'))
    try {
      const id = '01a120dd-714b-77f1-909b-8c130ff56d67'
      const dir = join(home, 'sessions', '2026', '10', '09')
      mkdirSync(dir, { recursive: true })
      const line = (type: string, payload: object): string => JSON.stringify({ type, payload })
      writeFileSync(
        join(dir, `rollout-2026-10-09T16-32-25-${id}.jsonl`),
        [
          line('session_meta', { id, model_provider: 'openai' }),
          line('turn_context', { model: 'gpt-5.5' }),
          line('response_item', { type: 'message' }),
          line('turn_context', { model: 'openai/gpt-5.5' }),
          '{"type":"turn_context","payl'
        ].join('\n')
      )
      expect(codexSessionModels(id, home)).toEqual(['gpt-5.5', 'openai/gpt-5.5'])
      expect(codexSessionModels('00000000-0000-0000-0000-000000000000', home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
