// NeuroSquad phone page — served by nsq itself (`nsq phone on`), talks only to the same origin's
// /api with the pairing token. Plain DOM: every value from the server goes in through
// textContent, never as HTML. No eval, no inline script, no third-party code (see the CSP the
// server sends with this file).

const TOKEN_KEY = 'neurosquad.phone.token'
const HARNESS = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex',
  opencode: 'OpenCode',
  kilo: 'Kilo Code',
  'gemini-cli': 'Gemini CLI',
  command: 'Command'
}
const STATUS = {
  working: 'Working',
  'needs-input': 'Needs you',
  finished: 'Finished',
  idle: 'Idle',
  exited: 'Stopped'
}

const $ = (id) => document.getElementById(id)
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const state = {
  token: '',
  workspaces: [],
  agents: [],
  seq: -1,
  open: null, // the agent shown full screen
  online: false,
  pollAbort: null,
  screenTimer: 0,
  stuckToBottom: true
}

// ---- the token -------------------------------------------------------------------------------

function readToken() {
  // The pairing link is /?t=<token>: keep it on this phone, then take it out of the address bar
  // and the history so it is not shown, bookmarked or shared by accident.
  const url = new URL(location.href)
  const fromLink = url.searchParams.get('t')
  if (fromLink) {
    try {
      localStorage.setItem(TOKEN_KEY, fromLink)
    } catch {
      // Private mode without storage: this session only.
    }
    url.searchParams.delete('t')
    history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
    return fromLink
  }
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

function forgetToken(reason) {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // nothing stored
  }
  state.token = ''
  showPair(reason)
}

// ---- api ---------------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    cache: 'no-store',
    credentials: 'omit',
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  if (response.status === 401) {
    forgetToken('The pairing token is not valid any more (it may have been rotated). Pair again.')
    throw new ApiError(401, 'Not paired')
  }
  let data = null
  try {
    data = await response.json()
  } catch {
    // empty body
  }
  if (!response.ok) {
    throw new ApiError(response.status, (data && data.error) || `Error ${response.status}`)
  }
  return data
}

// ---- live state: long poll (works through proxies and tunnels that buffer event streams) ------

function setOnline(online) {
  state.online = online
  $('link').dataset.state = online ? 'live' : 'offline'
  renderTitle()
}

async function pollLoop() {
  let failures = 0
  while (state.token) {
    const controller = new AbortController()
    state.pollAbort = controller
    try {
      const data = await api(`/api/poll?since=${state.seq}`, { signal: controller.signal })
      failures = 0
      setOnline(true)
      state.seq = data.seq
      for (const event of data.events) apply(event)
      render()
    } catch (error) {
      if (!state.token) return
      if (error.name === 'AbortError') continue
      failures += 1
      setOnline(false)
      // The computer is asleep or nsq stopped: back off, up to 15 s.
      await sleep(Math.min(15000, 1000 * 2 ** Math.min(failures, 4)))
    }
  }
}

