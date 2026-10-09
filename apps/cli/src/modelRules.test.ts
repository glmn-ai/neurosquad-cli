import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkModelChoice,
  modelNeedsOpenRouter,
  modelSwitchText,
  ownModelOnResume
} from './modelRules.js'

const saved = { codex: process.env['CODEX_HOME'], claude: process.env['CLAUDE_CONFIG_DIR'] }
const dirs: string[] = []
afterEach(() => {
  if (saved.codex === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = saved.codex
  if (saved.claude === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = saved.claude
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const codexHomeWith = (toml: string): string => {
  const dir = scratch('nsq-codex-home-')
  writeFileSync(join(dir, 'config.toml'), toml)
  process.env['CODEX_HOME'] = dir
  return dir
}
const jsonl = (entries: object[]): string => entries.map((e) => JSON.stringify(e)).join('\n')

describe('model choice', () => {
  it('refuses an OpenRouter slug without OpenRouter, with the fix', () => {
    expect(() => checkModelChoice('claude-code', undefined, 'anthropic/claude-sonnet-5.5')).toThrow(
      'anthropic/claude-sonnet-5.5 is an OpenRouter model id — add --provider openrouter'
    )
    codexHomeWith('model = "gpt-5"')
    expect(() => checkModelChoice('codex-cli', undefined, 'openai/gpt-6-sol')).toThrow(
      /add --provider openrouter/
    )
  })

  it('accepts it on OpenRouter, native ids on the own login, and no model', () => {
    expect(() =>
      checkModelChoice('claude-code', 'openrouter', 'anthropic/claude-sonnet-5.5')
    ).not.toThrow()
    expect(() => checkModelChoice('claude-code', undefined, 'claude-opus-5-5')).not.toThrow()
    expect(() => checkModelChoice('claude-code', undefined, undefined)).not.toThrow()
    // OpenCode's own ids look like OpenRouter's: never refused.
    expect(() =>
      checkModelChoice('opencode', undefined, 'anthropic/claude-sonnet-4-5')
    ).not.toThrow()
  })

  it('Codex on the user’s own provider takes vendor/model natively', () => {
    codexHomeWith(
      'model_provider = "ollama"\n[model_providers.ollama]\nbase_url = "http://localhost:11434/v1"'
    )
    expect(modelNeedsOpenRouter('codex-cli', 'qwen/qwen3-coder')).toBe(false)
    expect(() => checkModelChoice('codex-cli', undefined, 'qwen/qwen3-coder')).not.toThrow()
  })

  it('turning OpenRouter off with the slug still set says to clear the model too', () => {
    expect(() => checkModelChoice('claude-code', undefined, 'openai/gpt-5', true)).toThrow(
      /--model none/
    )
  })

  it('refuses a native id on OpenRouter (Claude Code, Codex), with the fix', () => {
    expect(() => checkModelChoice('claude-code', 'openrouter', 'claude-opus-5-5')).toThrow(
      /not an OpenRouter model id .* --provider none/
    )
    expect(() => checkModelChoice('codex-cli', 'openrouter', 'gpt-5.5')).toThrow(/--provider none/)
    expect(() => checkModelChoice('opencode', 'openrouter', 'fake-model')).not.toThrow()
    expect(() => checkModelChoice('claude-code', 'openrouter', 'openrouter/auto')).not.toThrow()
  })

  it('refuses what is not a model id', () => {
    expect(() => checkModelChoice('claude-code', 'openrouter', 'a b; rm -rf')).toThrow(
      /not a model id/
    )
  })
})

describe('model switch text', () => {
  it('says when the switch happens and that the session is kept', () => {
    expect(modelSwitchText('openai/gpt-6-sol', 'openrouter', 'now')).toBe(
      'switched to openai/gpt-6-sol on OpenRouter (session kept)'
    )
    expect(modelSwitchText('openai/gpt-6-sol', 'openrouter', 'after-turn')).toBe(
      'switches to openai/gpt-6-sol on OpenRouter when this turn ends (session kept)'
    )
    expect(modelSwitchText(undefined, undefined, 'next-start')).toBe(
      'its own login and default model: applies on the next start'
    )
  })
})

describe('the own model on resume, back from OpenRouter', () => {
  const session = '0b7a1c52-6a43-4d55-9f1e-2a2f0c3c9d11'

  it('Claude Code: `default` (or the settings model) when the session last ran on a slug', () => {
    const dir = scratch('nsq-claude-config-')
    process.env['CLAUDE_CONFIG_DIR'] = dir
    mkdirSync(join(dir, 'projects', 'E--work-app'), { recursive: true })
    const transcript = join(dir, 'projects', 'E--work-app', `${session}.jsonl`)
    writeFileSync(
      transcript,
      jsonl([
        { type: 'assistant', message: { model: 'claude-opus-5-5' } },
        { type: 'assistant', message: { model: 'anthropic/claude-sonnet-5.5' } },
        { type: 'assistant', message: { model: '<synthetic>' } }
      ])
    )
    expect(ownModelOnResume('claude-code', session)).toEqual({ model: 'default' })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'sonnet' }))
    expect(ownModelOnResume('claude-code', session)).toEqual({ model: 'sonnet' })
    // A session whose last turn was on an own model resumes as it is.
    writeFileSync(transcript, jsonl([{ type: 'assistant', message: { model: 'claude-opus-5-5' } }]))
    expect(ownModelOnResume('claude-code', session)).toEqual({})
    expect(ownModelOnResume('claude-code', 'no-such-session')).toEqual({})
  })

  it('Codex: the configured model, else the session’s last own one, else a warning', () => {
    const home = codexHomeWith('approval_policy = "on-request"')
    const dir = join(home, 'sessions', '2026', '10', '09')
    mkdirSync(dir, { recursive: true })
    const rollout = join(dir, `rollout-2026-10-09T10-00-00-${session}.jsonl`)
    const turns = (...models: string[]): string =>
      jsonl(models.map((model) => ({ type: 'turn_context', payload: { model } })))
    writeFileSync(rollout, turns('gpt-5.5', 'openai/gpt-6-sol'))
    expect(ownModelOnResume('codex-cli', session)).toEqual({ model: 'gpt-5.5' })
    writeFileSync(rollout, turns('openai/gpt-6-sol'))
    expect(ownModelOnResume('codex-cli', session).warning).toMatch(/openai\/gpt-6-sol/)
    // (A new Codex home: the config is cached per home for 10 s.)
    const configured = codexHomeWith('model = "gpt-5.5-codex"')
    mkdirSync(join(configured, 'sessions', '2026', '10', '09'), { recursive: true })
    writeFileSync(
      join(configured, 'sessions', '2026', '10', '09', `rollout-x-${session}.jsonl`),
      turns('gpt-5.5', 'openai/gpt-6-sol')
    )
    expect(ownModelOnResume('codex-cli', session)).toEqual({ model: 'gpt-5.5-codex' })
  })
})

describe('a custom server’s ids are its own', () => {
  it('an LM Studio id that looks like an OpenRouter slug is never taken for one', () => {
    // `qwen/qwen3-coder-30b` on the user's own server: no refusal, no move to OpenRouter.
    for (const harness of ['claude-code', 'codex-cli', 'opencode'] as const) {
      expect(() => checkModelChoice(harness, 'custom', 'qwen/qwen3-coder-30b')).not.toThrow()
    }
    // The same id on the own login is still refused (it only exists on OpenRouter there).
    expect(() => checkModelChoice('claude-code', undefined, 'qwen/qwen3-coder-30b')).toThrow()
  })

  it('the switch text names the server', () => {
    expect(modelSwitchText('qwen/qwen3-coder-30b', 'custom', 'now', 'lmstudio')).toBe(
      'switched to qwen/qwen3-coder-30b on lmstudio (session kept)'
    )
  })
})
