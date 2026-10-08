import { describe, expect, it } from 'vitest'
import type { TranscriptView } from './claudeTranscript.js'
import {
  ANSWERED_SETTLE_MS,
  classifyUserKey,
  DISMISS_GRACE_MS,
  QUEUED_SETTLE_MS,
  step,
  type MachineState,
  type Publish,
  type StatusSignal
} from './machine.js'

/** Plays a sequence of [ms offset, signal]; returns every publish and the final state. */
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
const input = (data: string): StatusSignal => ({ type: 'input', data })
const kinds = (published: Publish[]): string[] =>
  published.map((p) => `${p.kind}:${p.origin}${p.quiet ? ':quiet' : ''}`)

describe('classifyUserKey', () => {
  it('reads Enter, option digits and y/n/a as answers', () => {
    for (const key of ['\r', '1', '2', '9', 'y', 'Y', 'n', 'a']) {
      expect(classifyUserKey(key)).toBe('answer')
    }
  })
  it('reads a bare Escape, a double Escape and Ctrl+C as a dismissal', () => {
    expect(classifyUserKey('\x1b')).toBe('dismiss')
    expect(classifyUserKey('\x1b\x1b')).toBe('dismiss')
    expect(classifyUserKey('\x03')).toBe('dismiss')
  })
  it('ignores terminal auto-replies, arrows, focus reports, mouse and typed words', () => {
    for (const data of [
      '\x1b[12;1R', // cursor position report
      '\x1b[?1;2c', // device attributes
      '\x1b[I', // focus in
      '\x1b[O',
      '\x1b]11;rgb:1c1c/1c1c/1f1f\x1b\\', // OSC colour answer
      '\x1b[A', // arrow up
      '\x1b[B',
      '\t',
      '\x1b[<0;10;5M', // SGR mouse
      'hello',
      '0',
      'x'
    ]) {
      expect(classifyUserKey(data)).toBeNull()
    }
  })
  it('never reads pasted text as a key, newline or not', () => {
    expect(classifyUserKey('\x1b[200~first line\rsecond\x1b[201~')).toBeNull()
    expect(classifyUserKey('\x1b[200~1\x1b[201~')).toBeNull()
    // …but an Enter typed after the paste is one.
    expect(classifyUserKey('\x1b[200~text\x1b[201~\r')).toBe('answer')
  })
})

