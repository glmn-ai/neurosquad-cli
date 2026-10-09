import { describe, expect, it } from 'vitest'
import {
  CUSTOM_PROVIDER_KEY_ENV,
  CUSTOM_PROVIDER_PLACEHOLDER_KEY,
  customProviderApis,
  customProviderBaseUrl,
  customProviderDraftProblem,
  customProviderHarnessProblem,
  customProviderKeyProblem,
  customProviderLaunch,
  customProviderLaunchProblem,
  customProviderModelsUrl,
  customProviderTransport,
  customProviderTransportProblem,
  customProviderTransportWarning,
  filterCustomModels,
  harnessSupportsCustomProvider,
  isLocalHost,
  isLoopbackHost,
  parseCustomModels,
  parseCustomProviderUrl,
  type CustomProvider,
  type CustomProviderDraft
} from './custom.js'
import { OPENROUTER_ATTRIBUTION } from './openrouter.js'

const LM_STUDIO: CustomProviderDraft = {
  name: 'lmstudio',
  protocol: 'http',
  host: 'localhost',
  port: 1234,
  pathPrefix: ''
}

function provider(
  endpoints: CustomProvider['endpoints'],
  extra: Partial<CustomProvider> = {}
): CustomProvider {
  return {
    ...LM_STUDIO,
    id: 'lmstudio',
    models: [{ id: 'qwen3-coder', contextWindow: 32768 }, { id: 'llama3.1:8b' }],
    modelsFetchedAt: '2026-10-09T00:00:00.000Z',
    endpoints,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    ...extra
  }
}

const SECRET = 'sk-local-secret-123'

/** No OpenRouter attribution value anywhere in a recipe. */
function expectNoAttribution(launch: { args: string[]; env: Record<string, string> }): void {
  const text = JSON.stringify(launch)
  for (const [name, value] of Object.entries(OPENROUTER_ATTRIBUTION)) {
    expect(text).not.toContain(name)
    if (value !== 'NeuroSquad') expect(text).not.toContain(value)
  }
  expect(text).not.toContain('http_headers')
  expect(text).not.toContain('ANTHROPIC_CUSTOM_HEADERS')
  expect(text).not.toContain('"headers"')
  expect(text.toLowerCase()).not.toContain('openrouter')
}

describe('customProviderDraftProblem', () => {
  it('accepts a local server, a remote one with a path, and an IPv6 literal', () => {
    expect(customProviderDraftProblem(LM_STUDIO)).toBeUndefined()
    expect(
      customProviderDraftProblem({
        ...LM_STUDIO,
        protocol: 'https',
        host: 'api.deepseek.com',
        port: 443,
        pathPrefix: '/anthropic'
      })
    ).toBeUndefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, host: '[::1]' })).toBeUndefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, host: '192.168.1.20' })).toBeUndefined()
  })

  it('refuses a scheme, port or path typed into the host, and bad ports and paths', () => {
    expect(customProviderDraftProblem({ ...LM_STUDIO, host: 'http://localhost' })).toBeDefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, host: 'localhost:1234' })).toBeDefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, host: 'a b' })).toBeDefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, port: 0 })).toBeDefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, port: 70000 })).toBeDefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, port: 12.5 })).toBeDefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, pathPrefix: 'api' })).toBeDefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, pathPrefix: '/a?b=1' })).toBeDefined()
    expect(customProviderDraftProblem({ ...LM_STUDIO, name: '  ' })).toBeDefined()
    expect(customProviderDraftProblem(null)).toBeDefined()
  })
})

