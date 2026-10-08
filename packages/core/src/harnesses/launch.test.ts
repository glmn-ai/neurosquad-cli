import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareLaunch } from './launch.js'
import { OPENROUTER_ATTRIBUTION } from '../providers/openrouter.js'
import { codexHookTrustHash, CODEX_HOOKS } from './codex/hooks.js'
import type { AgentLaunchSpec, LaunchContext } from './types.js'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function ctx(
  agent: Partial<AgentLaunchSpec> & Pick<AgentLaunchSpec, 'harness'>,
  extra: Partial<LaunchContext> = {}
): LaunchContext {
  const layerDir = mkdtempSync(join(tmpdir(), 'nsq-launch-'))
  dirs.push(layerDir)
  return {
    agent: { id: ID, ...agent },
    executable: '/usr/bin/x',
    cwd: layerDir,
    hookBase: `http://127.0.0.1:4000/hook/abcdef0123456789/${ID}`,
    layerDir,
    resumed: false,
    env: {},
    platform: 'linux',
    ...extra
  }
}

describe('Claude Code launch', () => {
  it('starts with --session-id and resumes with --resume, settings carry the hooks', () => {
    const fresh = prepareLaunch(ctx({ harness: 'claude-code' }))
    expect(fresh.args.slice(0, 2)).toEqual(['--session-id', ID])
    const settingsPath = fresh.args[fresh.args.indexOf('--settings') + 1]
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining([
        'UserPromptSubmit',
        'Notification',
        'Stop',
        'PostToolUse',
        'PermissionRequest'
      ])
    )
    expect(JSON.stringify(settings)).toContain(`/hook/abcdef0123456789/${ID}/Stop`)
    const resumed = prepareLaunch(ctx({ harness: 'claude-code' }, { resumed: true }))
    expect(resumed.args.slice(0, 2)).toEqual(['--resume', ID])
    expect(fresh.trustPrompt?.marker).toBe('Quick safety check')
  })

  it('applies the OpenRouter recipe only with a key, headers without the visibility header', () => {
    const none = prepareLaunch(
      ctx({ harness: 'claude-code', provider: 'openrouter', model: 'x/y' })
    )
    expect(none.env.ANTHROPIC_BASE_URL).toBeUndefined()
    const plan = prepareLaunch(
      ctx(
        { harness: 'claude-code', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
        { openRouterKey: 'sk-or-test' }
      )
    )
    expect(plan.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-test')
    expect(plan.env.ANTHROPIC_API_KEY).toBe('')
    expect(plan.env.ANTHROPIC_MODEL).toBe('anthropic/claude-sonnet-4.5')
    expect(plan.env.ANTHROPIC_CUSTOM_HEADERS).toContain('HTTP-Referer: https://neurosquad.ai/')
    expect(plan.env.ANTHROPIC_CUSTOM_HEADERS).not.toMatch(/Visibility/i)
    // The key is never in argv.
    expect(plan.args.join(' ')).not.toContain('sk-or-test')
  })

  it('a native model goes to --model', () => {
    const plan = prepareLaunch(ctx({ harness: 'claude-code', model: 'opus' }))
    expect(plan.args.slice(-2)).toEqual(['--model', 'opus'])
  })
})

describe('Codex launch', () => {
  it('passes hooks with trust records, resume, dangerous mode and OpenRouter as -c flags', () => {
    const plan = prepareLaunch(
      ctx(
        {
          harness: 'codex-cli',
          harnessSessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
          dangerousMode: true,
          provider: 'openrouter',
          model: 'openai/gpt-5'
        },
        {
          resumed: true,
          openRouterKey: 'sk-or-test',
          env: { CODEX_HOME: join(tmpdir(), 'nsq-no-codex-home') }
        }
      )
    )
    expect(plan.args.slice(0, 3)).toEqual([
      'resume',
      '0199a213-81c0-7800-8aa1-bbab2a035a53',
      '--dangerously-bypass-approvals-and-sandbox'
    ])
    const hooks = plan.args.find((arg) => arg.startsWith('hooks='))
    expect(hooks).toBeDefined()
    const curlrc = join(plan.args.join(' ').match(/-K \\"([^"\\]+)\\"/)?.[1] ?? '')
    expect(curlrc).toMatch(/\.curlrc$/)
    expect(existsSync(curlrc)).toBe(true)
    // The token lives in the curl config, not in argv.
    expect(readFileSync(curlrc, 'utf8')).toContain('/hook/abcdef0123456789/')
    expect(plan.args).toContain('model_provider=openrouter')
    for (const [name, value] of Object.entries(OPENROUTER_ATTRIBUTION)) {
      expect(plan.args).toContain(`model_providers.openrouter.http_headers.${name}=${value}`)
    }
    expect(plan.env.OPENROUTER_API_KEY).toBe('sk-or-test')
    expect(plan.args.join(' ')).not.toContain('sk-or-test')
    expect(plan.args.slice(-2)).toEqual(['--model', 'openai/gpt-5'])
  })

  it('trust hashes are stable for a command', () => {
    const a = codexHookTrustHash(CODEX_HOOKS[0], 'curl x')
    expect(a).toBe(codexHookTrustHash(CODEX_HOOKS[0], 'curl x'))
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('OpenCode launch', () => {
  it('1.x: config file with the plugin, --session on resume, --auto in dangerous mode', () => {
    const plan = prepareLaunch(
      ctx(
        { harness: 'opencode', harnessSessionId: 'ses_abcdefgh1234', dangerousMode: true },
        { resumed: true }
      )
    )
    expect(plan.args).toEqual(['--session', 'ses_abcdefgh1234', '--auto'])
    const config = JSON.parse(readFileSync(plan.env.OPENCODE_CONFIG, 'utf8'))
    expect(config.plugin[0]).toMatch(/^file:.*neurosquad-plugin\.js$/)
    expect(plan.env.NEUROSQUAD_HOOK_URL).toContain('/hook/')
    expect(JSON.parse(plan.env.NEUROSQUAD_OPENROUTER_HEADERS)).toEqual(OPENROUTER_ATTRIBUTION)
  })

  it('1.x on OpenRouter: --model openrouter/<slug>, headers in OPENCODE_CONFIG_CONTENT, pinned model', () => {
    const plan = prepareLaunch(
      ctx(
        { harness: 'opencode', provider: 'openrouter', model: 'qwen/qwen3-coder' },
        { openRouterKey: 'sk-or-test' }
      )
    )
    expect(plan.args).toEqual(['--model', 'openrouter/qwen/qwen3-coder'])
    expect(
      JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT).provider.openrouter.options.headers
    ).toEqual(OPENROUTER_ATTRIBUTION)
    expect(plan.env.NEUROSQUAD_PINNED_MODEL).toBe('openrouter/qwen/qwen3-coder')
  })

  it('2.x: standalone with its own session id, model moved into config', () => {
    const plan = prepareLaunch(
      ctx(
        { harness: 'opencode', provider: 'openrouter', model: 'qwen/qwen3-coder' },
        { openRouterKey: 'sk-or-test' }
      ),
      { openCodeV2: true }
    )
    expect(plan.args[0]).toBe('--standalone')
    expect(plan.args[1]).toBe('--session')
    expect(plan.sessionId).toMatch(/^ses_ns/)
    expect(plan.args).not.toContain('--model')
    expect(JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT).model).toBe('openrouter/qwen/qwen3-coder')
    expect(plan.env.NEUROSQUAD_LIVE_DANGER).toBe('1')
  })
})

describe('command launch', () => {
  it('runs argv as is', () => {
    const plan = prepareLaunch(
      ctx({ harness: 'command', command: ['/bin/sh', '-c', 'echo hi'] }, { executable: '/bin/sh' })
    )
    expect(plan.command).toBe('/bin/sh')
    expect(plan.args).toEqual(['-c', 'echo hi'])
  })
})
