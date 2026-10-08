// What a paired phone may do — and, as explicitly, what it may not.
//
// The desktop keeps a BLOCKED list because its phone gets the whole app over a WebSocket and must
// be told what not to touch. nsq's phone API is the other way round: an allowlist of routes, and
// nothing exists that is not on it. `PHONE_BLOCKED` documents the deliberate gaps so a future route
// is checked against them (server.test.ts asserts every blocked write is refused).

export interface PhoneCapability {
  id: string
  method: 'GET' | 'POST'
  /** Route pattern; `:id` is an agent or workspace id. */
  path: string
  description: string
}

export const PHONE_CAPABILITIES: readonly PhoneCapability[] = [
  { id: 'state', method: 'GET', path: '/api/state', description: 'Agents and their status' },
  {
    id: 'workspace',
    method: 'GET',
    path: '/api/workspace/:id',
    description: 'One project and its agents'
  },
  {
    id: 'screen',
    method: 'GET',
    path: '/api/agent/:id/screen',
    description: 'Read the terminal mirror (plain text, last lines)'
  },
  {
    id: 'events',
    method: 'GET',
    path: '/api/events',
    description: 'Status and needs-you events (Server-Sent Events)'
  },
  {
    id: 'poll',
    method: 'GET',
    path: '/api/poll',
    description: 'The same events by long poll (for proxies without SSE)'
  },
  {
    id: 'prompt',
    method: 'POST',
    path: '/api/agent/:id/prompt',
    description: 'Send a prompt to a running agent'
  },
  {
    id: 'answer',
    method: 'POST',
    path: '/api/agent/:id/answer',
    description: 'Answer a permission prompt: yes, always or no'
  },
  {
    id: 'interrupt',
    method: 'POST',
    path: '/api/agent/:id/interrupt',
    description: "Stop the current turn with the harness's own interrupt key"
  },
  {
    id: 'kinds',
    method: 'GET',
    path: '/api/kinds',
    description: 'What the phone may create: always nothing (kept for desktop-shaped clients)'
  },
  {
    id: 'capabilities',
    method: 'GET',
    path: '/api/capabilities',
    description: 'This list'
  }
]

/** Things a phone can do in the desktop app or could ask for, and nsq refuses on purpose. */
export const PHONE_BLOCKED: readonly { id: string; why: string; route?: string }[] = [
  {
    id: 'create-agent',
    route: 'POST /api/agent',
    why: 'Starting a process (and choosing its command) stays at the keyboard of the machine.'
  },
  {
    id: 'create-workspace',
    route: 'POST /api/workspace',
    why: 'No filesystem paths are chosen or probed from the phone.'
  },
  {
    id: 'raw-keys',
    why: 'Arbitrary bytes into a pty (a shell is one keystroke away); only prompts, the three answers and the interrupt are sent.'
  },
  {
    id: 'remove-agent',
    why: 'Stopping, removing agents and deleting worktrees stay on the machine.'
  },
  { id: 'dangerous-mode', why: 'Permission modes and harness/model changes stay on the machine.' },
  { id: 'files', why: 'No file browsing, reading or downloading of any kind.' },
  { id: 'cloud', why: 'The cloud session and its tokens are never reachable from the phone API.' },
  {
    id: 'pairing',
    why: 'Re-keying or switching the phone server off happens only on the machine (`nsq phone` commands).'
  }
]
