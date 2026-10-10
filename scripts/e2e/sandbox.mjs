// An isolated environment for end-to-end runs: its own HOME, nsq home,
// Claude Code / Codex / OpenCode config folders (all pointed at the fake
// model), so a run never touches the real user's logins, keys or settings.
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FAKE_ANTHROPIC_KEY =
  'sk-ant-api03-nsq-e2e-fake-key-00000000000000000000000000000000000000'
export const FAKE_OPENAI_KEY = 'sk-nsq-e2e-fake-openai-key'
export const FAKE_OPENROUTER_KEY = 'sk-or-v1-nsq-e2e-fake-openrouter-key'

/** Variables of the outer environment that must not leak into the sandbox. */
const LEAKY = /^(CLAUDE|ANTHROPIC_|OPENAI_|OPENCODE_|OPENROUTER_|CODEX_|XDG_|NSQ_|AI_AGENT$)/i

/**
 * @param {string} work  scratch folder (created)
 * @param {string} fakeBase  `http://127.0.0.1:<port>` of scripts/e2e/fake-model.mjs
 * @param {{ binDirs?: string[], projectInHome?: string }} options  `binDirs`: folders with the
 *   harness CLIs, first on PATH. `projectInHome`: the project as this folder of the sandbox's
 *   HOME (screenshots: nsq and the agents' TUIs show it as `~/<name>`, no local path).
 */
export function makeSandbox(work, fakeBase, options = {}) {
  const home = join(work, 'home')
  const claudeDir = join(home, '.claude')
  const codexHome = join(home, '.codex')
  const config = join(home, '.config')
  // A plain folder name only: the project must stay inside the sandbox's HOME (its README is
  // written below).
  if (
    options.projectInHome !== undefined &&
    !/^(?!\.\.?$)[A-Za-z0-9._-]+$/.test(options.projectInHome)
  ) {
    throw new Error(`projectInHome must be a plain folder name, not ${options.projectInHome}`)
  }
  const project = options.projectInHome ? join(home, options.projectInHome) : join(work, 'project')
  for (const dir of [home, claudeDir, codexHome, join(config, 'opencode'), project])
    mkdirSync(dir, { recursive: true })
  writeFileSync(join(project, 'README.md'), '# nsq e2e project\n')

  // Claude Code: onboarding done, the fake key approved, no telemetry or updates.
  writeFileSync(
    join(claudeDir, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      customApiKeyResponses: { approved: [FAKE_ANTHROPIC_KEY.slice(-20)], rejected: [] },
      autoModeClassifierBillingNoticeAcknowledgedAt: Date.now()
    })
  )
  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
      permissions: { defaultMode: 'default', disableAutoMode: 'disable' }
    })
  )

  // Codex: the fake as the user's model provider; ask before anything not known-safe.
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      'model = "fake-model"',
      'model_provider = "fake"',
      'approval_policy = "on-request"',
      'sandbox_mode = "read-only"',
      'check_for_update_on_startup = false',
      '',
      '[model_providers.fake]',
      'name = "Fake"',
      `base_url = "${fakeBase}/v1"`,
      'env_key = "FAKE_OPENAI_KEY"',
      'wire_api = "responses"',
      ''
    ].join('\n')
  )

  // OpenCode: shell commands ask; the fake as an OpenAI-compatible provider.
  writeFileSync(
    join(config, 'opencode', 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      model: 'openrouter/fake-model',
      permission: { bash: 'ask' },
      provider: { openrouter: { options: { baseURL: `${fakeBase}/api/v1` } } },
      autoupdate: false,
      share: 'disabled'
    })
  )

  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!LEAKY.test(key)) env[key] = value
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  // The user's own CLI installs (e.g. ~/.local/bin) are left off PATH: only the sandbox's.
  const userBins = [
    join(process.env.USERPROFILE ?? process.env.HOME ?? '~', '.local', 'bin').toLowerCase()
  ]
  const kept = String(env[pathKey] ?? '')
    .split(delimiter)
    .filter(
      (dir) =>
        dir &&
        !userBins.includes(dir.toLowerCase().replace(/[\\/]+$/, '')) &&
        !/[\\/]npm$/i.test(dir)
    )
  env[pathKey] = [...(options.binDirs ?? []), ...kept].join(delimiter)
  const set = {
    HOME: home,
    USERPROFILE: home,
    NSQ_HOME: join(work, 'nsq'),
    NSQ_NO_NOTIFY: process.env.NSQ_E2E_NOTIFY === '1' ? '0' : '1',
    CLAUDE_CONFIG_DIR: claudeDir,
    ANTHROPIC_BASE_URL: fakeBase,
    ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
    CODEX_HOME: codexHome,
    FAKE_OPENAI_KEY,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_MODELS_PATH: join(HERE, 'opencode-models.json'),
    OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
    NSQ_OPENROUTER_BASE_URL: `${fakeBase}/api/v1`,
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1'
  }
  Object.assign(env, set)
  return { env, set, home, project, claudeDir, codexHome }
}
