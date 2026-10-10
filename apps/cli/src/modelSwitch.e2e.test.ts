// A model change on a running agent really relaunches it with the new environment: the daemon
// with a stand-in `claude` on PATH that records how it was started (env, args), on OpenRouter.
// `nsq set --model` must end the old process and start a new one whose ANTHROPIC_MODEL is the
// new slug, resumed on the same session. Needs the built CLI (`npm run build`) and node-pty.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'nsq.js')
const built = existsSync(resolve(BIN, '..', '..', 'dist', 'bin.js'))
let work = ''
let home = ''
let spawnLog = ''
let env: NodeJS.ProcessEnv = {}

interface Spawned {
  pid: number
  args: string[]
  env: Record<string, string | undefined>
}

const nsq = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: work,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
const spawns = (): Spawned[] => {
  try {
    return readFileSync(spawnLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Spawned)
  } catch {
    return []
  }
}
async function until(check: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  return check()
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The stand-in Claude Code: records its start, then waits like an idle CLI. */
const FAKE_CLAUDE = `
const { appendFileSync } = require('node:fs')
const pick = {}
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)) pick[k] = k.includes('TOKEN') ? '<set>' : process.env[k]
appendFileSync(process.env.NSQ_TEST_SPAWN_LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), env: pick }) + '\\n')
console.log('fake claude ready')
setInterval(() => {}, 1000)
`

describe.skipIf(!built)('model switch relaunches with the new environment', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'nsq-switch-'))
    home = join(work, 'home')
    const bin = join(work, 'bin')
    mkdirSync(bin, { recursive: true })
    spawnLog = join(work, 'spawns.jsonl')
    const script = join(work, 'fake-claude.cjs')
    writeFileSync(script, FAKE_CLAUDE)
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`)
    } else {
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755
        }
      )
    }
    const base: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(NSQ_|CLAUDE|ANTHROPIC_|OPENROUTER_)/i.test(key)) base[key] = value
    }
    const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    env = {
      ...base,
      // Only the stand-in: folders with a real Claude Code are left out (never run it here).
      [pathKey]: [
        bin,
        ...(base[pathKey] ?? '')
          .split(delimiter)
          .filter(
            (dir) =>
              dir &&
              !['claude', 'claude.exe', 'claude.cmd'].some((name) => existsSync(join(dir, name)))
          )
      ].join(delimiter),
      NSQ_HOME: home,
      NSQ_NO_NOTIFY: '1',
      NSQ_RESTART_PAUSE_MS: '300',
      NSQ_TEST_SPAWN_LOG: spawnLog,
      // The key from the environment (an isolated nsq home has nothing in the keyring).
      OPENROUTER_API_KEY: 'sk-or-v1-nsq-switch-test-key'
    }
  })

  afterAll(() => {
    nsq('down')
    try {
      const state = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }
      process.kill(state.pid)
    } catch {
      // stopped
    }
    for (const spawned of spawns()) if (alive(spawned.pid)) process.kill(spawned.pid)
    rmSync(work, { recursive: true, force: true })
  })

  it('set --model on a running OpenRouter agent: a new process with the new slug, same session', async () => {
    const run = nsq(
      'run',
      'claude',
      '--name',
      'sw',
      '--provider',
      'openrouter',
      '--model',
      'stepfun/step-5-preview',
      'hello'
    )
    expect(run.status, run.stderr).toBe(0)
    expect(await until(() => spawns().length === 1)).toBe(true)
    const [first] = spawns()
    expect(first!.env['ANTHROPIC_MODEL']).toBe('stepfun/step-5-preview')
    expect(first!.env['ANTHROPIC_BASE_URL']).toBe('https://openrouter.ai/api')
    // Not a Claude model: the plain Messages shape.
    expect(first!.env['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS']).toBe('1')

    const set = nsq(
      'set',
      'sw',
      '--model',
      'deepseek/deepseek-v4.1-flash',
      '--provider',
      'openrouter'
    )
    expect(set.status, set.stderr).toBe(0)
    expect(await until(() => spawns().length === 2), set.stdout).toBe(true)
    const second = spawns()[1]!
    expect(second.pid).not.toBe(first!.pid)
    expect(second.env['ANTHROPIC_MODEL']).toBe('deepseek/deepseek-v4.1-flash')
    expect(second.env['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('deepseek/deepseek-v4.1-flash')
    expect(second.env['CLAUDE_CODE_SUBAGENT_MODEL']).toBe('deepseek/deepseek-v4.1-flash')
    // The same conversation: resumed on the agent's session.
    const agentId = first!.args[first!.args.indexOf('--session-id') + 1]
    expect(second.args).toContain('--resume')
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(agentId)
    expect(await until(() => !alive(first!.pid), 10_000)).toBe(true)

    // A Claude model on OpenRouter keeps Claude Code's full feature set.
    nsq('set', 'sw', '--model', 'anthropic/claude-sonnet-5.5', '--provider', 'openrouter')
    expect(await until(() => spawns().length === 3)).toBe(true)
    const third = spawns()[2]!
    expect(third.env['ANTHROPIC_MODEL']).toBe('anthropic/claude-sonnet-5.5')
    expect(third.env['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS']).toBeUndefined()
    expect(third.env['CLAUDE_CODE_MODEL_CAPABILITIES']).toBeUndefined()
  }, 120_000)
})
