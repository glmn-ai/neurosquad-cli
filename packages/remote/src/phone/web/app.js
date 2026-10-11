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
const FIT_KEY = 'neurosquad.phone.fit'

function readFit() {
  try {
    return localStorage.getItem(FIT_KEY) === 'fit' ? 'fit' : 'readable'
  } catch {
    return 'readable'
  }
}
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
  stuckToBottom: true,
  // The terminal view: the version the page has (for ?since=), its width in cells, the rows'
  // keys (only changed rows are rebuilt), the pinch zoom over fit-to-width.
  screenVersion: undefined,
  // Bumped when an agent is opened (a late answer for an earlier opening is dropped) and per
  // request (only the latest request's answer is shown: answers can arrive out of order).
  screenEpoch: 0,
  screenRequest: 0,
  // One screen request at a time (a slow network must not pile them up every second).
  screenBusy: false,
  screenCols: 80,
  rowKeys: [],
  zoom: 1,
  // Readable (default): a font a phone can read, the screen scrolls sideways when the agent is
  // wider. Fit width: the whole width on the screen, small. Remembered on this device.
  fit: readFit()
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
  state.zoom = 1
  resetScreen()
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
//
// The daemon sends the agent's screen as styled runs (colours, bold/italic/underline/inverse/dim,
// the cursor, wide characters); the page builds it from DOM nodes. Agent text only ever goes in
// through textContent, colours only as a validated #rrggbb or one of 16 classes — never as HTML.
// Polled once a second while the agent is open and the page visible; an unchanged screen is a
// tiny answer (?since=), a changed one rebuilds only the rows that changed.

const SCREEN_LINES = 400
const HEX = /^#[0-9a-f]{6}$/i
const PALETTE = /^p([0-9]|1[0-5])$/
const RUN_WIDE = 1
const RUN_CURSOR = 2

function startScreen() {
  stopScreen()
  const tick = async () => {
    if (!state.open || document.visibilityState !== 'visible' || state.screenBusy) return
    const id = state.open
    const epoch = state.screenEpoch
    const request = ++state.screenRequest
    state.screenBusy = true
    try {
      const since = state.screenVersion === undefined ? '' : `&since=${state.screenVersion}`
      const data = await api(
        `/api/agent/${encodeURIComponent(id)}/screen?lines=${SCREEN_LINES}&format=styled${since}`
      )
      const stale =
        state.open !== id || state.screenEpoch !== epoch || state.screenRequest !== request
      if (stale || data.unchanged) return
      if (data.styled) renderStyled(data.styled)
      else renderPlain(data.screen || '')
      state.screenVersion = typeof data.version === 'number' ? data.version : undefined
      if (state.stuckToBottom) followBottom()
    } catch {
      // shown by the connection dot
    } finally {
      if (state.screenRequest === request) state.screenBusy = false
    }
  }
  void tick()
  state.screenTimer = setInterval(tick, 1000)
}

function stopScreen() {
  if (state.screenTimer) clearInterval(state.screenTimer)
  state.screenTimer = 0
}

function resetScreen() {
  state.screenEpoch += 1
  // A request still out for the previous opening no longer holds the next one back.
  state.screenBusy = false
  state.screenVersion = undefined
  state.rowKeys = []
  $('term').replaceChildren()
  fitScreen()
}

/** An older daemon (or the desktop's API): plain text. */
function renderPlain(text) {
  const term = $('term')
  state.rowKeys = []
  term.replaceChildren()
  term.classList.add('plain')
  for (const line of text.split('\n')) term.append(el('div', 'row', line))
}

function colorClass(prefix, value) {
  const palette = PALETTE.exec(value || '')
  return palette ? `${prefix}${palette[1]}` : ''
}

// Box drawing and block elements often come from a fallback font whose advance or ink is not
// quite one cell. Horizontal lines (─ ━ ═) are drawn as CSS lines exactly n cells long, so they
// never break into dashes; any other run of them takes exactly its cells (n ch) and its glyphs are
// stretched to fill them (--bx, measured once). Borders line up with the text around them.
const BOX = /[\u2500-\u259f]/
const BOX_RUN = /[\u2500-\u259f]+/g
const LINE_RUN = /\u2500+|\u2501+|\u2550+/g
const LINE_KIND = { '\u2500': 'hl', '\u2501': 'hl heavy', '\u2550': 'hl double' }

