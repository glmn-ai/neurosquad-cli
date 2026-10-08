// `nsq attach <agent>`: the agent's own terminal, full screen and untouched.
// Every key goes to the agent (Ctrl+C included) except the detach key
// (Ctrl+] by default). The screen starts from the daemon's copy, then follows
// live; the agent's terminal takes this window's size while attached.
import type { DaemonClient } from './client/client.js'
import type { AgentView, DaemonEvent } from './protocol.js'

/** Ctrl+] — the detach key. */
export const DETACH_KEY = '\x1d'

/**
 * Where the detach key is in a chunk of input: as its control byte, or — when
 * the agent switched the terminal to an extended keyboard mode — as kitty's
 * CSI u (`ESC [ 93 ; 5 u`, with optional event type) or xterm's
 * modifyOtherKeys (`ESC [ 27 ; 5 ; 93 ~`). Returns its start and length, or null.
 */
export function findDetachKey(text: string, key: string): { at: number; length: number } | null {
  const code = key.charCodeAt(0) + 64
  const patterns = [
    new RegExp(`\\x1b\\[(?:${code}|${code + 32});5(?::[12])?u`),
    new RegExp(`\\x1b\\[27;5;(?:${code}|${code + 32})~`)
  ]
  const plain = text.indexOf(key)
  let best: { at: number; length: number } | null = plain === -1 ? null : { at: plain, length: 1 }
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match && (!best || match.index < best.at))
      best = { at: match.index, length: match[0].length }
  }
  return best
}

/** A key release report (kitty event type 3) — never forwarded once detached. */
// eslint-disable-next-line no-control-regex -- a terminal key report
const RELEASE = /\x1b\[[0-9;]*:3u/g

/** `ctrl+]`, `ctrl+a`… → the byte the terminal sends. */
export function parseDetachKey(spec: string | undefined): string {
  if (!spec) return DETACH_KEY
  const match = /^ctrl\+(.)$/i.exec(spec.trim())
  if (!match) return DETACH_KEY
  const code = match[1].toUpperCase().charCodeAt(0)
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : DETACH_KEY
}

export interface AttachOptions {
  detachKey?: string
  /** Called with a status line when another agent needs the person (shown in the window title). */
  onOthers?: (count: number) => void
}

/** Leaves the agent's terminal modes behind: mouse, bracketed paste, focus reports, kitty
 * keyboard flags, modifyOtherKeys, alternate screen, cursor, colours, title. */
const RESET_MODES =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[>4m\x1b[?1049l\x1b[?25h\x1b[0m\x1b]0;\x07'

/** Signals that end the process while attached (Ctrl+C goes to the agent in raw mode). */
const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP']

/** Attaches until detached or the agent exits. Resolves `detached` or `exited`. */
export function attach(
  client: DaemonClient,
  agent: AgentView,
  options: AttachOptions = {}
): Promise<'detached' | 'exited'> {
  const detach = options.detachKey ?? DETACH_KEY
  const stdin = process.stdin
  const stdout = process.stdout
  const agents = new Map<string, AgentView>()
  return new Promise((resolve) => {
    let done = false
    let started = false
    let lastOthers = -1
    // Rewritten only when the count changes: a title between two chunks of the
    // agent's output could land inside one of its escape sequences.
    const title = (): void => {
      const others = [...agents.values()].filter(
        (a) => a.id !== agent.id && a.status === 'needs-input'
      )
      if (others.length === lastOthers) return
      lastOthers = others.length
      stdout.write(
        `\x1b]0;nsq · ${agent.name}${others.length ? ` · ${others.length} other${others.length > 1 ? 's' : ''} need${others.length > 1 ? '' : 's'} you` : ''}\x07`
      )
    }
    const resize = (): void => {
      const cols = stdout.columns || 80
      const rows = stdout.rows || 24
      client.post({ t: 'resize', id: agent.id, cols, rows })
    }
    const finish = (how: 'detached' | 'exited'): void => {
      if (done) return
      done = true
      process.off('exit', restoreOnExit)
      for (const signal of SIGNALS) process.off(signal, onSignal)
      off()
      stdin.off('data', onKey)
      stdout.off('resize', resize)
      if (stdin.isTTY) stdin.setRawMode(false)
      stdin.pause()
      stdout.write(RESET_MODES)
      resolve(how)
    }
    const onKey = (data: Buffer | string): void => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      const found = findDetachKey(text, detach)
      if (found) {
        const before = text.slice(0, found.at).replace(RELEASE, '')
        if (before) client.post({ t: 'input', id: agent.id, data: before })
        finish('detached')
        return
      }
      client.post({ t: 'input', id: agent.id, data: text })
    }
    const off = client.on((event: DaemonEvent) => {
      switch (event.t) {
        case 'screen':
          if (event.id !== agent.id) return
          started = true
          stdout.write('\x1b[0m\x1b[2J\x1b[3J\x1b[H')
          stdout.write(event.data)
          return
        case 'data':
          if (event.id === agent.id && started) stdout.write(event.data)
          return
        case 'exit':
          if (event.id === agent.id) finish('exited')
          return
        case 'agents':
          for (const a of event.agents) agents.set(a.id, a)
          title()
          return
        case 'agent':
          agents.set(event.agent.id, event.agent)
          title()
          return
        case 'notify':
          // Another agent: ring the bell so the person knows without detaching.
          if (event.id !== agent.id) stdout.write('\x07')
          return
      }
    })
    // Killed while attached (a signal, an uncaught error): the terminal still comes back.
    const restoreOnExit = (): void => {
      if (done) return
      try {
        if (stdin.isTTY) stdin.setRawMode(false)
        stdout.write(RESET_MODES)
      } catch {
        // The terminal is gone.
      }
    }
    const onSignal = (signal: NodeJS.Signals): void => {
      process.exitCode = 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15)
      finish('exited')
      client.close()
    }
    process.on('exit', restoreOnExit)
    for (const signal of SIGNALS) process.on(signal, onSignal)
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onKey)
    stdout.on('resize', resize)
    resize()
    void client
      .request({ t: 'subscribe', agents: [agent.id], output: [agent.id] })
      .catch(() => finish('exited'))
    // The daemon went away (stopped, crashed): never leave the terminal raw on a frozen screen.
    client.onClose(() => finish('exited'))
  })
}
