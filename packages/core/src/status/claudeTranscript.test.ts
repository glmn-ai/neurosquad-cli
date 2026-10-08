import { describe, expect, it } from 'vitest'
import {
  emptyView,
  ingestEntry,
  ingestLine,
  type Entry,
  type TranscriptView
} from './claudeTranscript.js'

// Entry shapes as Claude Code 2.1.287 writes them (measured with the fake
// model, docs/agent-status.md "Claude Code — transcript"). Contents are
// placeholders: only the structure matters here.
const T0 = Date.parse('2026-10-02T00:00:00.000Z')
const ts = (s: number): string => new Date(T0 + s * 1000).toISOString()
const at = (s: number): number => T0 + s * 1000

const prompt = (s: number, extra: Partial<Entry> = {}): Entry => ({
  type: 'user',
  timestamp: ts(s),
  message: { content: 'please do it' },
  ...extra
})
const assistant = (
  s: number,
  stop: string | null,
  blocks: string[] = ['text'],
  extra: Partial<Entry> = {}
): Entry => ({
  type: 'assistant',
  timestamp: ts(s),
  message: { content: blocks.map((type) => ({ type, text: 'x' })), stop_reason: stop },
  ...extra
})
const toolResult = (s: number, content = 'ok', extra: Partial<Entry> = {}): Entry => ({
  type: 'user',
  timestamp: ts(s),
  message: { content: [{ type: 'tool_result', content }] },
  ...extra
})
const userText = (s: number, text: string, extra: Partial<Entry> = {}): Entry => ({
  type: 'user',
  timestamp: ts(s),
  message: { content: [{ type: 'text', text }] },
  ...extra
})
const system = (s: number, subtype: string): Entry => ({
  type: 'system',
  subtype,
  timestamp: ts(s)
})
const queue = (s: number, operation: string): Entry => ({
  type: 'queue-operation',
  operation,
  timestamp: ts(s)
})

function play(entries: Entry[], start: TranscriptView = emptyView()): TranscriptView {
  return entries.reduce(ingestEntry, start)
}

