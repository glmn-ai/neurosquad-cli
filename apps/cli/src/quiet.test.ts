import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QuietMonitor,
  quietAfterMs,
  quietDuration,
  typedByPerson,
  type QuietEnd,
  type QuietView
} from './daemon/quiet.js'
import { AgentInput, type InputPty } from './daemon/agentInput.js'
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

  /** A pty that records what went in; every write moves the screen, as the agent would echo. */
  const fakePty = (): InputPty & { written: string[]; running: boolean } => {
    const pty = {
      written: [] as string[],
      running: true,
      isRunning: () => pty.running,
      write: (_id: string, data: string) => void pty.written.push(data),
      paste: (_id: string, text: string) => (pty.written.push(`paste:${text}`), true),
      submit: (_id: string, text: string) => (pty.written.push(`submit:${text}`), true),
      interrupt: (_id: string, keys: string | readonly string[]) =>
        void pty.written.push(`interrupt:${[keys].flat().join('')}`)
    }
    return pty
  }

  it('an answer (y/a/n from the dashboard, nsq answer, the phone) ends the episode at once', async () => {
    const pty = fakePty()
    const noted: string[] = []
    const input = new AgentInput(pty, monitor, {
      noteKeys: (_id, data) => void noted.push(data),
      wait: async () => {}
    })
    monitor.status('a', 'working')
    screen.print(PROMPT)
    run(6 * 60_000)
    expect(monitor.current('a')).toMatchObject({ asking: PROMPT })
    const by = { via: 'cli' as const, from: 'local' as const }
    // OpenCode's "always": three presses.
    await input.answer('a', ['\x1b[C', '\r', '\r'], by, 400)
    expect(monitor.current('a')).toBeUndefined()
    expect(ends).toEqual([['a', 'input', by]])
    expect(pty.written).toEqual(['\x1b[C', '\r', '\r'])
    // As the person's own keys, for the status machine.
    expect(noted).toEqual(['\x1b[C', '\r', '\r'])
    // The clock starts again from the answer.
    run(4 * 60_000)
    expect(starts).toHaveLength(1)
    run(2 * 60_000)
    expect(starts).toHaveLength(2)
  })

  it('an answer to an agent that stopped between presses throws, after what went in', async () => {
    const pty = fakePty()
    const input = new AgentInput(pty, monitor, {
      noteKeys: () => {},
      wait: async () => void (pty.running = false)
    })
    await expect(
      input.answer('a', ['1', '2'], { via: 'phone', from: 'lan' }, 400, 'fq')
    ).rejects.toThrow('fq is not running')
    expect(pty.written).toEqual(['1'])
  })

  it('every other way in ends the episode too: keys, a paste, a prompt, an interrupt', () => {
    const pty = fakePty()
    const input = new AgentInput(pty, monitor, { noteKeys: () => {} })
    const by = { via: 'dashboard' as const, from: 'local' as const }
    const quietNow = (): void => {
      monitor.status('a', 'working')
      run(6 * 60_000)
      expect(monitor.current('a')).toBeDefined()
    }
    const ways: [string, () => void][] = [
      ['keys', () => input.keys('a', 'x', by)],
      ['paste', () => void input.paste('a', 'text', by)],
      ['submit', () => void input.submit('a', 'do it', by)],
      ['queued prompt', () => void input.submit('a', 'next')],
      ['interrupt', () => input.interrupt('a', ['\x1b'], by)]
    ]
    for (const [way, send] of ways) {
      quietNow()
      ends.length = 0
      send()
      expect(monitor.current('a'), way).toBeUndefined()
      expect(
        ends.map(([, how]) => how),
        way
      ).toEqual(['input'])
    }
    // A focus report is the terminal, not a person: the episode stays.
    quietNow()
    ends.length = 0
    input.keys('a', '\x1b[I', by)
    expect(monitor.current('a')).toBeDefined()
    expect(ends).toEqual([])
    // Nothing goes to a stopped agent, and nothing is credited.
    pty.running = false
    expect(input.paste('a', 'late', by)).toBe(false)
    expect(input.submit('a', 'late', by)).toBe(false)
    input.interrupt('a', '\x1b', by)
    expect(pty.written.some((data) => data.includes('late'))).toBe(false)
    expect(monitor.current('a')).toBeDefined()
  })

  it('the daemon reaches the pty for input only through AgentInput', () => {
    const daemon = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'daemon', 'daemon.ts'),
      'utf8'
    )
    // AgentInput owns the one pty host; the daemon keeps only its control view (PtyControl has
    // no write/paste/submit/interrupt, so a direct input call does not compile).
    expect(daemon.match(/\bnew PtyHost\(/g)).toHaveLength(1)
    expect(daemon).toMatch(/new AgentInput\(new PtyHost\(\)/)
    expect(daemon).toMatch(/private readonly ptys: PtyControl = this\.input\.control/)
    expect(daemon).not.toMatch(/\bnoteUserInput\b/)
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

  it('turning it off (or raising it) while quiet ends the episode at once', () => {
    monitor.status('a', 'working')
    run(6 * 60_000)
    expect(starts).toHaveLength(1)
    afterMs = 0
    run(2000)
    expect(ends).toEqual([['a', 'setting', undefined]])
    expect(monitor.current('a')).toBeUndefined()
    afterMs = 30 * 60_000
    run(10 * 60_000)
    expect(starts).toHaveLength(1)
    afterMs = 5 * 60_000
    run(2000)
    expect(starts).toHaveLength(2)
    afterMs = 60 * 60_000
    run(2000)
    expect(ends.at(-1)).toEqual(['a', 'setting', undefined])
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
