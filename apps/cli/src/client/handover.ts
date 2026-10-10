// A newer nsq meeting an older daemon. The daemon is a long-lived process: upgrading the package
// (npx picking a new release, `npm i -g`) does not replace a daemon that is already running, so
// its fixes never run until it restarts. Whichever client connects first with a newer copy hands
// the daemon over to it — the update path's way: the new daemon starts first and waits for the old
// one to exit, the agents resume on their sessions. Never while an agent is busy (U: now).
import type { AgentView } from '../protocol.js'
import { compareVersions, isDevVersion } from '../update/semver.js'
import type { UpdateView } from '../update/updater.js'
import { VERSION } from '../version.js'
import { DaemonClient, binScript, readState, spawnDaemon } from './client.js'

export type Handover =
  /** Nothing to do: the daemon runs this version (or a newer one, or a dev build). */
  | { kind: 'current' }
  /** The daemon now runs this version; `client` is connected to it (the old one is closed). */
  | { kind: 'restarted'; client: DaemonClient; from: string }
  /**
   * Busy agents hold it (`busy`: why, one phrase each). `byDaemon`: the daemon (0.2.1+) does it by itself once they are free;
   * otherwise (older daemons) the next nsq that connects does.
   */
  | { kind: 'waiting'; from: string; busy: string[]; byDaemon: boolean }

/** True when this copy is newer than the daemon `client` talks to (released versions only). */
export function daemonIsOlder(daemonVersion: string, version = VERSION): boolean {
  if (!daemonVersion || isDevVersion(daemonVersion) || isDevVersion(version)) return false
  return compareVersions(daemonVersion, version) < 0
}

/** The agents a restart would cut off: working, waiting for an answer, or with prompts queued. */
export function busyAgents(agents: readonly AgentView[]): string[] {
  return agents
    .filter(
      (agent) =>
        agent.running &&
        (agent.status === 'working' || agent.status === 'needs-input' || (agent.queued ?? 0) > 0)
    )
    .map((agent) => agent.name)
}

/** What a person reads about a hand-over that waits. */
export function waitingText(wait: Extract<Handover, { kind: 'waiting' }>): string {
  const when = wait.byDaemon
    ? 'it restarts on it when they are free'
    : 'it restarts on it at the next nsq command once they are free'
  return `the daemon is ${wait.from}, this nsq is ${VERSION} — ${when} (${wait.busy.join('; ')}; nsq down && nsq up restarts it now)`
}

/**
 * Hands the daemon over to this copy when it is older. `now`: even with busy agents (their turn
 * is cut off; they resume on their sessions). Leaves `client` open unless it returns `restarted`.
 */
export async function handOver(
  client: DaemonClient,
  clientName: string,
  options: { now?: boolean } = {}
): Promise<Handover> {
  const from = client.daemonVersion
  if (!daemonIsOlder(from)) return { kind: 'current' }
  let byDaemon: { restarting?: boolean; waitingFor?: string[]; current?: boolean } | null
  try {
    byDaemon = await client.request({
      t: 'handover',
      node: process.execPath,
      script: binScript(),
      version: VERSION,
      ...(options.now ? { now: true } : {})
    })
  } catch (error) {
    // Daemons before 0.2.1 do not know the request: the client does it (below).
    if (!(error instanceof Error && error.message === 'unknown request')) throw error
    byDaemon = null
  }
  if (byDaemon) {
    if (byDaemon.current) return { kind: 'current' }
    if (!byDaemon.restarting) {
      return { kind: 'waiting', from, busy: byDaemon.waitingFor ?? [], byDaemon: true }
    }
    client.close()
    return {
      kind: 'restarted',
      client: await connectTo(VERSION, client.daemonPid, clientName),
      from
    }
  }

  // An older daemon. If its updater already installed exactly this version, it restarts on it by
  // its own rules (quiet hours, open windows): leave that to it.
  try {
    const status = await client.request<{ update?: UpdateView }>({ t: 'update', action: 'status' })
    if (status.update?.installed === VERSION) return { kind: 'current' }
  } catch {
    // 0.1.0 had no updater
  }
  const agents = await client.request<AgentView[]>({ t: 'list' })
  const busy = busyAgents(agents)
  if (busy.length && !options.now) {
    return { kind: 'waiting', from, busy: busy.map((name) => `${name} is busy`), byDaemon: false }
  }
  // The new daemon first: it waits for the old one to exit (the lock), then resumes the agents
  // (they keep `wantRunning` through a shutdown) — exactly `nsq down` + `nsq up`.
  spawnDaemon(client.daemonPid)
  await client.request({ t: 'shutdown', stopAgents: true }).catch(() => {})
  client.close()
  return { kind: 'restarted', client: await connectTo(VERSION, client.daemonPid, clientName), from }
}

/** Waits for the daemon of `version` (not `oldPid`) to answer, and connects to it. */
export async function connectTo(
  version: string,
  oldPid: number,
  clientName: string,
  ms = 90_000
): Promise<DaemonClient> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const state = readState()
    if (!state || state.pid === oldPid || state.version !== version) continue
    try {
      const client = await DaemonClient.open(clientName, { autostart: false })
      if (client.daemonPid !== oldPid && client.daemonVersion === version) return client
      client.close()
    } catch {
      // not up yet
    }
  }
  throw new Error(`the nsq daemon did not come back on ${version} (see the daemon log)`)
}

/**
 * Connects for a command: an older daemon is handed over to this copy first when nothing is busy;
 * otherwise a note on stderr and the command runs on the daemon as it is.
 */
export async function openCurrent(
  clientName: string,
  options: { autostart?: boolean } = {}
): Promise<DaemonClient> {
  const client = await DaemonClient.open(clientName, options)
  if (process.env['NSQ_NO_HANDOVER'] === '1') return client
  let result: Handover
  try {
    result = await handOver(client, clientName)
  } catch (error) {
    process.stderr.write(`nsq: could not restart the daemon on ${VERSION}: ${String(error)}\n`)
    return client.isClosed ? DaemonClient.open(clientName, options) : client
  }
  switch (result.kind) {
    case 'current':
      return client
    case 'restarted':
      process.stderr.write(
        `nsq: the daemon was ${result.from}; it now runs ${VERSION} (agents resume on their sessions)\n`
      )
      return result.client
    case 'waiting':
      process.stderr.write(`nsq: ${waitingText(result)}\n`)
      return client
  }
}
