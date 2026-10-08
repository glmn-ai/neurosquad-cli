// `nsq attach <agent>`: the agent's own terminal, full screen and untouched.
// Every key goes to the agent (Ctrl+C included) except the detach key
// (Ctrl+] by default). The screen starts from the daemon's copy, then follows
// live; the agent's terminal takes this window's size while attached.
import type { DaemonClient } from './client/client.js'
import type { AgentView, DaemonEvent } from './protocol.js'

/** Ctrl+] — the detach key. */
export const DETACH_KEY = '\x1d'

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
    const title = (): void => {
      const others = [...agents.values()].filter(
        (a) => a.id !== agent.id && a.status === 'needs-input'
      )
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
      off()
      stdin.off('data', onKey)
      stdout.off('resize', resize)
      if (stdin.isTTY) stdin.setRawMode(false)
      stdin.pause()
      // Leave the agent's screen modes behind: mouse, bracketed paste, alternate screen, cursor.
      stdout.write(
        '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m\x1b]0;\x07'
      )
      resolve(how)
    }
    const onKey = (data: Buffer | string): void => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      const at = text.indexOf(detach)
      if (at !== -1) {
        if (at > 0) client.post({ t: 'input', id: agent.id, data: text.slice(0, at) })
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
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onKey)
    stdout.on('resize', resize)
    resize()
    void client
      .request({ t: 'subscribe', agents: [agent.id], output: [agent.id] })
      .catch(() => finish('exited'))
  })
}