describe('the transcript tail of a Claude Code turn', () => {
  it('a turn that ran to its end: prompt → answer → Stop hook summary → turn_duration', () => {
    const view = play([
      prompt(1),
      assistant(2, 'end_turn'),
      { type: 'attachment', timestamp: ts(2.1) },
      system(2.1, 'stop_hook_summary'),
      system(2.1, 'turn_duration')
    ])
    expect(view).toMatchObject({
      phase: 'ended',
      at: at(2.1),
      turnStartedAt: at(1),
      assistantAt: at(2)
    })
  })

  it('the answer alone (turn_duration not written yet) is "answered", not ended', () => {
    expect(
      play([prompt(1), assistant(2, 'end_turn', ['thinking']), assistant(2, 'end_turn')]).phase
    ).toBe('answered')
  })

  it('a turn ending in a question is an answered turn like any other', () => {
    const view = play([prompt(1), assistant(2, 'end_turn'), system(2.1, 'turn_duration')])
    expect(view.phase).toBe('ended')
  })

  it('a tool call: busy while the tool runs, busy after its result until the model answers', () => {
    let view = play([prompt(1), assistant(1.5, 'tool_use', ['tool_use'])])
    expect(view.phase).toBe('busy')
    view = ingestEntry(view, toolResult(21))
    expect(view).toMatchObject({ phase: 'busy', at: at(21) })
    view = ingestEntry(view, assistant(22, 'end_turn'))
    expect(view.phase).toBe('answered')
  })

  it('Escape / Ctrl+C mid-stream: an aborted assistant line, then the interrupt marker (no turn_duration)', () => {
    const view = play([
      prompt(1),
      assistant(6, null, ['text'], { isAbortedMidStream: true } as Partial<Entry>),
      userText(6, '[Request interrupted by user]')
    ])
    expect(view).toMatchObject({ phase: 'interrupted', at: at(6) })
  })

  it('Escape mid-tool: a user-rejected tool result and the marker for tool use', () => {
    const view = play([
      prompt(1),
      assistant(1.2, 'tool_use', ['tool_use']),
      toolResult(7, "The user doesn't want to proceed with this tool use."),
      userText(7, '[Request interrupted by user for tool use]')
    ])
    expect(view.phase).toBe('interrupted')
  })

  it('"No" on a permission prompt: interrupted, and the turn_duration after it keeps it interrupted', () => {
    const view = play([
      prompt(1),
      assistant(1.2, 'tool_use', ['tool_use']),
      toolResult(9),
      userText(9, '[Request interrupted by user for tool use]'),
      system(9, 'turn_duration')
    ])
    expect(view).toMatchObject({ phase: 'interrupted', at: at(9) })
  })

  it('an interrupted tool result on its own (older builds) is an interrupt too', () => {
    expect(
      play([prompt(1), toolResult(3, '[Request interrupted by user for tool use]')]).phase
    ).toBe('interrupted')
  })

  it('an API error (429 / 529 / 400): a synthetic error message, then turn_duration — no Stop', () => {
    const view = play([
      prompt(1),
      assistant(1.1, 'stop_sequence', ['text'], {
        isApiErrorMessage: true,
        error: 'rate_limit',
        apiErrorStatus: 429
      }),
      system(1.1, 'turn_duration')
    ])
    expect(view).toMatchObject({ phase: 'error', errorKind: 'rate_limit' })
    expect(
      play([
        prompt(1),
        assistant(2, 'stop_sequence', ['text'], { isApiErrorMessage: true, apiErrorStatus: 529 })
      ]).errorKind
    ).toBe('529')
  })

  it('a prompt typed while a turn runs is queued; its dequeue after the Stop starts the next turn', () => {
    let view = play([prompt(1), queue(4, 'enqueue')])
    expect(view.queued).toBe(1)
    view = play(
      [
        assistant(9, 'end_turn'),
        system(9.1, 'turn_duration'),
        queue(9.12, 'dequeue'),
        prompt(9.13)
      ],
      view
    )
    expect(view).toMatchObject({ phase: 'busy', queued: 0, turnStartedAt: at(9.13) })
  })

  it('a queued prompt absorbed mid-turn ("remove") no longer counts', () => {
    expect(play([prompt(1), queue(2, 'enqueue'), queue(3, 'remove')]).queued).toBe(0)
    expect(play([queue(3, 'remove')]).queued).toBe(0)
  })

  it('a background task / subagent finishing starts a turn of its own (<task-notification>)', () => {
    const view = play(
      [
        queue(18, 'enqueue'),
        queue(18, 'dequeue'),
        prompt(18.01, { message: { content: '<task-notification>…' } })
      ],
      play([prompt(1), assistant(2, 'end_turn'), system(2.1, 'turn_duration')])
    )
    expect(view).toMatchObject({ phase: 'busy', turnStartedAt: at(18.01) })
  })

  it("a subagent's own conversation (sidechain) is not the session's turn", () => {
    const done = play([prompt(1), assistant(2, 'end_turn'), system(2.1, 'turn_duration')])
    const view = play(
      [
        prompt(3, { isSidechain: true }),
        assistant(4, 'tool_use', ['tool_use'], { isSidechain: true })
      ],
      done
    )
    expect(view).toBe(done)
  })

  it('slash commands and ! bash mode the CLI handles itself start no turn', () => {
    const done = play([prompt(1), assistant(2, 'end_turn'), system(2.1, 'turn_duration')])
    const view = play(
      [
        prompt(10, { message: { content: '/compact' } }),
        system(10.4, 'compact_boundary'),
        prompt(10.2, {
          isCompactSummary: true,
          message: { content: 'This session is being continued…' }
        }),
        prompt(10, { isMeta: true, message: { content: '<local-command-caveat>…' } }),
        prompt(10, {
          message: {
            content:
              '<command-name>/compact</command-name>\n<command-message>compact</command-message>'
          }
        }),
        prompt(10.5, {
          message: { content: '<local-command-stdout>Compacted</local-command-stdout>' }
        }),
        prompt(20, { message: { content: '<bash-input>echo hi</bash-input>' } }),
        prompt(20.1, {
          message: { content: '<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>' }
        })
      ],
      done
    )
    expect(view).toEqual(done)
  })

  it('a slash command that runs the model (<command-message>) is a turn', () => {
    const view = play([
      prompt(5, { message: { content: '<command-message>review</command-message>' } })
    ])
    expect(view).toMatchObject({ phase: 'busy', turnStartedAt: at(5) })
  })

  it('auto-compaction mid-turn keeps the turn running', () => {
    const view = play([
      prompt(1),
      assistant(2, 'tool_use', ['tool_use']),
      toolResult(3),
      system(4, 'compact_boundary'),
      prompt(4, { isCompactSummary: true }),
      assistant(5, 'tool_use', ['tool_use'])
    ])
    expect(view.phase).toBe('busy')
    expect(view.turnStartedAt).toBe(at(1))
  })

  it('a malformed or unknown line changes nothing', () => {
    const view = play([prompt(1)])
    expect(ingestLine(view, '{"type":"assistant","message":')).toBe(view)
    expect(ingestLine(view, '')).toBe(view)
    expect(ingestLine(view, '{"type":"ai-title","aiTitle":"x"}')).toBe(view)
    expect(ingestLine(view, '{"type":"last-prompt"}')).toBe(view)
  })
})