function boxCells(parent, text) {
  let at = 0
  const glyphs = (part) => {
    if (!part) return
    const box = el('span', 'bx')
    box.style.width = `${[...part].length}ch`
    box.append(el('span', '', part))
    parent.append(box)
  }
  for (const match of text.matchAll(LINE_RUN)) {
    glyphs(text.slice(at, match.index))
    // The characters stay in the DOM (copying the screen gives the text), drawn as a line.
    const line = el('span', LINE_KIND[match[0][0]])
    line.append(el('span', '', match[0]))
    line.style.width = `${match[0].length}ch`
    parent.append(line)
    at = match.index + match[0].length
  }
  glyphs(text.slice(at))
}

function fillCells(span, text) {
  if (!BOX.test(text)) {
    span.textContent = text
    return
  }
  let at = 0
  for (const match of text.matchAll(BOX_RUN)) {
    if (match.index > at) span.append(text.slice(at, match.index))
    boxCells(span, match[0])
    at = match.index + match[0].length
  }
  if (at < text.length) span.append(text.slice(at))
}

/** One run as a span: classes for the 16 colours and the attributes, CSSOM for #rrggbb. */
function runNode(run, styles) {
  const [text, index, flags = 0] = run
  const style = styles[index] || {}
  const span = document.createElement('span')
  fillCells(span, String(text))
  let fg = style.fg
  let bg = style.bg
  const classes = []
  if (style.inverse) {
    // Swapped; a default colour becomes the other default.
    ;[fg, bg] = [bg, fg]
    if (!fg) classes.push('fi')
    if (!bg) classes.push('bi')
  }
  const fgClass = colorClass('f', fg)
  const bgClass = colorClass('b', bg)
  if (fgClass) classes.push(fgClass)
  else if (fg && HEX.test(fg)) span.style.color = fg
  if (bgClass) classes.push(bgClass)
  else if (bg && HEX.test(bg)) span.style.backgroundColor = bg
  if (style.bold) classes.push('sb')
  if (style.dim) classes.push('sd')
  if (style.italic) classes.push('si')
  if (style.underline) classes.push('su')
  if (style.strike) classes.push('ss')
  if (style.invisible) classes.push('sx')
  if (flags & RUN_WIDE) classes.push('w2')
  if (flags & RUN_CURSOR) classes.push('cur')
  if (classes.length) span.className = classes.join(' ')
  return span
}

function renderStyled(screen) {
  const term = $('term')
  term.classList.remove('plain')
  const lines = Array.isArray(screen.lines) ? screen.lines : []
  const styles = Array.isArray(screen.styles) ? screen.styles : []
  const cols = Math.max(10, Math.min(1000, Number(screen.cols) || 80))
  if (cols !== state.screenCols || !term.style.fontSize) {
    state.screenCols = cols
    fitScreen()
  }
  // Only rows whose content changed are rebuilt (a row's key: its runs and their styles).
  const keys = lines.map((runs) =>
    JSON.stringify(
      Array.isArray(runs) ? runs.map((run) => [run, Array.isArray(run) && styles[run[1]]]) : []
    )
  )
  const rows = term.children
  for (let i = 0; i < lines.length; i++) {
    if (state.rowKeys[i] === keys[i] && rows[i]) continue
    const row = el('div', 'row')
    for (const run of Array.isArray(lines[i]) ? lines[i] : []) {
      if (Array.isArray(run)) row.append(runNode(run, styles))
    }
    if (rows[i]) term.replaceChild(row, rows[i])
    else term.append(row)
  }
  while (term.children.length > lines.length) term.lastChild.remove()
  state.rowKeys = keys
}

// ---- fit to width, pinch to zoom --------------------------------------------------------------

