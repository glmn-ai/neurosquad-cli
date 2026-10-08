// A read-only view of every pty's lifecycle and output for consumers other
// than the client showing the terminal: the status hub (../status/hub.ts) and
// the screen mirror (./screenMirror.ts). Dependency-free on purpose, so any
// module can observe without importing the pty host.
export interface PtySpawnInfo {
  /**
   * The agent's harness at spawn — lets an observer that only cares about one
   * harness ignore everyone else's output without a store lookup per chunk.
   */
  harness?: string
  cols: number
  rows: number
}

export interface PtyObserver {
  /** A real OS process was spawned. */
  onSpawn(agentId: string, generation: number, info: PtySpawnInfo): void
  onData(agentId: string, generation: number, chunk: string): void
  onExit(agentId: string, generation: number): void
  onResize?(agentId: string, cols: number, rows: number): void
  /** Something submitted input (a chunk with Enter in it) — a real keystroke or a programmatic send. */
  onSubmit?(agentId: string): void
  /** The host interrupted the turn itself (interruptPty — the budget brake, a agent's stop). */
  onInterrupt?(agentId: string): void
  /**
   * Input written to the pty through writeToPty/submitToPty (keys, pastes,
   * programmatic prompts; `programmatic` = submitToPty). For the workspace
   * session recording — not the trust-dialog auto-answers.
   */
  onInput?(agentId: string, data: string, programmatic: boolean): void
}

const observers = new Set<PtyObserver>()

export function observePtys(observer: PtyObserver): () => void {
  observers.add(observer)
  return () => observers.delete(observer)
}

// Observers are side features; one throwing must never break the terminal
// itself (these run inside node-pty's own callbacks).
function notify(run: (observer: PtyObserver) => void): void {
  for (const observer of observers) {
    try {
      run(observer)
    } catch (error) {
      console.error('ptyEvents: observer threw (non-fatal)', error)
    }
  }
}

export const emitPtySpawn = (agentId: string, generation: number, info: PtySpawnInfo): void =>
  notify((observer) => observer.onSpawn(agentId, generation, info))
export const emitPtyData = (agentId: string, generation: number, chunk: string): void =>
  notify((observer) => observer.onData(agentId, generation, chunk))
export const emitPtyExit = (agentId: string, generation: number): void =>
  notify((observer) => observer.onExit(agentId, generation))
export const emitPtyResize = (agentId: string, cols: number, rows: number): void =>
  notify((observer) => observer.onResize?.(agentId, cols, rows))
export const emitPtySubmit = (agentId: string): void =>
  notify((observer) => observer.onSubmit?.(agentId))
export const emitPtyInterrupt = (agentId: string): void =>
  notify((observer) => observer.onInterrupt?.(agentId))
export const emitPtyInput = (agentId: string, data: string, programmatic: boolean): void =>
  notify((observer) => observer.onInput?.(agentId, data, programmatic))
