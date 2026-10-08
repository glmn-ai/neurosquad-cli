// Subagents inside a card (docs/subagents.md): the parent stays working while
// any runs, a subagent's stop is never the parent's Stop, a subagent's
// question surfaces on the card.
import { describe, expect, it } from 'vitest'
import type { TranscriptView } from './claudeTranscript.js'
import {
  SUBAGENT_MAX_HOLD_MS,
  SUBAGENT_SETTLE_MS,
  settleDue,
  step,
  type MachineState,
  type Publish,
  type StatusSignal,
  type SubagentRun
} from './machine.js'

function play(
  signals: [number, StatusSignal][],
  start: MachineState = {}
): { published: (Publish & { at: number })[]; state: MachineState } {
  let state = start
  const published: (Publish & { at: number })[] = []
  for (const [at, signal] of signals) {
    const result = step(state, signal, at)
    state = result.state
    if (result.publish) published.push({ ...result.publish, at })
  }
  return { published, state }
}

const hook = (
  kind: 'working' | 'needs-input' | 'finished',
  detail?: string,
  resumeOnly?: boolean
): StatusSignal => ({
  type: 'hook',
  kind,
  ...(detail ? { detail } : {}),
  ...(resumeOnly ? { resumeOnly } : {})
})
const runs = (...list: [string, number][]): StatusSignal => ({
  type: 'subagents',
  running: list.map(([id, since]): SubagentRun => ({ id, since, name: 'general-purpose' }))
})
const settle: StatusSignal = { type: 'settle' }
const kinds = (published: Publish[]): string[] => published.map((p) => `${p.kind}:${p.origin}`)
const view = (partial: Partial<TranscriptView>): TranscriptView => ({
  phase: 'unknown',
  at: 0,
  queued: 0,
  ...partial
})