describe('parseCustomProviderUrl', () => {
  it('takes the base however it is pasted; /v1 and API paths are dropped', () => {
    expect(parseCustomProviderUrl('lms', 'http://localhost:1234')).toEqual({
      ...LM_STUDIO,
      name: 'lms'
    })
    expect(parseCustomProviderUrl('o', 'http://localhost:11434/v1').pathPrefix).toBe('')
    expect(parseCustomProviderUrl('o', 'http://localhost:11434/v1/').pathPrefix).toBe('')
    expect(
      parseCustomProviderUrl('v', 'http://127.0.0.1:8000/v1/chat/completions').pathPrefix
    ).toBe('')
    expect(parseCustomProviderUrl('v', 'http://127.0.0.1:8000/v1/messages').pathPrefix).toBe('')
    const remote = parseCustomProviderUrl('ds', 'https://api.deepseek.com/anthropic')
    expect(remote).toMatchObject({ protocol: 'https', port: 443, pathPrefix: '/anthropic' })
    expect(customProviderBaseUrl(remote, 'anthropic')).toBe('https://api.deepseek.com/anthropic')
    expect(parseCustomProviderUrl('x', 'https://gw.example.com/api/v1').pathPrefix).toBe('/api')
  })

  it('no scheme: http for a local host, https for anything else', () => {
    expect(parseCustomProviderUrl('a', 'localhost:8080')).toMatchObject({
      protocol: 'http',
      port: 8080
    })
    expect(parseCustomProviderUrl('a', '192.168.1.7:8000').protocol).toBe('http')
    expect(parseCustomProviderUrl('a', 'api.example.com').protocol).toBe('https')
  })

  it('refuses credentials, queries, other schemes and garbage', () => {
    expect(() => parseCustomProviderUrl('a', 'http://user:pw@localhost:1')).toThrow(/user:password/)
    expect(() => parseCustomProviderUrl('a', 'http://localhost:1/?key=1')).toThrow(/query/)
    expect(() => parseCustomProviderUrl('a', 'ftp://localhost')).toThrow(/http or https/)
    expect(() => parseCustomProviderUrl('a', '')).toThrow()
    expect(() => parseCustomProviderUrl('a', 'http://')).toThrow()
  })
})

describe('transport policy', () => {
  it('http only on this machine or the local network (with a warning there)', () => {
    const lan = parseCustomProviderUrl('a', 'http://192.168.1.7:8000')
    const remote = parseCustomProviderUrl('a', 'http://api.example.com')
    const secure = parseCustomProviderUrl('a', 'https://api.example.com')
    expect(customProviderTransport(LM_STUDIO)).toBe('http-loopback')
    expect(customProviderTransport(lan)).toBe('http-lan')
    expect(customProviderTransport(remote)).toBe('http-remote')
    expect(customProviderTransport(secure)).toBe('https')
    expect(customProviderTransportProblem(LM_STUDIO)).toBeUndefined()
    expect(customProviderTransportProblem(lan)).toBeUndefined()
    expect(customProviderTransportProblem(remote)).toMatch(/use https/)
    expect(customProviderTransportProblem(secure)).toBeUndefined()
    expect(customProviderTransportWarning(LM_STUDIO)).toBeUndefined()
    expect(customProviderTransportWarning(lan)).toMatch(/unencrypted/)
    expect(customProviderTransportWarning(secure)).toBeUndefined()
  })

  it('calls loopback and private networks local', () => {
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('127.0.0.1')).toBe(true)
    expect(isLocalHost('[::1]')).toBe(true)
    expect(isLocalHost('192.168.0.5')).toBe(true)
    expect(isLocalHost('172.20.1.1')).toBe(true)
    expect(isLocalHost('10.0.0.3')).toBe(true)
    expect(isLocalHost('[fd12:3456::1]')).toBe(true)
    expect(isLocalHost('gpu-box')).toBe(true)
    expect(isLocalHost('gpu-box.local')).toBe(true)
    expect(isLocalHost('api.example.com')).toBe(false)
    expect(isLocalHost('172.32.0.1')).toBe(false)
    expect(isLocalHost('8.8.8.8')).toBe(false)
    // A public name that only starts like a private address is not one.
    expect(isLocalHost('127.example.com')).toBe(false)
    expect(isLocalHost('10.gpu.example.net')).toBe(false)
    expect(isLoopbackHost('127.example.com')).toBe(false)
    expect(isLoopbackHost('box.localhost')).toBe(false)
    expect(isLoopbackHost('127.0.0.2')).toBe(true)
    expect(customProviderTransport(parseCustomProviderUrl('a', 'http://127.example.com:80'))).toBe(
      'http-remote'
    )
  })
})

describe('URLs', () => {
  it('builds each API base in its own convention', () => {
    expect(customProviderBaseUrl(LM_STUDIO, 'openai')).toBe('http://localhost:1234/v1')
    expect(customProviderBaseUrl(LM_STUDIO, 'anthropic')).toBe('http://localhost:1234')
    expect(customProviderModelsUrl(LM_STUDIO)).toBe('http://localhost:1234/v1/models')
  })
})

