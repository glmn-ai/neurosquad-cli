import { describe, expect, it } from 'vitest'
import { detectTerminalProtocol, formatTerminalSignal } from './terminal.js'
import { cleanText, isValidAppId, notificationKey, oneLine } from './text.js'

const signal = { key: 'agent-1', title: 'Claude needs you', body: 'Allow Bash?', bell: false }

describe('detectTerminalProtocol', () => {
  it.each([
    [{ TERM_PROGRAM: 'iTerm.app' }, 'osc9'],
    [{ TERM_PROGRAM: 'WezTerm' }, 'osc9'],
    [{ TERM_PROGRAM: 'ghostty' }, 'osc9'],
    [{ TERM: 'xterm-ghostty' }, 'osc9'],
    [{ TERM: 'xterm-kitty' }, 'osc99'],
    [{ KITTY_WINDOW_ID: '1', TERM: 'xterm-256color' }, 'osc99'],
    [{ TERM: 'foot' }, 'osc777'],
    [{ TERM: 'rxvt-unicode-256color' }, 'osc777'],
    [{ TERM_PROGRAM: 'vscode' }, 'bell'],
    [{ WT_SESSION: 'x' }, 'bell'],
    [{ ConEmuPID: '1', TERM_PROGRAM: 'WezTerm' }, 'bell'],
    [{ STY: '1.pts', TERM_PROGRAM: 'iTerm.app' }, 'bell'],
    [{ STY: '1.pts', TMUX: '/tmp/x', TERM_PROGRAM: 'iTerm.app' }, 'osc9'],
    [{}, 'bell']
  ] as const)('%o -> %s', (env, expected) => {
    expect(detectTerminalProtocol(env)).toBe(expected)
  })
})

describe('formatTerminalSignal', () => {
  it('OSC 9 carries title and body; a leading digit cannot become a sub-command', () => {
    expect(formatTerminalSignal('osc9', signal)).toBe('\x1b]9;Claude needs you: Allow Bash?\x07')
    expect(formatTerminalSignal('osc9', { ...signal, title: '4;3;100' })).toBe(
      '\x1b]9;nsq: 4;3;100: Allow Bash?\x07'
    )
  })

  it('OSC 777 keeps the title free of separators', () => {
    expect(formatTerminalSignal('osc777', { ...signal, title: 'a;b' })).toBe(
      '\x1b]777;notify;a,b;Allow Bash?\x07'
    )
  })

  it('OSC 99 sends title then body under one id', () => {
    expect(formatTerminalSignal('osc99', { ...signal, key: 'a/b' })).toBe(
      '\x1b]99;i=a-b:d=0;Claude needs you\x1b\\\x1b]99;i=a-b:d=1:p=body;Allow Bash?\x1b\\'
    )
  })

  it('bell: only BEL, and only when asked', () => {
    expect(formatTerminalSignal('bell', signal)).toBe('')
    expect(formatTerminalSignal('bell', { ...signal, bell: true })).toBe('\x07')
    expect(formatTerminalSignal('osc9', { ...signal, bell: true })).toBe(
      '\x1b]9;Claude needs you: Allow Bash?\x07\x07'
    )
  })

  it('wraps for tmux passthrough, doubling inner ESC', () => {
    expect(formatTerminalSignal('osc99', { ...signal, body: '' }, { TMUX: '/tmp/t' })).toBe(
      '\x1bPtmux;\x1b\x1b]99;i=agent-1;Claude needs you\x1b\x1b\\\x1b\\'
    )
  })

  it('strips control characters so text cannot end the sequence early', () => {
    const out = formatTerminalSignal('osc9', {
      ...signal,
      title: 'x\x07\x1b]0;pwned',
      body: 'a\nb'
    })
    expect(out).toBe('\x1b]9;x]0;pwned: a b\x07')
  })
})

describe('text helpers', () => {
  it('validates app ids', () => {
    expect(isValidAppId('ai.neurosquad.cli')).toBe(true)
    expect(isValidAppId('NeuroSquad_CLI-2')).toBe(true)
    expect(isValidAppId('')).toBe(false)
    expect(isValidAppId('a b')).toBe(false)
    expect(isValidAppId('a\\b')).toBe(false)
    expect(isValidAppId('.hidden')).toBe(false)
  })

  it('keys: plain ids pass through, others hash stably', () => {
    expect(notificationKey('agent-1.x_y')).toBe('agent-1.x_y')
    expect(notificationKey('a b')).toMatch(/^h[0-9a-f]{40}$/)
    expect(notificationKey('a b')).toBe(notificationKey('a b'))
    expect(notificationKey('x'.repeat(65))).toMatch(/^h[0-9a-f]{40}$/)
  })

  it('cleans and truncates', () => {
    expect(cleanText('a\u0000b\u009bc\nd\te')).toBe('abc\nd\te')
    expect(cleanText('abcdef', 4)).toBe('abc…')
    expect(oneLine('  a \r\n b\tc  ')).toBe('a b c')
  })
})