function apply(event) {
  if (event.type === 'state') {
    state.workspaces = event.state.workspaces
    state.agents = event.state.agents
  } else if (event.type === 'status') {
    const agent = state.agents.find((a) => a.id === event.agentId)
    if (agent) {
      agent.status = event.status
      if (event.status !== 'needs-input') delete agent.detail
    }
  } else if (event.type === 'attention') {
    const agent = state.agents.find((a) => a.id === event.agentId)
    if (agent && event.kind === 'needs-input') {
      agent.status = 'needs-input'
      if (event.detail) agent.detail = event.detail
      if (navigator.vibrate) navigator.vibrate([60, 40, 60])
      if (state.open !== agent.id) toast(`${agent.name || 'An agent'} needs you`)
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- views -------------------------------------------------------------------------------------

function showPair(reason) {
  $('pair').hidden = false
  $('list').hidden = true
  $('agent').hidden = true
  $('back').hidden = true
  $('pair-reason').textContent = reason || ''
  $('title').textContent = 'NeuroSquad'
  $('subtitle').textContent = 'not paired'
  $('link').dataset.state = 'offline'
  stopScreen()
}

function harnessName(id) {
  return HARNESS[id] || id
}

function renderTitle() {
  const needs = state.agents.filter((a) => a.status === 'needs-input').length
  document.title = needs ? `(${needs}) NeuroSquad` : 'NeuroSquad'
  if (state.open) return
  const working = state.agents.filter((a) => a.status === 'working').length
  const parts = []
  if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`)
  if (working) parts.push(`${working} working`)
  if (!parts.length)
    parts.push(`${state.agents.length} agent${state.agents.length === 1 ? '' : 's'}`)
  $('subtitle').textContent = state.online ? parts.join(' · ') : 'reconnecting…'
}

function render() {
  if (!state.token) return
  $('pair').hidden = true
  renderTitle()
  if (state.open) renderAgent()
  else renderList()
}

function answerButtons(agent) {
  const row = el('div', 'answers')
  for (const [key, label, kind] of [
    ['yes', 'Yes', 'primary'],
    ['always', 'Always', ''],
    ['no', 'No', 'danger']
  ]) {
    const button = el('button', `btn ${kind}`.trim(), label)
    button.type = 'button'
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      answer(agent.id, key, row)
    })
    row.append(button)
  }
  return row
}

function renderList() {
  const list = $('list')
  list.hidden = false
  $('agent').hidden = true
  $('back').hidden = true
  $('title').textContent = 'NeuroSquad'
  list.replaceChildren()
  if (!state.agents.length) {
    list.append(el('p', 'empty', 'No agents yet. Start one on the computer: nsq run claude'))
    return
  }
  const order = { 'needs-input': 0, working: 1, finished: 2, idle: 3, exited: 4 }
  for (const workspace of state.workspaces) {
    const agents = state.agents
      .filter((a) => a.workspaceId === workspace.id)
      .sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5))
    if (!agents.length) continue
    const section = el('section', 'workspace')
    section.append(el('h2', '', workspace.name))
    const cards = el('div', 'cards')
    for (const agent of agents) {
      const status = agent.running ? agent.status || 'idle' : 'exited'
      const card = el('button', `card${status === 'needs-input' ? ' needs' : ''}`)
      card.type = 'button'
      card.dataset.status = status
      const row = el('div', 'card-row')
      row.append(el('span', 'dot'), el('strong', '', agent.name || agent.id.slice(0, 8)))
      row.append(el('span', 'chip', harnessName(agent.harness)))
      row.append(el('span', 'status', STATUS[status] || status))
      card.append(row)
      if (status === 'needs-input') {
        if (agent.detail) card.append(el('p', 'question', agent.detail))
        card.append(answerButtons(agent))
      }
      card.addEventListener('click', () => openAgent(agent.id))
      cards.append(card)
    }
    section.append(cards)
    list.append(section)
  }
}

function openAgent(id) {
  state.open = id
  state.stuckToBottom = true
  $('screen').textContent = ''
  history.pushState({ agent: id }, '')
  render()
  startScreen()
}

function closeAgent() {
  state.open = null
  stopScreen()
  render()
}

function renderAgent() {
  const agent = state.agents.find((a) => a.id === state.open)
  if (!agent) {
    closeAgent()
    return
  }
  $('list').hidden = true
  $('agent').hidden = false
  $('back').hidden = false
  const status = agent.running ? agent.status || 'idle' : 'exited'
  $('title').textContent = agent.name || agent.id.slice(0, 8)
  $('subtitle').textContent = state.online ? STATUS[status] || status : 'reconnecting…'
  $('agent').dataset.status = status
  $('agent-title').textContent = agent.name || agent.id.slice(0, 8)
  $('agent-harness').textContent = harnessName(agent.harness)
  $('agent-status').textContent = STATUS[status] || status
  $('agent-dot').dataset.status = status
  $('ask').hidden = status !== 'needs-input'
  $('ask-text').textContent = agent.detail || 'The agent is waiting for an answer.'
  const running = agent.running
  $('send').disabled = !running
  $('interrupt').disabled = !running || status !== 'working'
}

// ---- the screen: polled while one agent is open and the page is visible ----------------------

function startScreen() {
  stopScreen()
  const tick = async () => {
    if (!state.open || document.visibilityState !== 'visible') return
    try {
      const data = await api(`/api/agent/${encodeURIComponent(state.open)}/screen?lines=300`)
      const screen = $('screen')
      screen.textContent = data.screen
      if (state.stuckToBottom) screen.scrollTop = screen.scrollHeight
    } catch {
      // shown by the connection dot
    }
  }
  void tick()
  state.screenTimer = setInterval(tick, 1500)
}

function stopScreen() {
  if (state.screenTimer) clearInterval(state.screenTimer)
  state.screenTimer = 0
}

// ---- actions -----------------------------------------------------------------------------------

async function answer(id, key, row) {
  const buttons = row ? [...row.querySelectorAll('button')] : []
  for (const button of buttons) button.disabled = true
  try {
    await api(`/api/agent/${encodeURIComponent(id)}/answer`, { method: 'POST', body: { key } })
    toast(key === 'no' ? 'Declined' : key === 'always' ? 'Allowed (always)' : 'Allowed')
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    for (const button of buttons) button.disabled = false
  }
}

async function sendPrompt(event) {
  event.preventDefault()
  const field = $('prompt-text')
  const text = field.value.trim()
  if (!text || !state.open) return
  $('send').disabled = true
  try {
    await api(`/api/agent/${encodeURIComponent(state.open)}/prompt`, {
      method: 'POST',
      body: { text }
    })
    field.value = ''
    grow(field)
    const agent = state.agents.find((a) => a.id === state.open)
    toast(
      agent && (agent.status === 'working' || agent.status === 'needs-input')
        ? 'Queued — sent when this turn ends'
        : 'Sent'
    )
    state.stuckToBottom = true
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    $('send').disabled = false
  }
}

let armed = 0
async function interrupt() {
  const button = $('interrupt')
  // Two taps: a stray touch must not stop the agent.
  if (!armed) {
    button.classList.add('armed')
    button.textContent = 'Tap again'
    armed = setTimeout(disarm, 3000)
    return
  }
  disarm()
  try {
    await api(`/api/agent/${encodeURIComponent(state.open)}/interrupt`, { method: 'POST' })
    toast('Interrupted')
  } catch (error) {
    toast(error.message, 'error')
  }
}

function disarm() {
  clearTimeout(armed)
  armed = 0
  const button = $('interrupt')
  button.classList.remove('armed')
  button.textContent = 'Interrupt'
}

let toastTimer = 0
function toast(text, kind) {
  const node = $('toast')
  node.textContent = text
  if (kind) node.dataset.kind = kind
  else delete node.dataset.kind
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (node.hidden = true), 2600)
}

function grow(field) {
  field.style.height = 'auto'
  field.style.height = `${Math.min(field.scrollHeight, window.innerHeight * 0.4)}px`
}

// ---- start -------------------------------------------------------------------------------------

function start() {
  $('back').addEventListener('click', () => history.back())
  window.addEventListener('popstate', () => {
    if (state.open) closeAgent()
  })
  $('prompt').addEventListener('submit', sendPrompt)
  const field = $('prompt-text')
  field.addEventListener('input', () => grow(field))
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendPrompt(event)
  })
  $('interrupt').addEventListener('click', interrupt)
  for (const button of $('ask').querySelectorAll('[data-answer]')) {
    button.addEventListener('click', () =>
      answer(state.open, button.dataset.answer, $('ask').querySelector('.answers'))
    )
  }
  const screen = $('screen')
  screen.addEventListener('scroll', () => {
    state.stuckToBottom = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 24
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Back from the background: the held poll may be long dead.
      state.pollAbort?.abort()
      if (state.open) startScreen()
    }
  })

  state.token = readToken()
  if (!state.token) {
    showPair()
    return
  }
  void pollLoop()
}

start()
