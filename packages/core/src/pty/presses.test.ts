import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { interruptKeys } from '../harnesses/types.js'
import { KEY_PRESS_GAP_MS, sendPresses } from './presses.js'

describe('sendPresses', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends each press as its own write, a gap apart', () => {
    const writes: string[] = []
    sendPresses(
      ['\x1b', '\x1b'],
      (data) => writes.push(data),
      () => true
    )
    expect(writes).toEqual(['\x1b'])
    vi.advanceTimersByTime(KEY_PRESS_GAP_MS - 1)
    expect(writes).toEqual(['\x1b'])
    vi.advanceTimersByTime(1)
    expect(writes).toEqual(['\x1b', '\x1b'])
  })

  it('stops when the agent is gone before the next press', () => {
    const writes: string[] = []
    let alive = true
    sendPresses(
      ['a', 'b', 'c'],
      (data) => writes.push(data),
      () => alive,
      100
    )
    vi.advanceTimersByTime(100)
    alive = false
    vi.advanceTimersByTime(500)
    expect(writes).toEqual(['a', 'b'])
  })

  it('stops after a write that throws', () => {
    const writes: string[] = []
    sendPresses(
      ['a', 'b'],
      (data) => {
        writes.push(data)
        throw new Error('closed')
      },
      () => true
    )
    vi.advanceTimersByTime(1000)
    expect(writes).toEqual(['a'])
  })
})

describe('interruptKeys', () => {
  it('gives OpenCode two separate Escapes (one write of both is read as one key)', () => {
    expect(interruptKeys('opencode')).toEqual(['\x1b', '\x1b'])
  })
  it('one Escape for Claude Code and Codex, Ctrl+C for a plain command', () => {
    expect(interruptKeys('claude-code')).toEqual(['\x1b'])
    expect(interruptKeys('codex-cli')).toEqual(['\x1b'])
    expect(interruptKeys('command')).toEqual(['\x03'])
  })
})
