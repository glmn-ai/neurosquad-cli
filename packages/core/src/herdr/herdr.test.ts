import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_HERDR_SEQ,
  createHerdrPanes,
  encodeHerdrRequest,
  herdrError,
  herdrOk,
  herdrPipeName,
  herdrUnsupported,
  parseHerdrRequest,
  resumeArgvProblem,
  type HerdrReport
} from './protocol.js'
import { applyHerdrReport, emptyHerdrPane, type HerdrPaneState } from './pane.js'
import { herdrCliReply, parseHerdrCli } from './cli.js'
import { sendHerdrRequest, startHerdrServer } from './server.js'
import {
  configureStatusHub,
  agentStatusSnapshot,
  noteUserInput,
  receiveHerdrReport
} from '../status/hub.js'
import { emitPtyData, emitPtyExit, emitPtySpawn, emitPtySubmit } from '../pty/events.js'
import { prepareCommandLaunch } from '../harnesses/launch.js'
import type { AgentHookEvent } from '../status/types.js'
import type { HarnessId } from '../harnesses/types.js'

const line = (method: string, params: Record<string, unknown>, id = 'r1'): string =>
  JSON.stringify({ id, method, params })

const report = (state: string, extra: Record<string, unknown> = {}): string =>
  line('pane.report_agent', { pane_id: 'p', source: 'crush', agent: 'crush', state, ...extra })

describe('herdr protocol: request lines', () => {
  it('parses a state report the way Crush sends it, keeping a nanosecond seq exact', () => {
    // A real Crush 0.98 line: seq seeded from the clock in nanoseconds, an empty session id.
    const parsed = parseHerdrRequest(
      '{"id":"crush:init:1791737342433958200","method":"pane.report_agent","params":{"pane_id":"a.b","source":"crush","agent":"crush","state":"idle","seq":1791737342433958201,"agent_session_id":""}}'
    )
    expect(parsed?.id).toBe('crush:init:1791737342433958200')
    expect(parsed?.report).toEqual({
      method: 'pane.report_agent',
      paneId: 'a.b',
      source: 'crush',
      agent: 'crush',
      state: 'idle',
      seq: 1791737342433958201n
    })
    // The next one is a different number (as doubles the two are the same).
    const next = report('working').replace('"state"', '"seq":1791737342433958202,"state"')
    expect(parseHerdrRequest(next)?.report?.seq).toBe(1791737342433958202n)
  })

  it('carries the message, session id and resume command', () => {
    const parsed = parseHerdrRequest(
      report('blocked', {
        message: 'needs approval',
        agent_session_id: 's-1',
        resume_argv: ['my-agent', '--resume', 's-1']
      })
    )
    expect(parsed?.report).toMatchObject({
      state: 'blocked',
      message: 'needs approval',
      sessionId: 's-1',
      resumeArgv: ['my-agent', '--resume', 's-1']
    })
  })

  it('rejects malformed reports with herdr error codes', () => {
    expect(parseHerdrRequest(report('busy'))?.invalid?.code).toBe('invalid_request')
    expect(
      parseHerdrRequest(line('pane.report_agent', { source: 's', agent: 'a', state: 'idle' }))
        ?.invalid?.code
    ).toBe('invalid_request')
    expect(
      parseHerdrRequest(
        line('pane.report_agent', { pane_id: 'p', source: 's', agent: ' ', state: 'idle' })
      )?.invalid?.code
    ).toBe('invalid_agent')
    expect(parseHerdrRequest(report('idle', { seq: -1 }))?.invalid?.code).toBe('invalid_request')
    expect(
      parseHerdrRequest(report('idle', { resume_argv: ['/usr/bin/agent'] }))?.invalid?.code
    ).toBe('invalid_resume_argv')
  })

  it('leaves other methods and garbage to the caller', () => {
    expect(parseHerdrRequest(line('pane.split', {}))).toEqual({ id: 'r1', method: 'pane.split' })
    expect(parseHerdrRequest('not json')).toBeNull()
    expect(parseHerdrRequest('[1,2]')).toBeNull()
    expect(JSON.parse(herdrUnsupported('x', 'pane.split'))).toMatchObject({
      id: 'x',
      error: { code: 'unknown_method' }
    })
    expect(JSON.parse(herdrOk('x'))).toEqual({ id: 'x', result: { type: 'ok' } })
    expect(JSON.parse(herdrError('x', 'c', 'm'))).toEqual({
      id: 'x',
      error: { code: 'c', message: 'm' }
    })
  })

  it("follows herdr's resume command rules", () => {
    expect(resumeArgvProblem(['crush', '--session', 'abc'])).toBeNull()
    expect(resumeArgvProblem([])).toMatch(/empty/)
    expect(resumeArgvProblem(['./agent'])).toMatch(/plain command/)
    expect(resumeArgvProblem(['C:\\bin\\agent.exe'])).toMatch(/plain command/)
    expect(resumeArgvProblem(['-x'])).toMatch(/plain command/)
    expect(resumeArgvProblem(['agent', "it's"])).toMatch(/apostrophes/)
    expect(resumeArgvProblem(['agent', 'a\nb'])).toMatch(/control/)
    expect(resumeArgvProblem(['agent', ...Array.from({ length: 64 }, () => 'x')])).toMatch(/64/)
    expect(resumeArgvProblem(['agent', 'x'.repeat(8200)])).toMatch(/bytes/)
  })

  it('writes a bigint seq as a JSON number', () => {
    const text = encodeHerdrRequest({ method: 'm', params: { seq: MAX_HERDR_SEQ } })
    expect(text).toBe(`{"method":"m","params":{"seq":${MAX_HERDR_SEQ}}}\n`)
    expect(parseHerdrRequest(text.replace('"m"', '"pane.release_agent"'))?.invalid).toBeDefined()
  })

  it('names the Windows pipe after the socket path, as herdr does', () => {
    expect(herdrPipeName('C:\\Temp\\x\\herdr.sock')).toBe('\\\\.\\pipe\\C:\\Temp\\x\\herdr.sock')
  })
})

