// A client newer than the running daemon. The daemon is long-lived: upgrading the package does not
// replace it until it restarts (the hand-over waits for busy agents), so for a while a newer
// dashboard or command can ask for something the daemon does not know yet. That must never show
// as a bare "unknown request": it says which daemon runs, what the request needs and how to get
// there — U in the dashboard, `nsq down && nsq up` on the command line, or wait for the agents.
import { CAPABILITY_SINCE, UNKNOWN_REQUEST, type Capability } from '../protocol.js'
import { compareVersions, isDevVersion } from '../update/semver.js'
import { VERSION } from '../version.js'

/** Where the explanation is read: the dashboard (U restarts) or a shell. */
export type OutdatedWhere = 'tui' | 'cli'

/** A request the running daemon does not know (it said so, or its hello / version shows it). */
export class DaemonTooOldError extends Error {
  readonly code = 'daemon-too-old'
  constructor(
    /** The running daemon's version ('' when unknown). */
    readonly daemonVersion: string,
    /** The first release that knows the request (this copy's version when not known). */
    readonly needs: string,
    /** What was asked (the request type, or the capability). */
    readonly what: string
  ) {
    super(outdatedText(daemonVersion, needs, 'cli'))
    this.name = 'DaemonTooOldError'
  }
}

/** The release a capability first shipped in; this copy's version for one it does not name. */
export function capabilityNeeds(capability: string | undefined): string {
  return (capability && CAPABILITY_SINCE[capability as Capability]) || VERSION
}

/** Whether a daemon of `daemonVersion` (no capability list) is old enough for `capability`. */
export function versionSupports(daemonVersion: string, capability: Capability): boolean {
  // A dev build or an unknown version: try (it answers "unknown request" if it cannot).
  if (!daemonVersion || isDevVersion(daemonVersion)) return true
  return compareVersions(daemonVersion, CAPABILITY_SINCE[capability]) >= 0
}

/** An error that means "the daemon does not know this request" (old or new wording). */
export function isUnknownRequest(error: unknown): boolean {
  return (
    error instanceof DaemonTooOldError ||
    (error instanceof Error && error.message === UNKNOWN_REQUEST)
  )
}

/** The daemon can be restarted onto this copy (it runs an older release). */
function restartable(daemonVersion: string): boolean {
  return (
    Boolean(daemonVersion) &&
    !isDevVersion(daemonVersion) &&
    !isDevVersion(VERSION) &&
    compareVersions(daemonVersion, VERSION) < 0
  )
}

/**
 * The explanation: which daemon runs, what this needs, and how to restart it. `tui`: U in the
 * dashboard; `cli`: the commands that exist (`nsq down && nsq up`).
 */
export function outdatedText(daemonVersion: string, needs: string, where: OutdatedWhere): string {
  const running = daemonVersion ? `nsq ${daemonVersion}` : 'an older nsq'
  const head = `The running daemon is ${running}; this needs ${needs} or newer.`
  if (daemonVersion && !isDevVersion(daemonVersion) && compareVersions(daemonVersion, needs) >= 0) {
    // Not a matter of age (a dev build, or a request this release dropped): no restart advice.
    return `The running daemon (nsq ${daemonVersion}) does not know this request.`
  }
  if (where === 'tui' && restartable(daemonVersion)) {
    return `${head} Press U to restart it now (agents resume their sessions), or it restarts by itself when agents are free.`
  }
  if (restartable(daemonVersion)) {
    return `${head} Run \`nsq down && nsq up\` to restart it now (agents resume their sessions), or it restarts by itself when agents are free.`
  }
  return `${head} Restart it on this nsq (${VERSION}) with \`nsq down && nsq up\` (agents resume their sessions).`
}

/** An error's text for a person: the explanation for an outdated daemon, else its message. */
export function errorText(error: unknown, where: OutdatedWhere): string {
  if (error instanceof DaemonTooOldError) {
    return outdatedText(error.daemonVersion, error.needs, where)
  }
  return error instanceof Error ? error.message : String(error)
}
