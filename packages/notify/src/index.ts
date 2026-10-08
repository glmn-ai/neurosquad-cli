// @neurosquad/notify — native desktop notifications and sound for nsq, without Electron.
export { createNotifier } from './notifier.js'
export type {
  BackendName,
  NotificationKind,
  Notifier,
  NotifierOptions,
  NotifierStatus,
  ShowRequest,
  ShowResult,
  TerminalOptions,
  TerminalProtocol
} from './types.js'
export { detectTerminalProtocol, formatTerminalSignal } from './terminal.js'
export { bundledSound } from './assets.js'
