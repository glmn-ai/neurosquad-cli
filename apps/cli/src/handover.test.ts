import { describe, expect, it } from 'vitest'
import { busyAgents, daemonIsOlder, waitingText } from './client/handover.js'
import type { AgentView } from './protocol.js'

const agent = (name: string, extra: Partial<AgentView>): AgentView =>
  ({ id: name, name, harness: 'claude-code', running: true, ...extra }) as AgentView

describe('hand-over of an older daemon', () => {
  it('only a released, older daemon is handed over', () => {
    expect(daemonIsOlder('0.2.0', '0.2.1')).toBe(true)
    expect(daemonIsOlder('0.1.2', '0.2.1')).toBe(true)
    expect(daemonIsOlder('0.2.1', '0.2.1')).toBe(false)
    expect(daemonIsOlder('0.2.2', '0.2.1')).toBe(false)
    expect(daemonIsOlder('', '0.2.1')).toBe(false)
    expect(daemonIsOlder('0.0.0', '0.2.1')).toBe(false)
    expect(daemonIsOlder('0.2.0', '0.0.0')).toBe(false)
  })

  it('busy: working, needs you, or prompts queued — while running', () => {
    expect(
      busyAgents([
        agent('a', { status: 'working' }),
        agent('b', { status: 'needs-input' }),
        agent('c', { status: 'finished', queued: 1 }),
        agent('d', { status: 'finished' }),
        agent('e', { status: 'working', running: false })
      ])
    ).toEqual(['a', 'b', 'c'])
  })

  it('says who it waits for and how to do it now', () => {
    const text = waitingText({
      kind: 'waiting',
      from: '0.2.0',
      busy: ['a is working'],
      byDaemon: true
    })
    expect(text).toMatch(
      /the daemon is 0\.2\.0, this nsq is .* — it restarts on it when they are free \(a is working; nsq down && nsq up restarts it now\)/
    )
  })
})