describe('subagents: the parent stays working while they run', () => {
  it('two parallel foreground subagents: their stops are not the parent Stop', () => {
    const { published, state } = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['a', 1000])],
      [1100, runs(['a', 1000], ['b', 1100])],
      // A subagent's own tool call (PostToolUse) only resumes a waiting card.
      [1500, hook('working', undefined, true)],
      [3000, runs(['b', 1100])],
      [4000, runs()],
      [6000, hook('finished')]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
    expect(published[1].at).toBe(6000)
    expect(state.subagents).toBeUndefined()
    expect(state.held).toBeUndefined()
  })

  it('the parent Stop while background subagents run is held until they are done and settled', () => {
    const start = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['bg', 1000])],
      [2000, hook('finished', 'done for now')]
    ])
    expect(kinds(start.published)).toEqual(['working:hook'])
    expect(start.state.kind).toBe('working')
    expect(start.state.held).toEqual({ at: 2000, detail: 'done for now' })
    // Still running: no tick finishes it.
    expect(step(start.state, settle, 2000 + SUBAGENT_SETTLE_MS * 10).publish).toBeNull()

    const stopped = step(start.state, runs(), 10_000)
    expect(stopped.publish).toBeNull()
    expect(stopped.state.held?.settleFrom).toBe(10_000)
    expect(settleDue(stopped.state)).toBe(10_000 + SUBAGENT_SETTLE_MS)
    // Too early.
    expect(step(stopped.state, settle, 10_500).publish).toBeNull()
    const done = step(stopped.state, settle, 10_000 + SUBAGENT_SETTLE_MS)
    expect(done.publish).toMatchObject({ kind: 'finished', origin: 'hook', detail: 'done for now' })
    expect(done.state.held).toBeUndefined()
  })

  it("a background subagent's result starting a turn of the parent's own: one finished, at its end", () => {
    const { published } = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['bg', 1000])],
      [2000, hook('finished')],
      [9000, runs()],
      // Claude Code's <task-notification> turn: UserPromptSubmit, then Stop.
      [9200, hook('working')],
      [9300, settle],
      [9000 + SUBAGENT_SETTLE_MS + 10, settle],
      [12_500, hook('finished')]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
    expect(published[1].at).toBe(12_500)
  })

  it("the transcript's turn end is held the same way", () => {
    const start = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['bg', 1000])],
      [2000, { type: 'transcript', view: view({ phase: 'ended', at: 1900, turnStartedAt: 100 }) }],
      [3000, { type: 'transcript', view: view({ phase: 'ended', at: 1900, turnStartedAt: 100 }) }]
    ])
    expect(kinds(start.published)).toEqual(['working:hook'])
    expect(start.state.held?.at).toBe(2000)
    // The task-notification turn shows in the transcript: the hold is over.
    const next = step(
      start.state,
      { type: 'transcript', view: view({ phase: 'busy', at: 5000, turnStartedAt: 5000 }) },
      5100
    )
    expect(next.publish).toBeNull()
    expect(next.state.held).toBeUndefined()
    expect(next.state.subagents).toHaveLength(1)
  })

  it("a subagent's permission prompt surfaces on the card; answering it keeps the hold", () => {
    const { published, state } = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['bg', 1000])],
      [2000, hook('finished')],
      [3000, hook('needs-input', 'Subagent general-purpose: Claude wants to run: ls')],
      [4000, { type: 'input', data: '1' }],
      [4500, hook('working', undefined, true)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'working:user'])
    expect(published[1].detail).toContain('Subagent general-purpose')
    expect(state.kind).toBe('working')
    expect(state.held?.at).toBe(2000)
    // …and the card finishes once the subagent is done.
    const done = play(
      [
        [8000, runs()],
        [8000 + SUBAGENT_SETTLE_MS, settle]
      ],
      state
    )
    expect(kinds(done.published)).toEqual(['finished:hook'])
  })

  it('an API error ends the turn at once, subagents or not', () => {
    const { published } = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['a', 1000])],
      [
        2000,
        {
          type: 'transcript',
          view: view({ phase: 'error', at: 1900, errorKind: 'rate_limit', turnStartedAt: 100 })
        }
      ]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:transcript'])
    expect(published[1].error).toBe(true)
  })

  it('an interrupt (Escape) ends the hold: idle, the subagents still listed', () => {
    const start = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['bg', 1000])],
      [2000, hook('finished')],
      [3000, { type: 'transcript', view: view({ phase: 'interrupted', at: 2900 }) }]
    ])
    expect(kinds(start.published)).toEqual(['working:hook', 'idle:transcript'])
    expect(start.state.held).toBeUndefined()
    expect(start.state.subagents).toHaveLength(1)
  })

  it('a hold whose subagents never report a stop still ends', () => {
    const start = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['lost', 1000])],
      [2000, hook('finished')]
    ])
    expect(settleDue(start.state)).toBe(2000 + SUBAGENT_MAX_HOLD_MS)
    const done = step(start.state, settle, 2000 + SUBAGENT_MAX_HOLD_MS)
    expect(done.publish?.kind).toBe('finished')
    expect(done.state.subagents).toBeUndefined()
  })

  it('a subagent that starts after the card finished makes it working; its end finishes it again', () => {
    const { published } = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, hook('finished')],
      [5000, runs(['late', 5000])],
      [6000, hook('finished')],
      [7000, runs()],
      [7000 + SUBAGENT_SETTLE_MS, settle]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'finished:hook',
      'working:hook',
      'finished:hook'
    ])
  })

  it('a subagent already listed before the card finished does not restart it', () => {
    const { published } = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [500, runs(['a', 500])],
      [800, runs()],
      [1000, hook('finished')],
      // A late report of the same old run.
      [2000, runs(['a', 500])]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
  })

  it('a new process forgets the subagents and the hold', () => {
    const { state } = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['bg', 1000])],
      [2000, hook('finished')],
      [3000, { type: 'exit' }],
      [4000, { type: 'spawn' }]
    ])
    expect(state.subagents).toBeUndefined()
    expect(state.held).toBeUndefined()
    expect(settleDue(state)).toBeNull()
  })

  it('a prompt the person submits while the turn end is held starts a turn of its own', () => {
    const { state } = play([
      [0, { type: 'spawn' }],
      [100, hook('working')],
      [1000, runs(['bg', 1000])],
      [2000, hook('finished')],
      [3000, { type: 'input', data: '\r' }]
    ])
    expect(state.held).toBeUndefined()
    expect(state.kind).toBe('working')
  })
})