describe('parseCustomModels — each server’s list', () => {
  it('llama.cpp: data[] with meta.n_ctx (the served window, not n_ctx_train)', () => {
    const parsed = parseCustomModels({
      models: [{ name: 'qwen.gguf', model: 'qwen.gguf' }],
      object: 'list',
      data: [
        {
          id: 'qwen.gguf',
          object: 'model',
          owned_by: 'llamacpp',
          meta: { n_ctx: 8192, n_ctx_train: 262144, n_params: 494032768 }
        }
      ]
    })
    expect(parsed?.models).toEqual([{ id: 'qwen.gguf', contextWindow: 8192 }])
    expect(
      parseCustomModels({ data: [{ id: 'm', meta: { n_ctx_train: 262144 } }] })?.models
    ).toEqual([{ id: 'm' }])
  })

  it('vLLM and SGLang: max_model_len', () => {
    expect(
      parseCustomModels({
        object: 'list',
        data: [{ id: 'Qwen/Qwen3-8B', object: 'model', owned_by: 'vllm', max_model_len: 40960 }]
      })?.models
    ).toEqual([{ id: 'Qwen/Qwen3-8B', contextWindow: 40960 }])
    expect(parseCustomModels({ data: [{ id: 'q', max_model_len: '32768' }] })?.models).toEqual([
      { id: 'q', contextWindow: 32768 }
    ])
  })

  it('Ollama: OpenAI list (no window) and its native list; embeddings hidden', () => {
    expect(
      parseCustomModels({
        object: 'list',
        data: [
          { id: 'qwen3:8b', object: 'model', created: 1, owned_by: 'library' },
          { id: 'nomic-embed-text:latest', object: 'model', owned_by: 'library' }
        ]
      })
    ).toEqual({ models: [{ id: 'qwen3:8b' }], skipped: 1 })
    expect(parseCustomModels({ models: [{ name: 'gpt-oss:20b' }] })?.models).toEqual([
      { id: 'gpt-oss:20b' }
    ])
  })

  it('LM Studio: OpenAI list, embeddings hidden; its native list’s loaded window', () => {
    const parsed = parseCustomModels({
      object: 'list',
      data: [
        { id: 'qwen/qwen3-coder-30b', object: 'model', owned_by: 'organization_owner' },
        { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model' }
      ]
    })
    expect(parsed).toEqual({ models: [{ id: 'qwen/qwen3-coder-30b' }], skipped: 1 })
    expect(
      parseCustomModels({ data: [{ id: 'm', loaded_context_length: 16384 }] })?.models
    ).toEqual([{ id: 'm', contextWindow: 16384 }])
  })

  it('Anthropic-style lists: display_name; argv-unsafe ids and duplicates skipped', () => {
    const parsed = parseCustomModels({
      data: [
        { id: 'claude-local', display_name: 'Claude (local)', type: 'model' },
        { id: 'bad id with spaces' },
        { id: 'claude-local' },
        { id: 'router', context_length: 200000 },
        { id: 'odd', context_length: 12.5 }
      ]
    })
    expect(parsed?.models).toEqual([
      { id: 'claude-local', name: 'Claude (local)' },
      { id: 'odd' },
      { id: 'router', contextWindow: 200000 }
    ])
    expect(parsed?.skipped).toBe(1)
  })

  it('refuses what is not a list; filters by every word', () => {
    expect(parseCustomModels({ error: 'nope' })).toBeUndefined()
    expect(parseCustomModels('html')).toBeUndefined()
    const models = [{ id: 'qwen3-coder' }, { id: 'llama3.1:8b', name: 'Llama 3.1' }]
    expect(filterCustomModels(models, 'llama 3.1').map((m) => m.id)).toEqual(['llama3.1:8b'])
    expect(filterCustomModels(models, '')).toHaveLength(2)
  })
})

describe('keys', () => {
  it('refuses keys that could break a header', () => {
    expect(customProviderKeyProblem('lm-studio-token')).toBeUndefined()
    expect(customProviderKeyProblem('a\nb')).toBeDefined()
    expect(customProviderKeyProblem('x'.repeat(5000))).toBeDefined()
  })
})

describe('which harness runs on which provider', () => {
  it('offers each CLI the provider when its own endpoint is there, else says why', () => {
    const all = provider({ chat: true, responses: true, messages: true })
    const chatOnly = provider({ chat: true, responses: false, messages: false })
    const messagesOnly = provider({ messages: true })
    expect(harnessSupportsCustomProvider('claude-code', all)).toBe(true)
    expect(harnessSupportsCustomProvider('claude-code', chatOnly)).toBe(false)
    expect(customProviderHarnessProblem('claude-code', chatOnly)).toMatch(
      /Anthropic Messages API.*serves chat completions/
    )
    expect(harnessSupportsCustomProvider('claude-code', messagesOnly)).toBe(true)
    expect(harnessSupportsCustomProvider('codex-cli', chatOnly)).toBe(true)
    expect(harnessSupportsCustomProvider('codex-cli', messagesOnly)).toBe(false)
    // A Responses-only server: Codex directly, nobody else.
    const responsesOnly = provider({ responses: true })
    expect(harnessSupportsCustomProvider('codex-cli', responsesOnly)).toBe(true)
    expect(harnessSupportsCustomProvider('opencode', responsesOnly)).toBe(false)
    expect(harnessSupportsCustomProvider('claude-code', responsesOnly)).toBe(false)
    expect(harnessSupportsCustomProvider('opencode', chatOnly)).toBe(true)
    expect(harnessSupportsCustomProvider('opencode', messagesOnly)).toBe(true)
    expect(harnessSupportsCustomProvider('command', all)).toBe(false)
    expect(customProviderApis(all.endpoints)).toEqual(['openai', 'anthropic'])
  })

  it('a start is refused, never on the own login: removed provider, Codex without its gateway', () => {
    const chatOnly = provider({ chat: true })
    expect(customProviderLaunchProblem('codex-cli', undefined, { providerId: 'x' })).toMatch(
      /no longer exists/
    )
    expect(customProviderLaunchProblem('codex-cli', chatOnly)).toMatch(/gateway/)
    expect(customProviderLaunchProblem('codex-cli', chatOnly, { codexGateway: true })).toBe(
      undefined
    )
    expect(customProviderLaunchProblem('claude-code', chatOnly)).toMatch(/Anthropic/)
  })
})

describe('recipes', () => {
  const all = provider({ chat: true, responses: true, messages: true })

  it('Claude Code: Anthropic base, the key only in env, a placeholder without one', () => {
    const launch = customProviderLaunch('claude-code', all, SECRET, 'qwen3-coder')
    expect(launch.args).toEqual([])
    expect(launch.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://localhost:1234',
      ANTHROPIC_AUTH_TOKEN: SECRET,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3-coder',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192'
    })
    expect(launch.env['ANTHROPIC_CUSTOM_HEADERS']).toBeUndefined()
    // Another cloud backend inherited from the user's environment is switched off.
    expect(launch.env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: ''
    })
    expectNoAttribution(launch)
    // No key: a placeholder keeps Claude Code off the user's own login.
    const keyless = customProviderLaunch('claude-code', all, undefined, 'llama3.1:8b')
    expect(keyless.env['ANTHROPIC_AUTH_TOKEN']).toBe(CUSTOM_PROVIDER_PLACEHOLDER_KEY)
    expect(keyless.env['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBeUndefined()
    // A server without /v1/messages: nothing.
    expect(customProviderLaunch('claude-code', provider({ chat: true }), SECRET, 'm')).toEqual({
      args: [],
      env: {}
    })
  })

  it('Codex with /v1/responses: its own provider, key by variable name, never in argv', () => {
    const launch = customProviderLaunch('codex-cli', all, SECRET, 'qwen3-coder')
    expect(launch.args).toEqual([
      '-c',
      'model_provider=neurosquad-custom',
      '-c',
      'model_providers.neurosquad-custom.name="lmstudio"',
      '-c',
      'model_providers.neurosquad-custom.base_url=http://localhost:1234/v1',
      '-c',
      'model_providers.neurosquad-custom.wire_api=responses',
      '-c',
      `model_providers.neurosquad-custom.env_key=${CUSTOM_PROVIDER_KEY_ENV}`,
      '--model',
      'qwen3-coder',
      '-c',
      'model_context_window=32768',
      '-c',
      'model_auto_compact_token_limit=27852'
    ])
    expect(launch.args.join(' ')).not.toContain(SECRET)
    expect(launch.env).toEqual({ [CUSTOM_PROVIDER_KEY_ENV]: SECRET })
    expectNoAttribution(launch)
    // No key: no env_key, so Codex sends no Authorization at all.
    const keyless = customProviderLaunch('codex-cli', all, undefined, 'm')
    expect(keyless.args.join(' ')).not.toContain('env_key')
    expect(keyless.env).toEqual({})
  })

  it('Codex on a chat-only server: the gateway’s address and the agent credential, never the key', () => {
    const chatOnly = provider({ chat: true, responses: false })
    expect(customProviderLaunch('codex-cli', chatOnly, SECRET, 'm')).toEqual({ args: [], env: {} })
    const launch = customProviderLaunch('codex-cli', chatOnly, SECRET, 'qwen3-coder', {
      codexGateway: { baseUrl: 'http://127.0.0.1:5555/x/a/v1', key: 'agent-cred' }
    })
    expect(launch.args).toContain(
      'model_providers.neurosquad-custom.base_url=http://127.0.0.1:5555/x/a/v1'
    )
    expect(launch.env).toEqual({ [CUSTOM_PROVIDER_KEY_ENV]: 'agent-cred' })
    expect(JSON.stringify(launch)).not.toContain(SECRET)
  })

  it('OpenCode: an inline provider for either API, the key by reference only', () => {
    const chat = customProviderLaunch('opencode', all, SECRET, 'qwen3-coder', {
      openCodeConfigContent: JSON.stringify({ theme: 'dark' })
    })
    expect(chat.args).toEqual(['--model', 'neurosquad-custom/qwen3-coder'])
    expect(chat.env[CUSTOM_PROVIDER_KEY_ENV]).toBe(SECRET)
    const config = JSON.parse(chat.env['OPENCODE_CONFIG_CONTENT']!)
    expect(config.theme).toBe('dark')
    expect(config.provider['neurosquad-custom']).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'lmstudio',
      options: {
        baseURL: 'http://localhost:1234/v1',
        apiKey: `{env:${CUSTOM_PROVIDER_KEY_ENV}}`
      },
      models: {
        'qwen3-coder': { name: 'qwen3-coder', limit: { context: 32768, output: 8192 } },
        'llama3.1:8b': { name: 'llama3.1:8b' }
      }
    })
    expect(chat.env['OPENCODE_CONFIG_CONTENT']).not.toContain(SECRET)
    expectNoAttribution(chat)
    const anthropic = customProviderLaunch('opencode', provider({ messages: true }), undefined, 'x')
    const anthropicConfig = JSON.parse(anthropic.env['OPENCODE_CONFIG_CONTENT']!)
    expect(anthropicConfig.provider['neurosquad-custom'].npm).toBe('@ai-sdk/anthropic')
    expect(anthropicConfig.provider['neurosquad-custom'].options.baseURL).toBe(
      'http://localhost:1234/v1'
    )
    // A model the list did not have is declared too (OpenCode runs only models it knows).
    expect(anthropicConfig.provider['neurosquad-custom'].models.x).toEqual({ name: 'x' })
    expect(anthropic.env[CUSTOM_PROVIDER_KEY_ENV]).toBe(CUSTOM_PROVIDER_PLACEHOLDER_KEY)
  })

  it('Codex gets the provider name as a TOML string, whatever it looks like', () => {
    for (const name of ['4090', 'true', '1e5', 'inf']) {
      const launch = customProviderLaunch('codex-cli', { ...all, name }, undefined, 'm')
      expect(launch.args).toContain(`model_providers.neurosquad-custom.name="${name}"`)
    }
    // Anything that is not a plain word becomes "custom" (it reaches argv).
    const odd = customProviderLaunch('codex-cli', { ...all, name: 'a "b" \\ c' }, undefined, 'm')
    expect(odd.args).toContain('model_providers.neurosquad-custom.name="custom"')
  })

  it('a model served from a path (vLLM `serve /data/models/X`) is a valid id', () => {
    expect(
      parseCustomModels({ data: [{ id: '/data/models/Qwen3-8B', max_model_len: 32768 }] })?.models
    ).toEqual([{ id: '/data/models/Qwen3-8B', contextWindow: 32768 }])
    const launch = customProviderLaunch('codex-cli', all, undefined, '/data/models/Qwen3-8B')
    expect(
      launch.args.slice(launch.args.indexOf('--model'), launch.args.indexOf('--model') + 2)
    ).toEqual(['--model', '/data/models/Qwen3-8B'])
    // Never an option-looking id.
    expect(customProviderLaunch('codex-cli', all, undefined, '-x').args).not.toContain('--model')
  })

  it('drops a model id that is not safe for argv', () => {
    const launch = customProviderLaunch('codex-cli', all, SECRET, 'x; rm -rf /')
    expect(launch.args).not.toContain('--model')
  })
})
