import { describe, expect, it } from 'vitest'
import { mayLeaveDraft, submitsInput } from './input.js'
import { isInheritedSessionEnvKey } from './inheritedEnv.js'

describe('submitsInput', () => {
  it('an Enter submits', () => {
    expect(submitsInput('\r')).toBe(true)
    expect(submitsInput('hello\r')).toBe(true)
  })
  it('line breaks inside a bracketed paste do not', () => {
    expect(submitsInput('\x1b[200~line one\nline two\r\nthree\x1b[201~')).toBe(false)
    expect(submitsInput('\x1b[200~unclosed\npaste')).toBe(false)
  })
  it('an Enter after the paste does', () => {
    expect(submitsInput('\x1b[200~a\nb\x1b[201~\r')).toBe(true)
  })
  it('plain text and terminal replies do not', () => {
    expect(submitsInput('abc')).toBe(false)
    expect(submitsInput('\x1b[?1;2c')).toBe(false)
  })
})

describe('mayLeaveDraft', () => {
  it('typed and pasted text, Backspace and interrupt keys may', () => {
    expect(mayLeaveDraft('a')).toBe(true)
    expect(mayLeaveDraft('\x1b[200~pasted\x1b[201~')).toBe(true)
    expect(mayLeaveDraft('\x7f')).toBe(true)
    expect(mayLeaveDraft('\x1b')).toBe(true)
    expect(mayLeaveDraft('\x03')).toBe(true)
  })
  it('terminal replies, focus and cursor keys do not', () => {
    expect(mayLeaveDraft('\x1b[?1;2c')).toBe(false)
    expect(mayLeaveDraft('\x1b[12;40R')).toBe(false)
    expect(mayLeaveDraft('\x1b[I')).toBe(false)
    expect(mayLeaveDraft('\x1b]11;rgb:0000/0000/0000\x07')).toBe(false)
    expect(mayLeaveDraft('\x1b[A')).toBe(false)
  })
})

describe('isInheritedSessionEnvKey', () => {
  it("strips the parent Claude Code session's markers", () => {
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SSE_PORT',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'AI_AGENT',
      'ClaudeCode'
    ]) {
      expect(isInheritedSessionEnvKey(key)).toBe(true)
    }
  })
  it("keeps the user's Claude Code configuration", () => {
    for (const key of [
      'CLAUDE_CODE_GIT_BASH_PATH',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'CLAUDE_CONFIG_DIR',
      'ANTHROPIC_API_KEY'
    ]) {
      expect(isInheritedSessionEnvKey(key)).toBe(false)
    }
  })
})