describe('herdr pane ids', () => {
  const panes = createHerdrPanes('secret')
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  it('name their agent, and only with the right HMAC', () => {
    const pane = panes.paneIdFor(id)
    expect(panes.agentOf(pane)).toBe(id)
    const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    // Another agent's id with this agent's HMAC, a changed HMAC, another run's secret: no.
    expect(panes.agentOf(`${other}.${pane.split('.')[1]}`)).toBeNull()
    expect(panes.agentOf(pane.slice(0, -1) + (pane.endsWith('0') ? '1' : '0'))).toBeNull()
    expect(createHerdrPanes('another run').agentOf(pane)).toBeNull()
    expect(panes.agentOf('w1:p1')).toBeNull()
  })
})

describe('herdr pane state', () => {
  const r = (state: HerdrReport['state'], extra: Partial<HerdrReport> = {}): HerdrReport => ({
    method: 'pane.report_agent',
    paneId: 'p',
    source: 'crush',
    agent: 'crush',
    state,
    ...extra
  })
  const run = (reports: HerdrReport[]): { state: HerdrPaneState; facts: unknown[] } => {
    let state = emptyHerdrPane()
    const facts: unknown[] = []
    for (const one of reports) {
      const effects = applyHerdrReport(state, one)
      state = effects.state
      facts.push(effects.fact?.kind ?? null)
    }
    return { state, facts }
  }

  it('maps a turn: registration idle → working → blocked → working → idle', () => {
    const { facts } = run([
      r('idle', { seq: 1n }),
      r('working', { seq: 2n }),
      r('blocked', { seq: 3n }),
      r('working', { seq: 4n }),
      r('idle', { seq: 5n }),
      r('unknown', { seq: 6n })
    ])
    expect(facts).toEqual(['ready', 'working', 'needs-input', 'working', 'finished', null])
  })

  it('a block carries its message, or who waits', () => {
    const withMessage = applyHerdrReport(emptyHerdrPane(), r('blocked', { message: 'Run tests?' }))
    expect(withMessage.fact).toEqual({ kind: 'needs-input', detail: 'Run tests?' })
    expect(applyHerdrReport(emptyHerdrPane(), r('blocked')).fact).toEqual({
      kind: 'needs-input',
      detail: 'crush is waiting for your decision'
    })
  })

  it('drops stale reports by seq, per source', () => {
    let state = applyHerdrReport(emptyHerdrPane(), r('working', { seq: 10n })).state
    expect(applyHerdrReport(state, r('idle', { seq: 10n })).applied).toBe(false)
    expect(applyHerdrReport(state, r('idle', { seq: 9n })).applied).toBe(false)
    // Without a seq once the source used one: stale too (herdr's rule).
    expect(applyHerdrReport(state, r('idle')).applied).toBe(false)
    expect(applyHerdrReport(state, r('idle', { seq: 11n })).fact).toEqual({ kind: 'finished' })
    // Another source keeps its own count.
    state = applyHerdrReport(state, r('idle', { source: 'other', seq: 1n })).state
    expect(state.seqs).toEqual({ crush: 10n, other: 1n })
  })

  it('takes a resume command only from the holder; a release forgets it', () => {
    const session: HerdrReport = {
      method: 'pane.report_agent_session',
      paneId: 'p',
      source: 'crush',
      agent: 'crush',
      sessionId: 's',
      resumeArgv: ['crush', '--session', 's']
    }
    expect(applyHerdrReport(emptyHerdrPane(), session).error?.code).toBe('resume_not_accepted')
    const held = applyHerdrReport(emptyHerdrPane(), r('idle')).state
    expect(applyHerdrReport(held, session)).toMatchObject({
      applied: true,
      sessionId: 's',
      resume: ['crush', '--session', 's']
    })
    const release: HerdrReport = {
      method: 'pane.release_agent',
      paneId: 'p',
      source: 'crush',
      agent: 'crush'
    }
    const released = applyHerdrReport(held, release)
    expect(released).toMatchObject({ resume: null, released: true })
    expect(released.state.holder).toBeUndefined()
    // Someone else's release changes nothing.
    expect(applyHerdrReport(held, { ...release, source: 'x' }).released).toBeUndefined()
  })
})

