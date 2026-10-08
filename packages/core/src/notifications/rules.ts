// When a status change should notify the person. One notification per agent
// at a time: a newer one replaces it, and it is withdrawn the moment the
// agent works again (the person answered in the terminal) or goes idle.
import type { AgentHookEvent } from '../status/types.js'

export type NotificationDecision =
  { action: 'show'; kind: 'needs-input' | 'finished'; detail?: string } | { action: 'close' } | null

export function decideNotification(event: AgentHookEvent): NotificationDecision {
  if (event.kind === 'working' || event.kind === 'idle') return { action: 'close' }
  // A repeat with new wording updates what is shown, without ringing again.
  if (event.quiet) return null
  if (event.kind === 'needs-input') {
    return {
      action: 'show',
      kind: 'needs-input',
      ...(event.detail ? { detail: event.detail } : {})
    }
  }
  return { action: 'show', kind: 'finished', ...(event.detail ? { detail: event.detail } : {}) }
}

/** The notification's text. English, like the harnesses' own wording. */
export function notificationText(
  agentName: string,
  kind: 'needs-input' | 'finished',
  detail?: string
): { title: string; body: string } {
  if (kind === 'needs-input') {
    return { title: `${agentName} needs you`, body: detail ?? 'Waiting for your answer' }
  }
  return { title: `${agentName} finished`, body: detail ?? 'The turn is done' }
}