describe('Claude Code (measured sequences, 2.1.286)', () => {
  it('permission prompt answered in the terminal: working at the keystroke, confirmed by PostToolUse', () => {
    const { published, state } = play([
      [0, { type: 'spawn' }],
      [1000, hook('working')], // UserPromptSubmit
      [7000, hook('needs-input', 'Claude wants to run: touch a.txt')], // Notification permission_prompt
      [9000, input('\r')], // the person picks "Yes"
      [10300, hook('working', undefined, true)], // PostToolUse
      [10500, hook('finished')] // Stop
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'needs-input:hook',
      'working:user',
      'finished:hook'
    ])
    expect(published[2].at).toBe(9000)
    expect(state).toEqual({ kind: 'finished', since: 10500 })
  })

  it('a digit picks the option at once (no Enter) — also working', () => {
    const { published } = play([
      [0, { type: 'spawn' }],
      [0, hook('working')],
      [6000, hook('needs-input')],
      [7000, input('1')]
    ])
    expect(kinds(published).at(-1)).toBe('working:user')
  })

  it('Escape on the prompt: no hook ever follows (turn interrupted) — idle at once, no Stop later', () => {
    const { published, state } = play([
      [0, { type: 'spawn' }],
      [0, hook('working')],
      [6000, hook('needs-input')],
      [8000, input('\x1b')]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'idle:user'])
    expect(state.kind).toBe('idle')
  })

  it('"No" picked by digit: optimistic working, then the quiet prompt settles it as idle', () => {
    const { published, state } = play([
      [0, { type: 'spawn' }],
      [0, hook('working')],
      [6000, hook('needs-input')],
      [7000, input('3')],
      [10000, { type: 'quiet' }]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'needs-input:hook',
      'working:user',
      'idle:user'
    ])
    expect(state).toEqual({ kind: 'idle', since: 10000 })
  })

  it('a confirmed answer is never undone by a late quiet check', () => {
    const { published } = play([
      [0, hook('working')],
      [6000, hook('needs-input')],
      [7000, input('\r')],
      [8000, hook('working', undefined, true)], // PostToolUse confirms
      [11000, { type: 'quiet' }]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'working:user'])
  })

  it('the 60-second idle nudge is not a question (classified away before the machine) — finished stays finished', () => {
    const { published, state } = play([
      [0, hook('working')],
      [2000, hook('finished')],
      // Stop repeated (a resumed session re-reporting) is not a second "finished!"
      [3000, hook('finished')]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
    expect(state.kind).toBe('finished')
  })

  it('a repeated needs-input does not ring twice; new wording is passed on quietly', () => {
    const { published } = play([
      [0, hook('working')],
      [100, hook('needs-input', 'Claude wants to run: ls')],
      [200, hook('needs-input', 'Claude wants to run: ls')],
      [6000, hook('needs-input', 'Claude needs your permission')]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'needs-input:hook:quiet'])
  })

  it('Escape while working (an interrupt — Claude sends no Stop) → idle once the output stops', () => {
    const { published } = play([
      [0, hook('working')],
      [4000, input('\x1b')],
      [7000, { type: 'quiet' }]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'idle:user'])
  })

  it('Escape while working that was not an interrupt (output went on, then a hook came) changes nothing', () => {
    const { published, state } = play([
      [0, hook('working')],
      [4000, input('\x1b')],
      [5000, hook('working', undefined, true)],
      [9000, { type: 'quiet' }],
      [12000, hook('finished')]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
    expect(state.kind).toBe('finished')
  })

  it('PostToolUse never turns a finished agent back into a working one (background subagent tool after Stop)', () => {
    const { published } = play([
      [0, hook('working')],
      [1000, hook('finished')],
      [2000, hook('working', undefined, true)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
  })

  it('an AskUserQuestion answered, then a second question', () => {
    const { published } = play([
      [0, hook('working')],
      [6000, hook('needs-input', 'Claude is asking: Which color?')],
      [7000, input('2')],
      [7100, hook('working', undefined, true)],
      [7300, hook('needs-input', 'Claude is asking: Which size?')],
      [8000, input('\r')],
      [8200, hook('working', undefined, true)],
      [8400, hook('finished')]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'needs-input:hook',
      'working:user',
      'needs-input:hook',
      'working:user',
      'finished:hook'
    ])
  })

  it('typing words into the waiting prompt is not an answer yet; the Enter is', () => {
    const { published } = play([
      [0, hook('working')],
      [100, hook('needs-input')],
      [200, input('tell it to use pnpm')],
      [300, input('\x1b[D')]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook'])
  })
})

describe('restart and exit', () => {
  it('a restart clears a stale needs-input (published as a reset)', () => {
    const { published, state } = play([
      [0, hook('working')],
      [100, hook('needs-input')],
      [200, { type: 'exit' }],
      [1000, { type: 'spawn' }]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'idle:reset'])
    expect(state).toEqual({ kind: 'idle', since: 1000 })
  })

  it('facts between exit and the next spawn are stale — dropped', () => {
    const { published } = play([
      [0, hook('working')],
      [100, { type: 'exit' }],
      [150, hook('needs-input')], // the dying process's last curl
      [160, input('\r')]
    ])
    expect(kinds(published)).toEqual(['working:hook'])
  })

  it('the first spawn publishes nothing', () => {
    expect(play([[0, { type: 'spawn' }]]).published).toEqual([])
  })

  it('a hookless agent ignores keys (the inferred detector owns it)', () => {
    const { published } = play([
      [0, { type: 'spawn' }],
      [100, input('\r')],
      [200, input('\x1b')],
      [5000, { type: 'quiet' }]
    ])
    expect(published).toEqual([])
  })
})

describe('other harnesses', () => {
  it('Codex: PermissionRequest → the "y" shortcut → working; its own PostToolUse confirms', () => {
    const { published } = play([
      [0, hook('working')], // UserPromptSubmit
      [500, hook('needs-input', 'Codex wants to run: rm -rf build')],
      [2000, input('y')],
      [2500, hook('finished')] // Stop
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'needs-input:hook',
      'working:user',
      'finished:hook'
    ])
  })

  it('OpenCode: permission asked, answered by Enter; the plugin\'s own "answered" confirms without a second event', () => {
    const { published } = play([
      [0, hook('working')],
      [700, hook('needs-input', 'OpenCode needs permission: bash')],
      [1500, input('\r')],
      [1600, hook('working')], // permission.replied → answered
      [5000, { type: 'quiet' }], // late check: confirmed, ignored
      [9000, hook('finished')]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'needs-input:hook',
      'working:user',
      'finished:hook'
    ])
  })

  it('Qwen: a denied permission sends no PostToolUse — Escape leaves it idle, a Stop right after adds nothing', () => {
    const { published, state } = play([
      [0, hook('working')],
      [500, hook('needs-input')],
      [1500, input('\x1b')],
      [1500 + DISMISS_GRACE_MS - 1, hook('finished')]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'idle:user'])
    expect(state.kind).toBe('idle')
  })

  it('a Stop long after a dismissal is a real turn end', () => {
    const { published } = play([
      [0, hook('working')],
      [500, hook('needs-input')],
      [1500, input('\x1b')],
      [1500 + DISMISS_GRACE_MS + 1, hook('finished')]
    ])
    expect(kinds(published).at(-1)).toBe('finished:hook')
  })

  it("the app's own interrupt (budget brake) is fed as Escape: a waiting agent stops waiting", () => {
    const { published } = play([
      [0, hook('working')],
      [100, hook('needs-input')],
      [200, input('\x1b')]
    ])
    expect(kinds(published).at(-1)).toBe('idle:user')
  })

  it('a new question after a dismissal rings again', () => {
    const { published } = play([
      [0, hook('working')],
      [100, hook('needs-input', 'a')],
      [200, input('\x1b')],
      [400, hook('needs-input', 'a')]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'needs-input:hook',
      'idle:user',
      'needs-input:hook'
    ])
  })

  it('OpenCode rejected by Escape: the plugin\'s "answered" and the idle session that follow are echoes (measured)', () => {
    const { published, state } = play([
      [0, hook('working')],
      [1100, hook('needs-input', 'OpenCode needs your permission: bash — echo x')],
      [1300, input('\x1b')],
      [1700, hook('working')], // permission.replied (reject) → answered
      [1710, hook('finished')] // session.status idle
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'idle:user'])
    expect(state.kind).toBe('idle')
  })

  it('a prompt submitted right after a dismissal is a real new turn', () => {
    const { published } = play([
      [0, hook('working')],
      [100, hook('needs-input')],
      [200, input('\x1b')],
      [1000, input('\r')], // the person sends "do it differently"
      [1100, hook('working')], // UserPromptSubmit
      [3000, hook('finished')]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'needs-input:hook',
      'idle:user',
      'working:hook',
      'finished:hook'
    ])
  })
})

// ---- Claude Code: the transcript as ground truth (claudeStatusTranscript.ts) ----

const view = (
  phase: TranscriptView['phase'],
  at: number,
  extra: Partial<TranscriptView> = {}
): StatusSignal => ({ type: 'transcript', view: { phase, at, queued: 0, ...extra } })

describe('Claude Code: reconciliation with the transcript (measured on 2.1.287)', () => {
  it('Escape mid-stream: the interrupt marker ends the turn at once — no Stop ever comes', () => {
    const { published, state } = play([
      [0, { type: 'spawn' }],
      [1000, hook('working')], // UserPromptSubmit
      [7000, input('\x1b')],
      [7300, view('interrupted', 7060, { turnStartedAt: 950 })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'idle:transcript'])
    expect(state.kind).toBe('idle')
  })

  it('Escape before the first token (nothing is written): the quiet prompt settles it', () => {
    const { published } = play([
      [1000, hook('working')],
      [4000, input('\x1b')],
      [4500, view('busy', 950, { turnStartedAt: 950 })],
      [7000, { type: 'quiet' }]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'idle:user'])
  })

  it('Ctrl+C mid-stream behaves like Escape', () => {
    const { published } = play([
      [1000, hook('working')],
      [5000, input('\x03')],
      [5200, view('interrupted', 5020)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'idle:transcript'])
  })

  it('an interrupt the keys never showed (the phone, a pop-out, a menu) still ends the turn', () => {
    const { published } = play([
      [1000, hook('working')],
      [9000, view('interrupted', 8800)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'idle:transcript'])
  })

  it('interrupt, then a new prompt at once: idle, then working again from its UserPromptSubmit', () => {
    const { published, state } = play([
      [1000, hook('working')],
      [4000, input('\x1b')],
      [4100, view('interrupted', 4050)],
      [5500, input('\r')],
      [5600, hook('working')],
      [6600, hook('finished')],
      [6700, view('ended', 6610)]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'idle:transcript',
      'working:hook',
      'finished:hook'
    ])
    expect(state.kind).toBe('finished')
  })

  it('a turn that ends with a question in plain text is finished, not waiting', () => {
    const { published } = play([
      [1000, hook('working')],
      [1300, hook('finished')], // Stop — no Notification for plain text
      [1400, view('ended', 1290)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
  })

  it('an API error (rate limit / overloaded): finished from the transcript, with the reason, marked error', () => {
    const { published, state } = play([
      [1000, hook('working')],
      [1200, view('error', 1110, { errorKind: 'rate_limit' })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:transcript'])
    expect(published[1]).toMatchObject({
      detail: 'Claude stopped: API error (rate_limit)',
      error: true
    })
    expect(state.kind).toBe('finished')
  })

  it('a lost Stop (curl timed out): the turn_duration ends the turn', () => {
    const { published } = play([
      [1000, hook('working')],
      [30_000, view('ended', 29_500)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:transcript'])
  })

  it('a long tool call (minutes, no hook) stays working while the transcript shows the tool running', () => {
    const { published } = play([
      [1000, hook('working')],
      [2000, view('busy', 1500)],
      [300_000, view('busy', 1500)]
    ])
    expect(kinds(published)).toEqual(['working:hook'])
  })

  it('the model answered but no turn end follows: settled as finished after ANSWERED_SETTLE_MS', () => {
    const { published } = play([
      [1000, hook('working')],
      [2100, view('answered', 2000)],
      [2000 + ANSWERED_SETTLE_MS - 1, view('answered', 2000)],
      [2000 + ANSWERED_SETTLE_MS, view('answered', 2000)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:transcript'])
  })

  it("a transcript that has not caught up never undoes a hook (the previous turn's end is older)", () => {
    const { published } = play([
      [1000, hook('finished')],
      [5000, hook('working')], // a new prompt — its line not written yet
      [5050, view('ended', 990)],
      [5100, view('error', 4000)]
    ])
    expect(kinds(published)).toEqual(['finished:hook', 'working:hook'])
  })

  it('a lost UserPromptSubmit: a turn started after the finish makes the card working, its end finishes it', () => {
    const { published } = play([
      [1000, hook('finished')],
      [9000, view('busy', 8000, { turnStartedAt: 8000 })],
      [12_000, view('ended', 11_000, { turnStartedAt: 8000 })]
    ])
    expect(kinds(published)).toEqual(['finished:hook', 'working:transcript', 'finished:transcript'])
  })

  it('a queued prompt: its dequeued turn (no UserPromptSubmit) is working, its own Stop rings', () => {
    const { published } = play([
      [1000, hook('working')],
      [4000, hook('working')], // UserPromptSubmit at the enqueue — a repeat
      [20_000, hook('finished')], // the first turn's Stop (the wiring holds it when it sees the queue)
      [20_100, view('busy', 20_030, { turnStartedAt: 20_030 })],
      [21_000, hook('finished')]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'finished:hook',
      'working:transcript',
      'finished:hook'
    ])
  })

  it('a turn end with a prompt still queued waits for the dequeued turn instead of ringing', () => {
    const { published } = play([
      [1000, hook('working')],
      [20_100, view('ended', 20_000, { turnStartedAt: 1000, queued: 1 })],
      [21_000, view('busy', 20_050, { turnStartedAt: 20_050 })],
      [30_000, view('ended', 29_000, { turnStartedAt: 20_050 })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:transcript'])
  })

  it('a queue count the tail got wrong still ends the turn after QUEUED_SETTLE_MS', () => {
    const { published } = play([
      [1000, hook('working')],
      [20_100, view('ended', 20_000, { turnStartedAt: 1000, queued: 1 })],
      [20_000 + QUEUED_SETTLE_MS, view('ended', 20_000, { turnStartedAt: 1000, queued: 1 })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:transcript'])
  })

  it("the finished turn's own trailing entries never make it working again", () => {
    const { published } = play([
      [1000, hook('working')],
      [5000, hook('finished')],
      [5100, view('ended', 5010, { turnStartedAt: 1000 })],
      [9000, view('answered', 5005, { turnStartedAt: 1000 })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
  })

  it('a waiting card answered out of sight (mouse, phone): the model writing again makes it working', () => {
    const { published } = play([
      [1000, hook('working')],
      [7000, hook('needs-input', 'Claude wants to run: x')],
      [9000, view('busy', 8900, { assistantAt: 8900 })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'working:transcript'])
  })

  it('a waiting card answered "No" out of sight: the interrupt ends it as idle', () => {
    const { published } = play([
      [1000, hook('working')],
      [7000, hook('needs-input')],
      [9000, view('interrupted', 8500)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'idle:transcript'])
  })

  it('a tool result alone (a parallel call finishing) does not answer a waiting card', () => {
    const { published } = play([
      [1000, hook('working')],
      [7000, hook('needs-input')],
      [9000, view('busy', 8500, { assistantAt: 1500 })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook'])
  })

  it("the question's own tool_use line, flushed late, is older than the question", () => {
    const { published } = play([
      [1000, hook('working')],
      [7000, hook('needs-input')],
      [9000, view('busy', 1100, { assistantAt: 1100 })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook'])
  })

  it("background bash: the turn ends, the task's notification turn is announced by its own hooks", () => {
    const { published } = play([
      [1000, hook('working')],
      [2300, hook('finished')],
      [2400, view('ended', 2310)],
      [14_200, hook('working')], // UserPromptSubmit for <task-notification>
      [14_300, view('busy', 14_150, { turnStartedAt: 14_150 })],
      [14_400, hook('finished')]
    ])
    expect(kinds(published)).toEqual([
      'working:hook',
      'finished:hook',
      'working:hook',
      'finished:hook'
    ])
  })

  it("a subagent's PostToolUse after the Stop stays dropped; its sidechain never reaches the view", () => {
    const { published } = play([
      [1000, hook('working')],
      [1500, hook('finished')],
      [3000, hook('working', undefined, true)],
      [3100, view('ended', 1510)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
  })

  it('/compact, /clear, /help, /cost, /model: no hook, nothing in the view — the status stays', () => {
    const { published } = play([
      [1000, hook('working')],
      [2000, hook('finished')],
      [3000, view('ended', 2010)],
      [60_000, view('ended', 2010)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'finished:hook'])
  })

  it("after a restart (spawn → idle) the resumed transcript's old entries change nothing", () => {
    const { published } = play([
      [1000, hook('working')],
      [2000, { type: 'exit' }],
      [3000, { type: 'spawn' }],
      [4000, view('busy', 1500, { turnStartedAt: 900 })]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'idle:reset'])
  })

  it('facts while the process is dead (or before any hook) are not reconciled', () => {
    expect(play([[1000, view('busy', 900, { turnStartedAt: 900 })]]).published).toEqual([])
    const { published } = play([
      [1000, hook('working')],
      [2000, { type: 'exit' }],
      [2100, view('ended', 2050)]
    ])
    expect(kinds(published)).toEqual(['working:hook'])
  })

  it('a dismissal followed by the interrupt marker publishes nothing more', () => {
    const { published } = play([
      [1000, hook('working')],
      [7000, hook('needs-input')],
      [8000, input('\x1b')],
      [8300, view('interrupted', 8050)]
    ])
    expect(kinds(published)).toEqual(['working:hook', 'needs-input:hook', 'idle:user'])
  })
})
