// Desktop notifications for the daemon, through @neurosquad/notify (native
// toasts and sound per OS, terminal fallback): one per agent, replaced by a
// newer one, withdrawn when the agent works again.
import { createNotifier as createNativeNotifier, type NotificationKind } from '@neurosquad/notify'

export interface Notifier {
  /** Whether a native notification can be shown here (else the dashboard rings its terminal). */
  native(): Promise<boolean>
  show(agentId: string, title: string, body: string, kind: NotificationKind, sound: boolean): void
  close(agentId: string): void
  dispose(): Promise<void>
}

export function createNotifier(enabled: boolean, muted = false): Notifier {
  if (!enabled || process.env['NSQ_NO_NOTIFY'] === '1') {
    return { native: async () => false, show() {}, close() {}, dispose: async () => {} }
  }
  const native = createNativeNotifier({
    appName: 'nsq (NeuroSquad)',
    appId: 'NeuroSquad.nsq',
    muted,
    // The daemon has no terminal of its own: the dashboard rings its terminal itself.
    terminal: { mode: 'never' }
  })
  return {
    native: async () => (await native.status()).backend !== null,
    show: (agentId, title, body, kind, sound) =>
      void native.show({ id: agentId, title, body, kind, sound }),
    close: (agentId) => void native.withdraw(agentId),
    dispose: () => native.dispose()
  }
}