describe('herdr CLI (the shim at HERDR_BIN_PATH)', () => {
  it('builds the same request as herdr pane report-agent', () => {
    const parsed = parseHerdrCli([
      'pane',
      'report-agent',
      'pane-1',
      '--source=my-agent',
      '--agent',
      'my-agent',
      '--state',
      'blocked',
      '--message',
      'Allow rm -rf build?',
      '--seq',
      '18446744073709551615',
      '--agent-session-id',
      's1',
      '--',
      'my-agent',
      '--resume',
      's1'
    ])
    expect(parsed).toEqual({
      request: {
        id: 'cli:request',
        method: 'pane.report_agent',
        params: {
          pane_id: 'pane-1',
          source: 'my-agent',
          agent: 'my-agent',
          state: 'blocked',
          message: 'Allow rm -rf build?',
          agent_session_id: 's1',
          seq: 18446744073709551615n,
          resume_argv: ['my-agent', '--resume', 's1']
        }
      }
    })
    // What the shim sends parses back on the host's side.
    const sent = encodeHerdrRequest((parsed as { request: object }).request)
    expect(parseHerdrRequest(sent)?.report?.seq).toBe(18446744073709551615n)
  })

  it('release-agent and report-agent-session', () => {
    expect(
      parseHerdrCli(['pane', 'release-agent', 'p', '--source', 's', '--agent', 'a', '--seq', '3'])
    ).toMatchObject({ request: { method: 'pane.release_agent', params: { seq: 3n } } })
    expect(
      parseHerdrCli(['pane', 'report-agent-session', 'p', '--source', 's', '--agent', 'a'])
    ).toMatchObject({ request: { method: 'pane.report_agent_session' } })
  })

  it('usage errors exit 2; the rest of herdr exits 1 with a clear message', () => {
    expect(parseHerdrCli(['pane', 'report-agent', 'p', '--agent', 'a', '--state', 'idle'])).toEqual(
      { exit: 2, stderr: 'missing required --source\n' }
    )
    expect(
      parseHerdrCli(['pane', 'report-agent', 'p', '--source', 's', '--agent', 'a', '--state', 'x'])
    ).toMatchObject({ exit: 2 })
    expect(parseHerdrCli(['pane', 'report-agent', '--source', 's'])).toMatchObject({ exit: 2 })
    expect(
      parseHerdrCli(['pane', 'release-agent', 'p', '--source', 's', '--agent', 'a', '--bogus', '1'])
    ).toMatchObject({ exit: 2 })
    expect(
      parseHerdrCli([
        'pane',
        'report-agent',
        'p',
        '--source',
        's',
        '--agent',
        'a',
        '--state',
        'idle',
        '--seq',
        '-1'
      ])
    ).toMatchObject({ exit: 2 })
    const split = parseHerdrCli(['pane', 'split', 'p'])
    expect(split).toMatchObject({ exit: 1 })
    expect((split as { stderr: string }).stderr).toMatch(/only the agent state reports/)
    expect(parseHerdrCli(['--version'])).toMatchObject({ exit: 0 })
  })

  it('exits 1 on an error reply', () => {
    expect(herdrCliReply(herdrOk('cli:request'))).toEqual({ exit: 0 })
    expect(herdrCliReply(herdrError('cli:request', 'pane_not_found', 'x')).exit).toBe(1)
    expect(herdrCliReply('').exit).toBe(1)
  })
})

