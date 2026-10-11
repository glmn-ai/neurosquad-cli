import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandRun, isKnownCli, recognizeCli } from './knownClis.js'

describe('recognizeCli', () => {
  it('knows the three CLIs by name, path or Windows shim', () => {
    expect(isKnownCli('claude')).toBe(true)
    expect(isKnownCli('/usr/local/bin/codex')).toBe(true)
    expect(isKnownCli('C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd')).toBe(true)
    expect(isKnownCli('claude.exe')).toBe(true)
    expect(isKnownCli('npm')).toBe(false)
    expect(isKnownCli('claude-helper')).toBe(false)
    expect(recognizeCli(['npm', 'run', 'dev'])).toBeNull()
  })

  it('Claude Code: the prompt, the model and dangerous mode out, the rest through', () => {
    expect(
      recognizeCli([
        'claude',
        '--effort',
        'high',
        '--model=opus',
        '--dangerously-skip-permissions',
        '--add-dir',
        '../lib',
        '../docs',
        '--verbose',
        'fix the failing tests'
      ])
    ).toEqual({
      // `--add-dir` takes every value up to the next option, as Claude Code's parser does.
      launch: {
        harness: 'claude-code',
        args: ['--effort', 'high', '--add-dir', '../lib', '../docs', '--verbose'],
        prompt: 'fix the failing tests',
        model: 'opus',
        dangerousMode: true
      }
    })
    expect(recognizeCli(['claude'])).toEqual({ launch: { harness: 'claude-code', args: [] } })
    // An option value is not the prompt.
    expect(recognizeCli(['claude', '--permission-mode', 'plan'])).toEqual({
      launch: { harness: 'claude-code', args: ['--permission-mode', 'plan'] }
    })
    // `--` ends the options: what follows is the prompt even if it looks like one.
    expect(recognizeCli(['claude', '--', '--help me'])).toMatchObject({
      launch: { prompt: '--help me' }
    })
  })

  it('Claude Code: session flags and flags that would switch off its hooks are refused', () => {
    for (const flag of ['--resume', '-r', '-c', '--continue', '--session-id', '--fork-session']) {
      const result = recognizeCli(['claude', flag, 'x'])
      expect(result, flag).toHaveProperty('refused')
      expect((result as { refused: string }).refused).toMatch(/--raw/)
    }
    expect(recognizeCli(['claude', '--settings', 'my.json'])).toHaveProperty('refused')
    expect(recognizeCli(['claude', '--bare'])).toHaveProperty('refused')
    expect(recognizeCli(['claude', 'two', 'prompts'])).toHaveProperty('refused')
  })

  it('one-shot runs and subcommands stay plain commands', () => {
    expect(recognizeCli(['claude', '-p', 'hi'])).toEqual({ plain: 'claude -p' })
    expect(recognizeCli(['claude', '--version'])).toEqual({ plain: 'claude --version' })
    expect(recognizeCli(['claude', 'mcp', 'list'])).toEqual({ plain: 'claude mcp' })
    expect(recognizeCli(['codex', 'exec', 'do it'])).toEqual({ plain: 'codex exec' })
    expect(recognizeCli(['codex', '-m', 'o3', 'exec', 'x'])).toEqual({ plain: 'codex exec' })
    expect(recognizeCli(['opencode', 'run', 'hello'])).toEqual({ plain: 'opencode run' })
    expect(recognizeCli(['opencode', '--help'])).toEqual({ plain: 'opencode --help' })
  })

  it('Codex: -m, the bypass flag and the prompt; resume and fork are nsq’s', () => {
    expect(
      recognizeCli([
        'codex',
        '-m',
        'gpt-5.5',
        '-c',
        'model_reasoning_effort="high"',
        '--yolo',
        '--search',
        'review the diff'
      ])
    ).toEqual({
      launch: {
        harness: 'codex-cli',
        args: ['-c', 'model_reasoning_effort="high"', '--search'],
        prompt: 'review the diff',
        model: 'gpt-5.5',
        dangerousMode: true
      }
    })
    expect(recognizeCli(['codex', 'resume', '--last'])).toHaveProperty('refused')
    expect(recognizeCli(['codex', 'fork'])).toHaveProperty('refused')
    // `-i` takes files up to the next option, as clap does.
    expect(recognizeCli(['codex', '-i', 'a.png', 'b.png', '--search'])).toEqual({
      launch: { harness: 'codex-cli', args: ['-i', 'a.png', 'b.png', '--search'] }
    })
  })

  it('OpenCode: --prompt is the prompt, [project] the folder, --auto dangerous mode', () => {
    expect(
      recognizeCli([
        'opencode',
        '../site',
        '--model',
        'openai/gpt-5.5',
        '--prompt',
        'add a footer',
        '--agent',
        'build',
        '--auto'
      ])
    ).toEqual({
      launch: {
        harness: 'opencode',
        args: ['--agent', 'build'],
        prompt: 'add a footer',
        model: 'openai/gpt-5.5',
        dangerousMode: true,
        project: '../site'
      }
    })
    expect(recognizeCli(['opencode', '--session', 'ses_1'])).toHaveProperty('refused')
    expect(recognizeCli(['opencode', '-c'])).toHaveProperty('refused')
    expect(recognizeCli(['opencode', '--pure'])).toHaveProperty('refused')
  })
})

