// Desktop notifications for the daemon, through @neurosquad/notify (native
// toasts and sound per OS, terminal fallback): one per agent, replaced by a
// newer one, withdrawn when the agent works again.
import { createNotifier as createNativeNotifier, type NotificationKind } from '@neurosquad/notify'

export interface Notifier {
  /** Shows it; resolves where it went (`os` = a desktop notification was delivered). */
  show(
    agentId: string,
    title: string,
    body: string,
    kind: NotificationKind,
    sound: boolean
  ): Promise<'os' | 'terminal' | 'none'>
  close(agentId: string): void
  dispose(): Promise<void>
}

export function createNotifier(enabled: boolean, muted = false): Notifier {
  if (!enabled || process.env['NSQ_NO_NOTIFY'] === '1') {
    return { show: async () => 'none', close() {}, dispose: async () => {} }
  }
  const native = createNativeNotifier({
    appName: 'nsq (NeuroSquad)',
    appId: 'NeuroSquad.nsq',
    muted,
    // The daemon has no terminal of its own: the dashboard rings its terminal itself.
    terminal: { mode: 'never' }
  })
  return {
    show: async (agentId, title, body, kind, sound) => {
      try {
        return (await native.show({ id: agentId, title, body, kind, sound })).via
      } catch {
        return 'none'
      }
    },
    close: (agentId) => void native.withdraw(agentId),
    dispose: () => native.dispose()
  }
}