describe('herdr socket', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsq-ht-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('answers one request per connection (Unix socket, or the named pipe on Windows)', async () => {
    const seen: string[] = []
    const server = await startHerdrServer({
      socketPath: join(dir, 'herdr.sock'),
      unixOnWindows: false,
      handle: (requestLine) => {
        seen.push(requestLine)
        const parsed = parseHerdrRequest(requestLine)
        return parsed?.report ? herdrOk(parsed.id) : herdrUnsupported(parsed?.id ?? '', 'x')
      }
    })
    try {
      const reply = await sendHerdrRequest(server.socketPath, {
        id: 'a',
        method: 'pane.report_agent',
        params: { pane_id: 'p', source: 's', agent: 'a', state: 'idle', seq: 2n ** 63n }
      })
      expect(JSON.parse(reply)).toEqual({ id: 'a', result: { type: 'ok' } })
      expect(seen[0]).toContain(`"seq":${2n ** 63n}`)
      const other = await sendHerdrRequest(server.socketPath, { id: 'b', method: 'ping' })
      expect(JSON.parse(other).error.code).toBe('unknown_method')
    } finally {
      await server.close()
    }
  })

  it('refuses a socket path too long for AF_UNIX', async () => {
    await expect(
      startHerdrServer({ socketPath: join(dir, 'x'.repeat(120)), handle: () => '' })
    ).rejects.toThrow(/too long/)
  })
})

