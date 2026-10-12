import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QuietMonitor,
  quietAfterMs,
  quietDuration,
  typedByPerson,
  type QuietEnd,
  type QuietView
} from './daemon/quiet.js'
import { ntfyQuietMessage } from './daemon/push.js'
import { ApprovalLog, readApprovals } from './daemon/approvals.js'
import { answerLabel, formatApprovals } from './approvalsCommand.js'
import { statusLabel } from './format.js'
import { formatTable, parseQuietMinutes } from './commands.js'
import { quietContext, quietLabel } from './tui/app.js'
import type { AgentView } from './protocol.js'

const PROMPT = "Password for 'https://me@git.example.com':"
const SPINNER = ['✻', '✽', '✶', '✳']

/** A fake agent screen: a spinner row that turns on every frame, and whatever was printed. */
class FakeScreen {
  version = 0
  printed: string[] = ['⏺ Bash(git push)']
  frame = 0
  spin(): void {
    this.frame += 1
    this.version += 1
  }
  print(line: string): void {
    this.printed.push(line)
    this.version += 1
  }
  lines(): string[] {
    const rows = [
      `${SPINNER[this.frame % SPINNER.length]} Pushing… (${this.frame}s · esc to interrupt)`,
      ...this.printed
    ]
    while (rows.length < 8) rows.push('')
    return rows
  }
}

describe('QuietMonitor (fake clock)', () => {
  let screen: FakeScreen
  let starts: [string, QuietView][]
  let ends: [string, QuietEnd, unknown][]
  let afterMs: number
  let monitor: QuietMonitor

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    screen = new FakeScreen()
    starts = []
    ends = []
    afterMs = 5 * 60_000
    monitor = new QuietMonitor({
      screen: () => ({ version: screen.version, lines: screen.lines() }),
      afterMs: () => afterMs,
      onStart: (id, view) => starts.push([id, view]),
      onEnd: (id, _view, how, by) => ends.push([id, how, by])
    })
  })

  afterEach(() => {
    monitor.closeAll()
    vi.useRealTimers()
  })

  /** Advances the clock in one-second steps, the spinner turning every step. */
  const run = (ms: number): void => {
    for (let t = 0; t < ms; t += 1000) {
      screen.spin()
      vi.advanceTimersByTime(1000)
    }
  }

  it('flags a working agent after the threshold with no real output, once, with the prompt', () => {
    monitor.status('a', 'working')
    screen.print(PROMPT)
    run(4 * 60_000)
    expect(starts).toEqual([])
    run(70_000)
    expect(starts).toHaveLength(1)
    expect(starts[0]![1]).toMatchObject({ line: PROMPT, asking: PROMPT })
    expect(monitor.current('a')).toMatchObject({ asking: PROMPT })
    run(10 * 60_000)
    expect(starts).toHaveLength(1)
  })

  it('a spinner alone never resets the clock; real output does', () => {
    monitor.status('a', 'working')
    run(4 * 60_000)
    screen.print('Writing objects: 100% (3/3), done.')
    run(4 * 60_000)
    expect(starts).toEqual([])
    run(2 * 60_000)
    expect(starts).toHaveLength(1)
    screen.print('main -> main')
    run(2000)
    expect(ends).toEqual([['a', 'output', undefined]])
    expect(monitor.current('a')).toBeUndefined()
  })

  it('input ends the episode at once and restarts the clock', () => {
    monitor.status('a', 'working')
    run(6 * 60_000)
    expect(starts).toHaveLength(1)
    const by = { via: 'terminal' as const, from: 'local' as const, client: 'dashboard' }
    monitor.activity('a', 'input', by)
    expect(ends).toEqual([['a', 'input', by]])
    run(4 * 60_000)
    expect(starts).toHaveLength(1)
    run(2 * 60_000)
    expect(starts).toHaveLength(2)
  })

  it('a hook (progress the harness reported) restarts the clock too', () => {
    monitor.status('a', 'working')
    run(4 * 60_000)
    monitor.activity('a', 'hook')
    run(4 * 60_000)
    expect(starts).toEqual([])
    // a repeat of working (new wording) is progress as well
    monitor.status('a', 'working')
    run(4 * 60_000)
    expect(starts).toEqual([])
  })

  it('never fires while idle, finished, needing you or exited; leaving working ends it', () => {
    for (const kind of ['idle', 'finished', 'needs-input'] as const) {
      monitor.status(kind, kind)
    }
    run(30 * 60_000)
    expect(starts).toEqual([])
    monitor.status('a', 'working')
    run(6 * 60_000)
    expect(starts).toHaveLength(1)
    monitor.status('a', 'needs-input')
    expect(ends).toEqual([['a', 'needs-input', undefined]])
    run(30 * 60_000)
    expect(starts).toHaveLength(1)
    monitor.status('a', 'working')
    run(6 * 60_000)
    monitor.exited('a')
    expect(ends.at(-1)).toEqual(['a', 'exited', undefined])
  })

  it('0 turns it off; nsq stopping ends an open episode unanswered', () => {
    afterMs = 0
    monitor.status('a', 'working')
    run(60 * 60_000)
    expect(starts).toEqual([])
    afterMs = 60_000
    run(70_000)
    expect(starts).toHaveLength(1)
    monitor.closeAll()
    expect(ends).toEqual([['a', 'unanswered', undefined]])
  })

  it('masks secret-looking parts of the screen line', () => {
    screen.print('export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123')
    monitor.status('a', 'working')
    run(6 * 60_000)
    expect(starts[0]![1].line).toBe('export GITHUB_TOKEN=***')
  })
})

