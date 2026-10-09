// `nsq update [--check]` and the update lines of `nsq --version` / `nsq doctor`.
import { flagBool, type ParsedArgs } from '../args.js'
import { DaemonClient, daemonRunning } from '../client/client.js'
import { readConfig } from '../config.js'
import { paths } from '../paths.js'
import { PACKAGE_DIR, PACKAGE_NAME, VERSION } from '../version.js'
import { describeUpdate } from './describe.js'
import { Updater, type UpdateView } from './updater.js'

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`)
}

function localUpdater(): Updater {
  return new Updater({
    version: VERSION,
    name: PACKAGE_NAME,
    packageDir: PACKAGE_DIR,
    home: paths.home(),
    config: () => readConfig()
  })
}

/**
 * `nsq update`: check now and install now. With a daemon running, the daemon does it (the
 * dashboard shows the progress, and it restarts onto the new version once nothing is busy);
 * without one, right here, with the installer's output in this terminal.
 */
export async function cmdUpdate(args: ParsedArgs): Promise<void> {
  const checkOnly = flagBool(args, 'check')
  if ((await daemonRunning()) && (await viaDaemon(checkOnly))) return
  const updater = localUpdater()
  const checked = await updater.check(true)
  if (checkOnly || checked.state !== 'available' || !checked.canInstall || checked.reason) {
    for (const line of describeUpdate(checked)) out(line)
    return
  }
  out(`installing ${checked.latest} with ${checked.manager}…`)
  const done = await updater.install({
    foreground: true,
    onOutput: (text) => process.stdout.write(text)
  })
  if (done.state === 'installed') {
    out(`nsq ${done.installed} is installed`)
    if (await daemonRunning()) {
      out(
        'the running daemon is older: nsq down && nsq up restarts it (agents resume on their sessions)'
      )
    }
    return
  }
  for (const line of describeUpdate(done)) out(line)
  if (done.state === 'failed') process.exitCode = 1
}

/** Through the daemon; false when it is older than updates (it does not know the request). */
async function viaDaemon(checkOnly: boolean): Promise<boolean> {
  const client = await DaemonClient.open('update', { autostart: false })
  try {
    let checked: UpdateView
    try {
      checked = (await client.request<{ update: UpdateView }>({ t: 'update', action: 'check' }))
        .update
    } catch (error) {
      if (error instanceof Error && error.message === 'unknown request') return false
      throw error
    }
    if (checkOnly || checked.state !== 'available' || !checked.canInstall || checked.reason) {
      for (const line of describeUpdate(checked)) out(line)
      return true
    }
    out(`installing ${checked.latest} with ${checked.manager}… (log: ${paths.updateLog()})`)
    const done = (await client.request<{ update: UpdateView }>({ t: 'update', action: 'install' }))
      .update
    for (const line of describeUpdate(done)) out(line)
    if (done.state === 'failed') process.exitCode = 1
    return true
  } finally {
    client.close()
  }
}

/** After `nsq --version` on a terminal: a newer release, from the last check (no network). */
export function versionNotice(): string | null {
  try {
    const view = localUpdater().cachedView()
    if (view.state === 'available' && view.latest) {
      return `update available: ${view.current} → ${view.latest} (nsq update)`
    }
  } catch {
    // never in the way of --version
  }
  return null
}

/** `nsq doctor`: the daemon's view when it runs, else this copy's from the last check. */
export async function doctorUpdateLines(): Promise<string[]> {
  let view: UpdateView | undefined
  if (await daemonRunning()) {
    try {
      const client = await DaemonClient.open('doctor', { autostart: false })
      try {
        view = (await client.request<{ update: UpdateView }>({ t: 'update', action: 'status' }))
          .update
      } finally {
        client.close()
      }
    } catch {
      view = undefined
    }
  }
  view ??= localUpdater().cachedView()
  return describeUpdate(view)
}
