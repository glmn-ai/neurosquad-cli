// The update state in words: full lines for `nsq update` / `nsq doctor`, one short phrase for the
// dashboard's header.
import type { UpdateView } from './updater.js'

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** Lines for the terminal. `daemon`: the view comes from the running daemon. */
export function describeUpdate(view: UpdateView, now = Date.now()): string[] {
  const lines: string[] = []
  const checked = view.checkedAt ? ` (checked ${ago(view.checkedAt, now)})` : ''
  const how =
    view.auto === 'off'
      ? `automatic updates are off: ${view.offReason ?? 'turned off'}`
      : view.auto === 'notify'
        ? 'automatic updates: notify only (autoUpdate: "notify")'
        : view.canInstall
          ? `automatic updates: on, through ${view.manager}`
          : `automatic updates: notify only (${view.manager}${view.reason ? `: ${view.reason}` : ''})`
  switch (view.state) {
    case 'current':
      lines.push(`nsq ${view.current} is the latest${checked}`)
      break
    case 'available':
      lines.push(`update available: ${view.current} → ${view.latest}${checked}`)
      if (view.reason) lines.push(`  ${view.reason}`)
      if (view.command) lines.push(`  run: ${view.command}`)
      break
    case 'installing':
      lines.push(`installing ${view.latest ?? 'the update'} with ${view.manager}…`)
      break
    case 'installed':
      lines.push(
        `${view.installed} is installed; the daemon runs ${view.current} until it restarts`
      )
      if (view.blockers?.length) {
        lines.push(
          `  ${view.scheduled ? 'restarts' : 'restarts by itself'} once nothing is in the way: ${view.blockers.join('; ')}`
        )
      }
      if (!view.scheduled)
        lines.push('  restart now: U in the dashboard (agents resume on their sessions)')
      break
    case 'waiting':
      lines.push(
        `update ${view.current} → ${view.latest}: ${view.reason ?? 'not available yet'}; nsq tries again later`
      )
      if (view.command) lines.push(`  or run: ${view.command}`)
      break
    case 'failed':
      lines.push(`update failed: ${view.reason ?? 'unknown error'}`)
      if (view.latest && view.command) lines.push(`  run: ${view.command}`)
      break
    case 'restarting':
      lines.push(`restarting the daemon on ${view.installed ?? view.latest}…`)
      break
    case 'checking':
      lines.push('checking for updates…')
      break
    default:
      lines.push(`nsq ${view.current}: not checked yet`)
  }
  lines.push(`  ${how}`)
  return lines
}

/** One short phrase for the dashboard header, or null when there is nothing to say. */
export function updateBadge(
  view: UpdateView | null,
  now = Date.now()
): { text: string; tone: 'info' | 'warn' } | null {
  if (!view) return null
  switch (view.state) {
    case 'available':
      return {
        text:
          view.auto === 'on' && view.canInstall && !view.reason
            ? `update ${view.current} → ${view.latest}`
            : `update ${view.current} → ${view.latest} · nsq update`,
        tone: 'info'
      }
    case 'installing':
      return { text: `update ${view.current} → ${view.latest} · installing…`, tone: 'info' }
    case 'installed':
      return {
        text: view.scheduled
          ? `updated to ${view.installed} · restarts when idle`
          : `updated to ${view.installed} · U restart`,
        tone: 'info'
      }
    case 'waiting':
      return { text: `update ${view.latest}: not in ${view.manager} yet`, tone: 'info' }
    case 'failed':
      return view.latest && view.latest !== view.current
        ? { text: `update failed: ${view.reason ?? 'see nsq update'} · nsq update`, tone: 'warn' }
        : null
    case 'restarting':
      return { text: `restarting on ${view.installed ?? view.latest}…`, tone: 'info' }
    default:
      // Just switched: said for a minute (a toast alone is easily missed or replaced).
      return view.updatedFrom && view.updatedAt !== undefined && now - view.updatedAt < 60_000
        ? { text: `updated to ${view.current} (was ${view.updatedFrom})`, tone: 'info' }
        : null
  }
}
