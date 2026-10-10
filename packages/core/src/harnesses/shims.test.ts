import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shimModuleDirs } from '../pty/npmShim.js'
import { buildCodexConfigArgs, codexExecutable } from './codex/launch.js'
import { claudeExecutable } from './launch.js'
import {
  checkedApiBase,
  openRouterLaunch,
  OPENROUTER_ATTRIBUTION
} from '../providers/openrouter.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-shim-'))
  dirs.push(dir)
  return dir
}
const touch = (path: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

describe('npm shim layouts', () => {
  it('global prefix and local node_modules/.bin', () => {
    expect(shimModuleDirs(join('/p', 'codex.cmd'))).toEqual([join('/p', 'node_modules')])
    expect(shimModuleDirs(join('/w', 'node_modules', '.bin', 'codex.cmd'))).toEqual([
      join('/w', 'node_modules', '.bin', 'node_modules'),
      join('/w', 'node_modules')
    ])
  })

  it('finds codex.exe and claude.exe behind a local .bin shim', () => {
    const root = scratch()
    const modules = join(root, 'node_modules')
    const exe = join(
      modules,
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    )
    touch(exe)
    const codex = codexExecutable(join(modules, '.bin', 'codex.cmd'), 'win32', 'x64')
    expect(codex.direct).toBe(true)
    expect(codex.command).toBe(exe.replaceAll('\\', '/'))
    const claude = join(modules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    touch(claude)
    expect(claudeExecutable(join(modules, '.bin', 'claude.cmd'), 'win32')).toBe(
      claude.replaceAll('\\', '/')
    )
    expect(claudeExecutable('/usr/bin/claude', 'linux')).toBe('/usr/bin/claude')
  })
})

describe('Codex folder trust', () => {
  it('trusts every key given (the folder and its repository root)', () => {
    const args = buildCodexConfigArgs({
      richArgs: true,
      openRouterProviderIds: [],
      projectKeys: ['/repo/sub', '/repo'],
      platform: 'linux'
    })
    const projects = args.find((arg) => arg.startsWith('projects='))
    expect(projects).toContain('"/repo/sub"')
    expect(projects).toContain('"/repo"')
  })
})

describe('OpenRouter API base', () => {
  it('points every recipe at another base, attribution unchanged', () => {
    const base = 'http://127.0.0.1:9/api/v1'
    expect(
      openRouterLaunch('claude-code', 'k', 'x/y', { apiBase: base }).env.ANTHROPIC_BASE_URL
    ).toBe('http://127.0.0.1:9/api')
    expect(openRouterLaunch('codex-cli', 'k', 'x/y', { apiBase: base }).args).toContain(
      `model_providers.openrouter.base_url=${base}`
    )
    const content = JSON.parse(
      openRouterLaunch('opencode', 'k', 'x/y', { apiBase: base }).env.OPENCODE_CONFIG_CONTENT
    )
    expect(content.provider.openrouter.options).toEqual({
      headers: OPENROUTER_ATTRIBUTION,
      baseURL: base
    })
    expect(openRouterLaunch('claude-code', 'k', 'x/y').env.ANTHROPIC_BASE_URL).toBe(
      'https://openrouter.ai/api'
    )
  })
})

describe('OpenRouter API base check', () => {
  it('http only to this machine', () => {
    expect(checkedApiBase('https://proxy.example.com/api/v1/')).toBe(
      'https://proxy.example.com/api/v1'
    )
    expect(checkedApiBase('http://127.0.0.1:9/api/v1')).toBe('http://127.0.0.1:9/api/v1')
    expect(checkedApiBase('http://localhost:9/api/v1')).toBe('http://localhost:9/api/v1')
    expect(() => checkedApiBase('http://proxy.example.com/api/v1')).toThrow(/https/)
    expect(() => checkedApiBase('not a url')).toThrow()
    expect(() => checkedApiBase('https://user:secret@proxy.example.com/api/v1')).toThrow(
      /credentials/
    )
    expect(() => checkedApiBase('http://token@127.0.0.1:9/api/v1')).toThrow(/credentials/)
    expect(() =>
      openRouterLaunch('codex-cli', 'k', 'x/y', { apiBase: 'http://10.0.0.5/api/v1' })
    ).toThrow(/https/)
  })
})
