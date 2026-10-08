// An in-memory PhoneHost for tests: agents are plain records, every call is recorded.
import {
  PhoneHostError,
  type PhoneAnswer,
  type PhoneHost,
  type PhoneHostAgent,
  type PhoneHostEvent
} from '../phone/types.js'

export interface FakeHostCall {
  kind: 'submit' | 'answer' | 'interrupt' | 'screen'
  agentId: string
  value?: string | number
}

export class FakePhoneHost implements PhoneHost {
  readonly agents: PhoneHostAgent[] = []
  readonly calls: FakeHostCall[] = []
  readonly screens = new Map<string, string>()
  private readonly listeners = new Set<(event: PhoneHostEvent) => void>()

  listAgents(): PhoneHostAgent[] {
    return this.agents.map((agent) => ({ ...agent }))
  }

  screen(agentId: string, lines: number): string | null {
    this.calls.push({ kind: 'screen', agentId, value: lines })
    const text = this.screens.get(agentId)
    return text === undefined ? null : text.split('\n').slice(-lines).join('\n')
  }

  submit(agentId: string, text: string): void {
    const agent = this.agents.find((entry) => entry.id === agentId)
    if (agent?.status === 'needs-input') {
      throw new PhoneHostError('busy', `${agent.name} is waiting for an answer`)
    }
    this.calls.push({ kind: 'submit', agentId, value: text })
  }

  answer(agentId: string, answer: PhoneAnswer): void {
    this.calls.push({ kind: 'answer', agentId, value: answer })
  }

  interrupt(agentId: string): void {
    this.calls.push({ kind: 'interrupt', agentId })
  }

  subscribe(listener: (event: PhoneHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: PhoneHostEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  listenerCount(): number {
    return this.listeners.size
  }
}