let charRatio = 0
/** One cell's width as a fraction of the font size (measured once, in the page's own font). */
function measureChar() {
  if (charRatio) return charRatio
  const probe = el('span', 'probe', '0'.repeat(100))
  probe.style.fontSize = '100px'
  $('term').append(probe)
  const width = probe.getBoundingClientRect().width
  // How wide a box-drawing glyph is next to a cell: runs of them are stretched by the inverse.
  probe.textContent = '\u2500'.repeat(100)
  const box = probe.getBoundingClientRect().width
  probe.remove()
  if (width > 0) charRatio = width / 100 / 100
  if (width > 0 && box > 0) $('term').style.setProperty('--bx', (width / box).toFixed(4))
  return charRatio || 0.6
}

/**
 * Like a terminal: the latest lines at the bottom, and the cursor (where the agent is typing or
 * asking) scrolled into view sideways when the screen is wider than the phone.
 */
function followBottom() {
  const screen = $('screen')
  screen.scrollTop = screen.scrollHeight
  const cursor = $('term').querySelector('.cur')
  if (!cursor) return
  const box = screen.getBoundingClientRect()
  const at = cursor.getBoundingClientRect()
  const margin = 24
  if (at.left < box.left + margin) screen.scrollLeft -= box.left + margin - at.left
  else if (at.right > box.right - margin) screen.scrollLeft += at.right - (box.right - margin)
}

const READABLE_PX = 12

function setFit(fit) {
  state.fit = fit === 'fit' ? 'fit' : 'readable'
  state.zoom = 1
  try {
    localStorage.setItem(FIT_KEY, state.fit)
  } catch {
    // no storage: this visit only
  }
  renderFit()
  fitScreen()
  followBottom()
}

function renderFit() {
  for (const button of document.querySelectorAll('[data-fit]')) {
    const on = button.dataset.fit === state.fit
    button.classList.toggle('on', on)
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
}

/**
 * Readable: at least 12px (larger when the whole width fits anyway); fit width: the agent's
 * whole width on the screen. A pinch scales either (¼× to 4×).
 */
function fitScreen() {
  const screen = $('screen')
  if (screen.offsetParent === null) return
  const style = window.getComputedStyle(screen)
  const room =
    screen.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 1
  if (room <= 0) return
  const fit = room / (state.screenCols * measureChar())
  const base = state.fit === 'fit' ? Math.min(15, fit) : Math.max(READABLE_PX, Math.min(15, fit))
  const size = Math.max(4, base * state.zoom)
  $('term').style.fontSize = `${size.toFixed(2)}px`
}

function setupZoom() {
  const screen = $('screen')
  let pinch = null
  let lastTap = 0
  const distance = (touches) =>
    Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
  screen.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length === 2) pinch = { start: distance(event.touches), zoom: state.zoom }
    },
    { passive: true }
  )
  screen.addEventListener(
    'touchmove',
    (event) => {
      if (!pinch || event.touches.length !== 2) return
      event.preventDefault() // the terminal zooms, not the page
      const zoom = Math.max(0.25, Math.min(4, (pinch.zoom * distance(event.touches)) / pinch.start))
      if (Math.abs(zoom - state.zoom) < 0.02) return
      // The point between the fingers stays where it is.
      const rect = screen.getBoundingClientRect()
      const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left
      const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2 - rect.top
      const ratio = zoom / state.zoom
      const left = (screen.scrollLeft + midX) * ratio - midX
      const top = (screen.scrollTop + midY) * ratio - midY
      state.zoom = zoom
      fitScreen()
      screen.scrollLeft = left
      screen.scrollTop = top
    },
    { passive: false }
  )
  screen.addEventListener('touchend', (event) => {
    if (event.touches.length < 2) pinch = null
    // A double tap goes back to the whole width.
    if (event.touches.length || event.changedTouches.length !== 1) return
    const now = Date.now()
    if (now - lastTap < 300 && state.zoom !== 1) {
      state.zoom = 1
      fitScreen()
    }
    lastTap = now
  })
  window.addEventListener('resize', fitScreen)
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
  setupZoom()
  for (const button of document.querySelectorAll('[data-fit]')) {
    button.addEventListener('click', () => setFit(button.dataset.fit))
  }
  renderFit()
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