describe('commandRun (nsq run -- …)', () => {
  const cwd = resolve('/work/app')
  const base = { cwd, cols: 100, rows: 30 }

  it('a known CLI runs as its harness, its own flags through', () => {
    expect(commandRun(['claude', '--effort', 'high', 'hi there'], base, false)).toEqual({
      spec: { ...base, harness: 'claude-code', prompt: 'hi there', args: ['--effort', 'high'] }
    })
  })

  it('--raw keeps the old plain command', () => {
    expect(commandRun(['claude', '--resume', 'x'], base, true)).toEqual({
      spec: { ...base, harness: 'command', command: ['claude', '--resume', 'x'] }
    })
  })

  it('anything else is a plain command; nsq’s provider flag applies to harnesses only', () => {
    expect(
      commandRun(['npm', 'run', 'dev'], { ...base, provider: 'openrouter', model: 'm' }, false)
    ).toEqual({ spec: { ...base, model: 'm', harness: 'command', command: ['npm', 'run', 'dev'] } })
    expect(
      commandRun(['codex', '--help'], { ...base, provider: 'openrouter' }, false)
    ).toMatchObject({ spec: { harness: 'command' }, note: expect.stringMatching(/plain command/) })
  })

  it('nsq’s flags and the CLI’s agree, or it is a usage error', () => {
    expect(commandRun(['codex', '-m', 'a'], { ...base, model: 'a' }, false)).toMatchObject({
      spec: { harness: 'codex-cli', model: 'a' }
    })
    expect(commandRun(['codex', '-m', 'a'], { ...base, model: 'b' }, false)).toHaveProperty('error')
    expect(commandRun(['claude', '--dangerously-skip-permissions'], base, false)).toMatchObject({
      spec: { dangerousMode: true }
    })
    expect(commandRun(['claude', '-c'], base, false)).toHaveProperty('error')
  })

  it('a CLI named by its path runs that binary; OpenCode’s [project] becomes the folder', () => {
    expect(commandRun(['./bin/codex'], base, false)).toEqual({
      spec: { ...base, harness: 'codex-cli', binary: resolve(cwd, 'bin/codex') }
    })
    expect(commandRun(['.\\bin\\codex.exe'], base, false)).toMatchObject({
      spec: { harness: 'codex-cli', binary: resolve(cwd, '.\\bin\\codex.exe') }
    })
    expect(commandRun(['opencode', '../site'], base, false)).toEqual({
      spec: { ...base, harness: 'opencode', cwd: resolve(cwd, '../site') }
    })
  })
})