describe('quiet helpers', () => {
  it('thresholds: the agent, then the config, then 5 minutes', () => {
    expect(quietAfterMs(2, 10)).toBe(120_000)
    expect(quietAfterMs(undefined, 10)).toBe(600_000)
    expect(quietAfterMs(undefined, 0)).toBe(0)
    expect(quietAfterMs(undefined, undefined)).toBe(300_000)
    expect(quietAfterMs(-1, Number.NaN)).toBe(300_000)
    expect(parseQuietMinutes('0')).toBe(0)
    expect(parseQuietMinutes('0.5')).toBe(0.5)
    expect(parseQuietMinutes('1441')).toBeUndefined()
    expect(parseQuietMinutes('five')).toBeUndefined()
    expect(parseQuietMinutes('-1')).toBeUndefined()
  })

  it('durations, focus reports', () => {
    expect(quietDuration(7 * 60_000 + 20_000)).toBe('7 min')
    expect(quietDuration(3400)).toBe('3 s')
    expect(typedByPerson('\x1b[I')).toBe(false)
    expect(typedByPerson('\x1b[O\x1b[I')).toBe(false)
    expect(typedByPerson('y')).toBe(true)
    expect(typedByPerson('\r')).toBe(true)
  })

  it('the push: name, how long, the prompt or the last line — no answer actions', () => {
    const target = { server: 'https://ntfy.sh', topic: 't' }
    expect(
      ntfyQuietMessage(target, {
        agentId: 'a',
        agentName: 'api',
        duration: '7 min',
        line: PROMPT,
        asking: PROMPT,
        click: 'http://10.0.0.2:8766/'
      })
    ).toEqual({
      topic: 't',
      title: 'api has been quiet for 7 min',
      message: `Looks like it's asking: ${PROMPT}`,
      priority: 4,
      tags: ['hourglass'],
      click: 'http://10.0.0.2:8766/'
    })
    const plain = ntfyQuietMessage(target, {
      agentId: 'a',
      agentName: 'api',
      duration: '5 min',
      line: `\u001b[31mBuilding\u0007 ${'x'.repeat(400)}`
    })
    expect(plain.message).toMatch(/^Last line: Building x+…$/)
    expect((plain.message as string).length).toBe(300)
    expect(
      ntfyQuietMessage(target, { agentId: 'a', agentName: 'api', duration: '5 min' }).message
    ).toBe('No new output. Check it.')
  })

  it('ls, the dashboard and the status label say quiet with the hint', () => {
    const now = 2_000_000
    const agent: AgentView = {
      id: '1',
      name: 'api',
      harness: 'claude-code',
      workspace: '/w',
      cwd: '/w',
      createdAt: 0,
      running: true,
      status: 'working',
      statusAt: now - 600_000,
      quiet: { since: now - 420_000, at: now - 120_000, line: PROMPT, asking: PROMPT }
    }
    expect(statusLabel(agent, now)).toBe('quiet 7m')
    expect(statusLabel({ status: 'working' }, now)).toBe('working')
    const [, row] = formatTable([agent], now)
    expect(row).toMatch(/^api\s+Claude Code\s+quiet 7m\s+10m\s+.*check it — asking: Password for/)
    expect(quietLabel(agent.quiet!, now)).toBe('quiet 7m — check it')
    expect(quietContext(agent.quiet!)).toBe(`looks like it's asking: ${PROMPT}`)
    expect(quietContext({ since: 0, at: 0, line: 'make: waiting' })).toBe(
      'last line: make: waiting'
    )
  })
})

describe('quiet episodes in the approvals log', () => {
  let dir = ''
  let clock = 1_700_000_000_000
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsq-quiet-log-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records start, end and how it ended; nsq stopping ends it unanswered', () => {
    const log = new ApprovalLog({
      dir,
      enabled: () => true,
      showPath: (path) => path,
      now: () => clock
    })
    const agent = { id: 'a1', name: 'api', harness: 'claude-code' as const, workspace: '/w' }
    log.quietStarted(agent, { since: clock - 300_000, at: clock, line: PROMPT, asking: PROMPT })
    clock += 60_000
    log.quietEnded('a1', 'input', { via: 'dashboard', from: 'local' })
    log.quietEnded('a1', 'output') // nothing open: nothing written
    log.quietStarted(agent, { since: clock - 300_000, at: clock, line: 'still building' })
    log.closeAll()
    const records = readApprovals(dir)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      kind: 'quiet',
      askedAt: new Date(clock - 60_000).toISOString(),
      quietSince: new Date(clock - 360_000).toISOString(),
      at: new Date(clock).toISOString(),
      agent: { id: 'a1', name: 'api' },
      question: { text: `quiet; looks like it's asking: ${PROMPT}` },
      outcome: 'input',
      by: { via: 'dashboard', from: 'local' }
    })
    expect(records[1]).toMatchObject({
      kind: 'quiet',
      question: { text: 'quiet; last line: still building' },
      outcome: 'unanswered'
    })
    expect(answerLabel(records[0]!)).toBe('input')
    expect(answerLabel({ ...records[0]!, outcome: 'output' })).toBe('new output')
    const table = formatApprovals(records, 200)
    expect(table[1]).toMatch(/api\s+Claude Code\s+input\s+dashboard\s+quiet; looks like/)
  })
})
