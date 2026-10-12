// Everything that goes into an agent's terminal as input — typed keys, a paste, a submitted
// prompt, an answer's keys, an interrupt — goes through AgentInput. Input is activity: each of
// them also ends a quiet episode (and restarts the quiet clock), credited to whoever sent it, so
// a new way to reach the pty cannot forget to. The daemon keeps the pty host's input methods out
// of its own reach (`PtyControl`); terminal replies (DA, CPR) are not input and go straight to
// the pty.
import { noteUserInput, type PtyHost } from '@neurosquad/core'
import type { ApprovalBy } from './approvals.js'
import { typedByPerson } from './quiet.js'

/** The pty host's methods that put input into an agent. */
export type PtyInputMethod = 'write' | 'paste' | 'submit' | 'interrupt'

/** The pty host without its input methods: what the daemon holds for everything else. */
export type PtyControl = Omit<PtyHost, PtyInputMethod>

export type InputPty = Pick<PtyHost, PtyInputMethod | 'isRunning'>

/** Where input is reported as activity (the daemon's QuietMonitor). */
export interface InputActivity {
  activity(agentId: string, how: 'input', by?: ApprovalBy): void
}

export interface AgentInputOptions {
  /** Keys typed by a person, for the status machine (default: @neurosquad/core's). */
  noteKeys?: (agentId: string, data: string) => void
  wait?: (ms: number) => Promise<void>
}

export class AgentInput {
  private readonly noteKeys: (agentId: string, data: string) => void
  private readonly wait: (ms: number) => Promise<void>

  constructor(
    private readonly pty: InputPty,
    private readonly quiet: InputActivity,
    options: AgentInputOptions = {}
  ) {
    this.noteKeys = options.noteKeys ?? noteUserInput
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Activity first: input can move the agent on synchronously (an interrupt, an answer key),
   * and the quiet episode is then credited to whoever sent it, not to the status change.
   */
  private touch(agentId: string, by: ApprovalBy | undefined): void {
    this.quiet.activity(agentId, 'input', by)
  }

  /** Keys as the person typed them (an attached terminal, the dashboard). */
  keys(agentId: string, data: string, by?: ApprovalBy): void {
    // A focus report is the terminal talking, not a person: it does not end an episode.
    if (typedByPerson(data)) this.touch(agentId, by)
    this.pty.write(agentId, data)
    this.noteKeys(agentId, data)
  }

  /**
   * An answer's key presses (`answerKeys`), `gapMs` apart — the dashboard's y/a/n, `nsq answer`,
   * the phone. Throws when the agent stops between two presses.
   */
  async answer(
    agentId: string,
    presses: readonly string[],
    by: ApprovalBy,
    gapMs: number,
    name: string = agentId
  ): Promise<void> {
    for (const [index, press] of presses.entries()) {
      if (index > 0) await this.wait(gapMs)
      if (!this.pty.isRunning(agentId)) throw new Error(`${name} is not running`)
      this.keys(agentId, press, by)
    }
  }

  /** Text pasted into the input without submitting it (dictation). False: not running. */
  paste(agentId: string, text: string, by?: ApprovalBy): boolean {
    if (!this.pty.isRunning(agentId)) return false
    this.touch(agentId, by)
    return this.pty.paste(agentId, text)
  }

  /** A whole prompt, submitted (`nsq send`, the phone, the queue, a first prompt). */
  submit(agentId: string, text: string, by?: ApprovalBy): boolean {
    if (!this.pty.isRunning(agentId)) return false
    this.touch(agentId, by)
    return this.pty.submit(agentId, text)
  }

  /** The harness's interrupt keys. */
  interrupt(agentId: string, keys: string | readonly string[], by?: ApprovalBy): void {
    if (!this.pty.isRunning(agentId)) return
    this.touch(agentId, by)
    this.pty.interrupt(agentId, keys)
  }
}