describe('herdr reports in the status hub', () => {
  const harness = new Map<string, HarnessId>()
  const events: AgentHookEvent[] = []
  const resumes = new Map<string, readonly string[] | null>()
  const sessions = new Map<string, string>()
  beforeAll(() => {
    configureStatusHub({
      harnessOf: (id) => harness.get(id),
      dangerousModeOf: () => false,
      onSessionId: (id, session) => sessions.set(id, session),
      onResumeCommand: (id, argv) => resumes.set(id, argv),
      onStatus: (event) => events.push(event)
    })
  })
  let n = 0
  const agent = (kind: HarnessId = 'command'): string => {
    n += 1
    const id = `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`
    harness.set(id, kind)
    emitPtySpawn(id, 1, { harness: kind, cols: 80, rows: 24 })
    return id
  }
  const send = (id: string, text: string): unknown =>
    receiveHerdrReport(id, parseHerdrRequest(text)!.report!)
  const published = (id: string): string[] =>
    events.filter((e) => e.agentId === id).map((e) => `${e.kind}${e.detail ? `:${e.detail}` : ''}`)

  it('a plain command that reports: idle, working, needs you with the question, finished', () => {
    const id = agent()
    // Its start-up output alone would read as working (the terminal heuristic)…
    emitPtyData(id, 1, 'booting')
    expect(agentStatusSnapshot(id)?.kind).toBe('working')
    // …until it registers: then its own reports are the status.
    send(id, report('idle', { seq: 1, agent_session_id: 'sess' }))
    expect(agentStatusSnapshot(id)?.kind).toBe('idle')
    emitPtyData(id, 1, 'drawing the prompt')
    expect(agentStatusSnapshot(id)?.kind).toBe('idle')
    send(id, report('working', { seq: 2 }))
    send(id, report('blocked', { seq: 3, message: 'Crush wants to run: mkdir x' }))
    expect(agentStatusSnapshot(id)).toMatchObject({
      kind: 'needs-input',
      detail: 'Crush wants to run: mkdir x'
    })
    noteUserInput(id, 'y')
    send(id, report('working', { seq: 4 }))
    send(id, report('idle', { seq: 5, resume_argv: ['crush', '--session', 'sess'] }))
    expect(published(id)).toEqual([
      'working',
      'idle',
      'working',
      'needs-input:Crush wants to run: mkdir x',
      'working',
      'finished'
    ])
    expect(sessions.get(id)).toBe('sess')
    expect(resumes.get(id)).toEqual(['crush', '--session', 'sess'])
    // A release forgets the resume command; the process exit ends the herdr state.
    send(id, line('pane.release_agent', { pane_id: 'p', source: 'crush', agent: 'crush', seq: 6 }))
    expect(resumes.get(id)).toBeNull()
    emitPtyExit(id, 1)
    expect(send(id, report('working', { seq: 7 }))).toBeNull()
    expect(agentStatusSnapshot(id)).toBeNull()
  })

  it("a working right after blocked, nothing typed, is Crush's echo, not an answer", () => {
    const id = agent()
    send(id, report('idle', { seq: 1 }))
    send(id, report('working', { seq: 2 }))
    send(id, report('blocked', { seq: 3 }))
    send(id, report('working', { seq: 4 }))
    expect(agentStatusSnapshot(id)?.kind).toBe('needs-input')
    // The person answers: their key moves it on, and the agent's own reports count again.
    noteUserInput(id, '\r')
    expect(agentStatusSnapshot(id)?.kind).toBe('working')
    send(id, report('blocked', { seq: 5, message: 'again?' }))
    noteUserInput(id, 'y')
    send(id, report('working', { seq: 6 }))
    send(id, report('idle', { seq: 7 }))
    expect(published(id).slice(-3)).toEqual(['needs-input:again?', 'working', 'finished'])
  })

  it("a working right after the turn ended, nothing sent, is Crush's late message, not a turn", () => {
    const id = agent()
    send(id, report('idle', { seq: 1 }))
    send(id, report('working', { seq: 2 }))
    send(id, report('idle', { seq: 3 }))
    send(id, report('working', { seq: 4 }))
    expect(agentStatusSnapshot(id)?.kind).toBe('finished')
    // A prompt sent into it: the next working is a new turn.
    emitPtySubmit(id)
    send(id, report('working', { seq: 5 }))
    expect(agentStatusSnapshot(id)?.kind).toBe('working')
  })

  it('an unknown state alone leaves the output heuristic on', () => {
    const id = agent()
    send(id, report('unknown', { seq: 1 }))
    expect(agentStatusSnapshot(id)).toBeNull()
    emitPtyData(id, 1, 'output')
    expect(agentStatusSnapshot(id)?.kind).toBe('working')
  })

  it('reports for a harness with its own integration are ignored', () => {
    const id = agent('claude-code')
    expect(send(id, report('working', { seq: 1 }))).toBeNull()
    expect(agentStatusSnapshot(id)).toBeNull()
  })

  it('answers a resume command from a source that does not hold the pane with an error', () => {
    const id = agent()
    expect(
      send(
        id,
        line('pane.report_agent_session', {
          pane_id: 'p',
          source: 'crush',
          agent: 'crush',
          resume_argv: ['crush']
        })
      )
    ).toMatchObject({ code: 'resume_not_accepted' })
  })
})

describe('herdr in a plain command launch', () => {
  it('tells the command it runs in a herdr pane', () => {
    const plan = prepareCommandLaunch({
      agent: { id: 'a', harness: 'command', command: ['crush', '--yolo'] },
      executable: '/usr/bin/crush',
      cwd: '/w',
      hookBase: 'http://127.0.0.1:1/hook/t/a',
      layerDir: '/l',
      resumed: false,
      herdr: { paneId: 'a.h', socketPath: '/tmp/s.sock', binPath: '/n/herdr' }
    })
    expect(plan.args).toEqual(['--yolo'])
    expect(plan.env).toEqual({
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'a.h',
      HERDR_SOCKET_PATH: '/tmp/s.sock',
      HERDR_BIN_PATH: '/n/herdr'
    })
  })
})
