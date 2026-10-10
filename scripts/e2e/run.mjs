// End-to-end check of nsq with real harness CLIs against the fake model, in an
// isolated sandbox (scripts/e2e/sandbox.mjs). Per harness:
//
//   hello      a turn: working → finished
//   perm       a permission prompt: needs-input with the question text →
//              answered inline (`nsq answer yes`) → finished, the command ran
//   resume     the daemon restarts; the agent comes back on its session
//   update     nsq installed like `npm i -g` finds a new release (stand-in registry), installs it
//              (stand-in npm), restarts onto it by itself while the agent is idle, and the
//              agent comes back on its session
//   cost       `nsq cost` matches the usage the fake reported
//   openrouter an agent on the OpenRouter recipe: every request to the
//              (fake) OpenRouter carries the attribution headers, no
//              visibility header, the key never in argv
//   custom     agents on the user's own providers (`nsq provider add`): fake
//              local servers — one with every endpoint and a key, one with
//              chat completions only and no key (Codex through nsq's
//              Responses gateway), one with Anthropic messages only — each
//              harness hits the right endpoint with the chosen model and key,
//              no OpenRouter attribution header, the key never in argv;
//              a harness whose API the server lacks is refused
//   models     the model picker's path: an OpenRouter slug without OpenRouter is refused;
//              picking one (model + provider together) switches a running agent at once,
//              restarted on the same session; mid-turn it waits for the turn to end (a prompt
//              queued meanwhile runs on the new model); an agent saved with a slug and no
//              provider (nsq 0.1.1) moves to OpenRouter at start; "default" goes back to the
//              harness's own login. Checked on the wire: path, key, slug, attribution
//   handover   a daemon of an older nsq (0.1.2, the real release from npm) with an agent on
//              OpenRouter: the first command of this nsq waits while the agent needs you, then
//              restarts the daemon on itself; the agent resumes its session on the stored model
//   worktree   an agent in its own git worktree
//   push       ntfy push: a needs-you notification with the name and question only, once
//   phone      through the phone API: the pending question in the state,
//              answered from the phone → finished; a prompt from the phone
//
//   node scripts/e2e/run.mjs --harness claude|codex|opencode|all
//        [--work <scratch dir>] [--bin <dir with the CLIs>] [--only hello,perm]
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeModel, credentialFingerprint, PERM_DIR, STEP_USAGE } from './fake-model.mjs'
import {
  makeSandbox,
  FAKE_ANTHROPIC_KEY,
  FAKE_OPENAI_KEY,
  FAKE_OPENROUTER_KEY
} from './sandbox.mjs'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BIN = join(ROOT, 'apps', 'cli', 'bin', 'nsq.js')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : fallback
}
const HARNESSES = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode' }
const wanted = arg('harness', 'all')
const harnesses = wanted === 'all' ? Object.keys(HARNESSES) : wanted.split(',')
const only = arg('only', '') ? new Set(arg('only').split(',')) : null
// Outside this repository: harnesses treat a folder inside a git repository as part of it.
const WORK = resolve(arg('work', join(ROOT, '..', '.nsq-e2e', `run-${Date.now()}`)))
const binDirs = arg('bin')
  ? arg('bin')
      .split(',')
      .map((dir) => resolve(dir))
  : []

mkdirSync(WORK, { recursive: true })
const t0 = Date.now()
const log = (...parts) =>
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...parts)
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail })
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  return Boolean(ok)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fake = await startFakeModel({ logFile: join(WORK, 'fake-requests.jsonl') })
log('fake model', fake.base)
const sandbox = makeSandbox(WORK, fake.base, { binDirs })

// A stand-in ntfy server: records what nsq publishes (push scenario).
const ntfyPosts = []
const ntfy = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    try {
      ntfyPosts.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    } catch {
      ntfyPosts.push({ path: req.url, body })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((r) => ntfy.listen(0, '127.0.0.1', r))
sandbox.env.NSQ_NTFY_URL = `http://127.0.0.1:${ntfy.address().port}/nsq-e2e-topic`
sandbox.env.NSQ_NTFY_TOKEN = 'tk_e2e'
// Only what the sandbox itself sets (never the rest of the outer environment).
writeFileSync(join(WORK, 'env.json'), JSON.stringify(sandbox.set, null, 2))

function nsq(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: sandbox.env,
    cwd: sandbox.project,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
  if (result.status !== 0)
    log(`nsq ${args.join(' ')} → ${result.status}: ${(result.stderr || result.stdout).trim()}`)
  return result
}
/** `nsq …` without blocking this process (the fake servers here must keep answering). */
function nsqAsync(...args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: sandbox.env,
      cwd: sandbox.project,
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    // Bounded like the synchronous helper: a stalled command fails the check, never the run.
    const timer = setTimeout(() => {
      stderr += ' (timed out after 120 s)'
      child.kill()
    }, 120_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      log(`nsq ${args.join(' ')} → could not start: ${error.message}`)
      resolveRun({ status: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      if (status !== 0) log(`nsq ${args.join(' ')} → ${status}: ${(stderr || stdout).trim()}`)
      resolveRun({ status, stdout, stderr })
    })
  })
}
const list = () => {
  const result = nsq('ls', '--json')
  try {
    return JSON.parse(result.stdout)
  } catch {
    return []
  }
}
const agentNamed = (name) => list().find((agent) => agent.name === name)

/** Polls until the agent's status is one of `kinds`; returns the agent and the statuses seen. */
/**
 * `exitedGraceMs`: how long an `exited` agent may take to come back before this gives up early (a
 * harness that crashed at start). After a daemon restart the agents resume one by one where
 * their harness needs it (OpenCode shares one database), so a later one stays exited longer.
 */
async function waitStatus(name, kinds, timeoutMs = 120_000, exitedGraceMs = 5000) {
  const seen = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const agent = agentNamed(name)
    const label = agent
      ? `${agent.status ?? 'none'}${agent.detail ? `:${agent.detail.slice(0, 50)}` : ''}`
      : 'missing'
    if (seen[seen.length - 1] !== label) seen.push(label)
    if (agent && kinds.includes(agent.status)) return { agent, seen }
    if (
      agent?.status === 'exited' &&
      !kinds.includes('exited') &&
      Date.now() > deadline - timeoutMs + exitedGraceMs
    ) {
      return { agent, seen, exited: true }
    }
    await sleep(400)
  }
  return { agent: agentNamed(name), seen, timedOut: true }
}

/**
 * The agent's screen once it shows `pattern` (or the last screen after `timeoutMs`). A hook can
 * report the turn finished before the TUI has drawn its answer (Codex on a slow runner), and a
 * resumed TUI takes a while to draw on a cold start: wait for the screen, never assume it.
 */
/** A resumed TUI on a cold start (OpenCode on a macOS or Windows runner) can take half a minute. */
const RESUME_SCREEN_MS = 60_000

async function waitScreen(name, pattern, timeoutMs = 20_000, lines = 80) {
  const deadline = Date.now() + timeoutMs
  let screen = nsq('peek', name, '-n', String(lines)).stdout
  while (!pattern.test(screen) && Date.now() < deadline) {
    await sleep(500)
    screen = nsq('peek', name, '-n', String(lines)).stdout
  }
  return screen
}

const runs = (step) => !only || only.has(step)

// The user's own servers for the `custom` step (each a fake model with fewer endpoints).
const CUSTOM_KEY = 'sk-nsq-e2e-custom-provider-key-7f3a'
const customServers = {}
let customAdded = false
if (runs('custom')) {
  customServers.full = await startFakeModel({
    key: CUSTOM_KEY,
    models: [
      { id: 'fake-model', object: 'model', owned_by: 'llamacpp', meta: { n_ctx: 32768 } },
      // LM Studio-style id: looks like an OpenRouter slug, and an OpenRouter key is set in the
      // sandbox — the agent must stay on this server (never moved to OpenRouter).
      { id: 'qwen/qwen3-coder-30b', object: 'model', owned_by: 'lmstudio' },
      { id: 'fake-other', object: 'model', owned_by: 'llamacpp' }
    ]
  })
  customServers.chat = await startFakeModel({ endpoints: ['chat'] })
  customServers.messages = await startFakeModel({ endpoints: ['anthropic'] })
  // The key reaches nsq only through its environment (no OS keyring touched).
  sandbox.env.NSQ_PROVIDER_KEY_E2E_FULL = CUSTOM_KEY
  log(
    'custom providers',
    Object.values(customServers)
      .map((server) => server.base)
      .join(' ')
  )
}

/** Every process command line on this machine (to prove a key never reaches argv). */
function commandLines() {
  try {
    if (process.platform === 'win32') {
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
      )
    }
    return execFileSync('ps', ['-eww', '-o', 'args='], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (error) {
    return `unavailable: ${error}`
  }
}

const KEY_TAIL = CUSTOM_KEY.slice(-4)
/** The credential a request carried (the fake keeps its last 4 characters), or undefined. */
const credentialOf = (headers = {}) => headers.authorization ?? headers['x-api-key']
/**
 * Real OpenRouter slugs (from `GET https://openrouter.ai/api/v1/models`, 2026-10-09) — what the
 * picker hands over, passed through unchanged. OpenCode's first one is not in its catalog.
 * (Codex: not `openai/gpt-6-*` — Codex takes those for its own code-mode-only models and sends
 * their tools in a form the fake does not script; docs/guide/openrouter.md.)
 */
const SLUGS = {
  claude: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6-sol'],
  codex: ['openai/gpt-5.5', 'anthropic/claude-sonnet-5.5'],
  opencode: ['moonshotai/kimi-k3', 'openai/gpt-6-sol']
}
const OPENROUTER_AUTH = credentialFingerprint(`Bearer ${FAKE_OPENROUTER_KEY}`)
const isAttributed = (h) =>
  h['http-referer'] === 'https://neurosquad.ai/' &&
  h['x-openrouter-title'] === 'NeuroSquad' &&
  h['x-title'] === 'NeuroSquad' &&
  h['x-openrouter-categories'] === 'cli-agent,programming-app' &&
  !('x-openrouter-app-visibility' in h)
/** The scripted (not side) request answering the prompt marked `text`, after index `from`. */
const turnRequest = (from, text) =>
  fake.requests
    .slice(from)
    .find((r) => r.protocol && !r.side && r.prompts?.some((p) => p.includes(text)))
/** Waits for that request, then for the turn to finish. */
async function waitTurn(name, from, text) {
  for (let i = 0; i < 180 && !turnRequest(from, text); i++) await sleep(500)
  await waitStatus(name, ['finished'], 60_000)
  return turnRequest(from, text)
}

/** After a restart: the agent is running and its resumed screen is up; then a beat for input. */
async function waitResumed(name, text = 'NSQ_HELLO_DONE') {
  for (let i = 0; i < 60; i++) {
    const agent = agentNamed(name)
    if (agent?.running && new RegExp(text).test(nsq('peek', name, '-n', '80').stdout)) {
      await sleep(2500)
      return true
    }
    await sleep(500)
  }
  return false
}

/**
 * Codex on its own provider (`openai`, as most users have it — the sandbox's default config
 * names its own `fake` provider, on which `vendor/model` ids are native), pointed at the fake.
 */
function codexOnOwnProvider() {
  const configFile = join(sandbox.codexHome, 'config.toml')
  const authFile = join(sandbox.codexHome, 'auth.json')
  const saved = readFileSync(configFile, 'utf8')
  writeFileSync(
    configFile,
    [
      'model = "fake-model"',
      'approval_policy = "on-request"',
      'sandbox_mode = "read-only"',
      'check_for_update_on_startup = false',
      `openai_base_url = "${fake.base}/v1"`,
      ''
    ].join('\n')
  )
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: FAKE_OPENAI_KEY }))
  return () => {
    writeFileSync(configFile, saved)
    rmSync(authFile, { force: true })
  }
}

async function modelsScenario(short) {
  const [slug, slug2] = SLUGS[short]
  const name = `${short}-model`
  const restore = short === 'codex' ? codexOnOwnProvider() : undefined
  // The daemon re-reads the Codex config at most every 10 s.
  if (restore) await sleep(10_500)
  try {
    // 1. A slug only OpenRouter knows, without OpenRouter: refused with the fix (OpenCode's own
    //    ids are provider/model too, so there it is not refused).
    if (short !== 'opencode') {
      const refused = nsq('run', short, '--name', `${name}-x`, '--model', slug, 'hi')
      check(
        `${short}: --model ${slug} without --provider openrouter is refused with the fix`,
        refused.status !== 0 &&
          refused.stderr.includes(
            `${slug} is an OpenRouter model id — add --provider openrouter`
          ) &&
          !agentNamed(`${name}-x`),
        refused.stderr.trim()
      )
    }

    // 2. An agent on the harness's own login, one turn.
    let from = fake.requests.length
    nsq('run', short, '--name', name, '[nsq:hello] on the own login')
    await waitTurn(name, from, 'on the own login')

    // 3. The picker (dashboard `m`, the same request): model and provider together; the agent
    //    is idle → restarted at once on the same session.
    from = fake.requests.length
    const set = nsq('set', name, '--model', slug, '--provider', 'openrouter')
    const view = agentNamed(name)
    check(
      `${short}: picking ${slug} switches the idle agent now, session kept`,
      /switched to .* on OpenRouter \(session kept\)/.test(set.stdout) &&
        view?.provider === 'openrouter' &&
        view?.model === slug,
      set.stdout.trim() || set.stderr.trim()
    )
    await waitResumed(name)
    nsq('send', name, '[nsq:hello] after the switch')
    let turn = await waitTurn(name, from, 'after the switch')
    check(
      `${short}: the next turn goes to OpenRouter with ${slug}, the key, attribution — and the earlier turn`,
      turn?.path?.startsWith('/api/v1/') &&
        turn.model === slug &&
        turn.credentials?.authorization === OPENROUTER_AUTH &&
        isAttributed(turn.headers) &&
        turn.prompts.some((p) => p.includes('on the own login')),
      turn && { path: turn.path, model: turn.model, prompts: turn.prompts }
    )
    if (short === 'claude') {
      check(
        `claude: on OpenRouter, a Claude model (${slug}) keeps Claude Code's full request (adaptive thinking)`,
        turn?.shape?.thinking === 'adaptive',
        turn?.shape
      )
    }

    // 4. Mid-turn: the switch waits for the end of the turn; a prompt queued meanwhile runs on
    //    the new model after the restart.
    from = fake.requests.length
    nsq('send', name, '[nsq:slow] a long turn')
    for (let i = 0; i < 60 && !turnRequest(from, 'a long turn'); i++) await sleep(250)
    const busy = await waitStatus(name, ['working'], 30_000)
    const later = nsq('set', name, '--model', slug2, '--provider', 'openrouter')
    nsq('send', name, '--when-done', '[nsq:hello] queued for after the switch')
    check(
      `${short}: mid-turn, the switch waits for the turn to end`,
      /switches to .* when this turn ends \(session kept\)/.test(later.stdout),
      { out: later.stdout.trim() || later.stderr.trim(), seen: busy.seen }
    )
    turn = await waitTurn(name, from, 'queued for after the switch')
    check(
      `${short}: the queued prompt ran after the restart, on ${slug2}`,
      turn?.model === slug2 &&
        turn.credentials?.authorization === OPENROUTER_AUTH &&
        turnRequest(from, 'a long turn')?.model === slug,
      turn && { model: turn.model, prompts: turn.prompts }
    )
    if (short === 'claude') {
      // Not Claude: the plain Messages request (OpenRouter answered "400 Invalid Anthropic
      // Messages API request" for the full one; packages/core CLAUDE_CODE_PLAIN_MESSAGES).
      const shape = turn?.shape
      const betas = String(turn?.headers?.['anthropic-beta'] ?? '')
      check(
        `claude: on OpenRouter, ${slug2} (not Claude) gets the plain Messages request — no context_management, output_config, safeguards, adaptive thinking or mid-conversation system messages`,
        shape &&
          !['context_management', 'output_config', 'safeguards'].some((field) =>
            shape.fields.includes(field)
          ) &&
          shape.thinking !== 'adaptive' &&
          shape.systemMessages === 0 &&
          !/context-management|mid-conversation-system|effort-/.test(betas),
        { shape, betas }
      )
    }

    // 5. nsq 0.1.1 left agents with a slug and no provider: at start they move to OpenRouter
    //    (with a key). Not OpenCode: its own ids look the same and are left alone.
    if (short !== 'opencode') {
      nsq('down')
      const agentsFile = join(sandbox.env.NSQ_HOME, 'agents.json')
      const saved = JSON.parse(readFileSync(agentsFile, 'utf8'))
      const record = saved.agents.find((a) => a.name === name)
      delete record.provider
      writeFileSync(agentsFile, JSON.stringify(saved, null, 2))
      nsq('up')
      await waitResumed(name)
      check(
        `${short}: an agent saved with an OpenRouter slug and no provider is moved to OpenRouter`,
        agentNamed(name)?.provider === 'openrouter',
        agentNamed(name)?.provider ?? 'none'
      )
    }

    // 6. "default": back to the harness's own login, its own model — the conversation kept.
    from = fake.requests.length
    const back = nsq('set', name, '--model', 'none', '--provider', 'none')
    await waitResumed(name)
    nsq('send', name, '[nsq:hello] back on the own login')
    turn = await waitTurn(name, from, 'back on the own login')
    const own =
      short === 'claude'
        ? turn?.path === '/v1/messages' &&
          turn.credentials?.['x-api-key'] === credentialFingerprint(FAKE_ANTHROPIC_KEY) &&
          !turn.model?.includes('/')
        : short === 'codex'
          ? // Codex resumes on the session's last model unless told: nsq passes its own back.
            turn?.path === '/v1/responses' && turn.model === 'fake-model'
          : // The sandbox's own OpenCode config reaches the fake as its `openrouter` provider
            // with its configured model.
            turn?.model === 'fake-model'
    check(
      `${short}: "default" puts it back on its own login and model, the conversation kept`,
      /switched to its own login and default model/.test(back.stdout) &&
        own &&
        turn.prompts.some((p) => p.includes('queued for after the switch')),
      turn && { path: turn.path, model: turn.model, out: back.stdout.trim() }
    )
    nsq('rm', name)
  } finally {
    restore?.()
  }
}

/** The real nsq 0.1.2 from npm, installed once per run (a daemon from before the hand-over). */
let oldNsqBin = null
function installOldNsq() {
  if (oldNsqBin) return oldNsqBin
  const prefix = join(WORK, 'nsq-0.1.2')
  mkdirSync(prefix, { recursive: true })
  // One command line (no arguments array): a shell is needed for npm.cmd on Windows.
  const npm = spawnSync(
    `npm install --prefix "${prefix}" neurosquad@0.1.2 --no-audit --no-fund --loglevel=error`,
    { encoding: 'utf8', timeout: 300_000, shell: true, windowsHide: true }
  )
  if (npm.status !== 0) throw new Error(`npm install neurosquad@0.1.2: ${npm.stderr || npm.stdout}`)
  oldNsqBin = join(prefix, 'node_modules', 'neurosquad', 'bin', 'nsq.js')
  return oldNsqBin
}

/**
 * The owner's case: a daemon started by an older nsq keeps running after the package was
 * upgraded, so its fixes never ran. This nsq's first command hands it over — not while the agent
 * works — and the agent resumes on its session, on the model the record holds.
 */
async function handoverScenario(short) {
  const [slug] = SLUGS[short]
  const name = `${short}-handover`
  // Its own nsq home: the old daemon must not resume the other steps' agents.
  const env = { ...sandbox.env, NSQ_HOME: join(WORK, `handover-home-${short}`) }
  const stateFile = join(env.NSQ_HOME, 'daemon.json')
  const daemonState = () => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch {
      return null
    }
  }
  const run = (bin, ...args) =>
    new Promise((resolveRun) => {
      const child = spawn(process.execPath, [bin, ...args], {
        env,
        cwd: sandbox.project,
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      const timer = setTimeout(() => child.kill(), 180_000)
      child.on('close', (status) => {
        clearTimeout(timer)
        resolveRun({ status, stdout, stderr })
      })
    })
  let old
  try {
    old = installOldNsq()
  } catch (error) {
    check(`${short}: nsq 0.1.2 installed from npm (for the hand-over)`, false, String(error))
    return
  }
  const oldAgent = async () => {
    try {
      return JSON.parse((await run(old, 'ls', '--json')).stdout).find((a) => a.name === name)
    } catch {
      return undefined
    }
  }
  const waitOld = async (kinds, ms = 120_000) => {
    const deadline = Date.now() + ms
    for (;;) {
      const agent = await oldAgent()
      if ((agent && kinds.includes(agent.status)) || Date.now() > deadline) return agent
      await sleep(500)
    }
  }
  try {
    let from = fake.requests.length
    await run(
      old,
      'run',
      short,
      '--name',
      name,
      '--provider',
      'openrouter',
      '--model',
      slug,
      '[nsq:hello] before the hand-over'
    )
    const first = daemonState()
    await waitOld(['finished'])
    check(
      `${short}: nsq 0.1.2 runs the daemon and the agent's first turn`,
      first?.version === '0.1.2' && Boolean(turnRequest(from, 'before the hand-over')),
      first?.version
    )

    // Busy (waiting for an answer — a state that holds still, unlike a turn's few seconds of
    // "working"): this nsq runs its command on the old daemon and says why it does not restart.
    rmSync(join(sandbox.project, PERM_DIR), { recursive: true, force: true })
    await run(old, 'send', name, '[nsq:perm] a question on 0.1.2')
    const asked = await waitOld(['needs-input'], 120_000)
    const busy = await run(BIN, 'ls')
    check(
      `${short}: a newer nsq does not restart the daemon while the agent needs you, and says so`,
      busy.status === 0 &&
        /the daemon is 0\.1\.2, this nsq is .* once they are free \(.*is busy/.test(busy.stderr) &&
        daemonState()?.pid === first?.pid,
      { stderr: busy.stderr.trim(), status: asked?.status }
    )
    await sleep(1500)
    await run(old, 'answer', name, 'yes')
    await waitOld(['finished'])

    // Free: the next command hands the daemon over to this nsq.
    const handed = await run(BIN, 'ls', '--json')
    const after = daemonState()
    check(
      `${short}: the next command restarts the daemon on this nsq`,
      handed.status === 0 &&
        /the daemon was 0\.1\.2; it now runs/.test(handed.stderr) &&
        after?.pid !== first?.pid &&
        after?.version !== '0.1.2' &&
        Boolean(after?.version),
      { stderr: handed.stderr.trim(), version: after?.version }
    )
    let peek = ''
    for (let i = 0; i < 40 && !/NSQ_PERM_DONE/.test(peek); i++) {
      await sleep(1000)
      peek = (await run(BIN, 'peek', name, '-n', '80')).stdout
    }
    await sleep(2500)
    from = fake.requests.length
    await run(BIN, 'send', name, '[nsq:hello] after the hand-over')
    let turn
    for (let i = 0; i < 180 && !(turn = turnRequest(from, 'after the hand-over')); i++)
      await sleep(500)
    check(
      `${short}: the agent resumed its session on the new daemon, on ${slug} through OpenRouter`,
      turn?.model === slug &&
        turn.path?.startsWith('/api/v1/') &&
        turn.prompts.some((p) => p.includes('a question on 0.1.2')),
      turn && { model: turn.model, path: turn.path, prompts: turn.prompts }
    )
  } finally {
    await run(BIN, 'down')
    await run(old, 'down')
  }
}

try {
  for (const short of harnesses) {
    const harness = HARNESSES[short]
    log(`==== ${harness}`)

    if (runs('hello')) {
      const name = `${short}-hello`
      nsq('run', short, '--name', name, '[nsq:hello] say hello')
      const first = await waitStatus(name, ['working', 'finished'], 90_000)
      const done = await waitStatus(name, ['finished'], 90_000)
      check(`${short}: hello turn working → finished`, done.agent?.status === 'finished', [
        ...first.seen,
        ...done.seen
      ])
      const peek = await waitScreen(name, /NSQ_HELLO_DONE/, 20_000, 60)
      check(`${short}: the answer is on screen`, /NSQ_HELLO_DONE/.test(peek), peek.slice(-400))
    }

    if (runs('perm')) {
      const name = `${short}-perm`
      rmSync(join(sandbox.project, PERM_DIR), { recursive: true, force: true })
      nsq('run', short, '--name', name, '[nsq:perm] make the folder')
      const asked = await waitStatus(name, ['needs-input'], 120_000)
      check(
        `${short}: permission prompt → needs you, with the question`,
        asked.agent?.status === 'needs-input' && Boolean(asked.agent?.detail),
        asked.seen
      )
      // A beat for the dialog to take keys.
      await sleep(1500)
      nsq('answer', name, arg('answer', 'yes'))
      const done = await waitStatus(name, ['finished'], 120_000)
      check(`${short}: answered inline → finished`, done.agent?.status === 'finished', done.seen)
      check(`${short}: the approved command ran`, existsSync(join(sandbox.project, PERM_DIR)))
      if (done.agent?.status !== 'finished') log(nsq('peek', name, '-n', '40').stdout)
    }

    if (runs('push')) {
      const name = `${short}-push`
      rmSync(join(sandbox.project, PERM_DIR), { recursive: true, force: true })
      const before = ntfyPosts.length
      nsq('run', short, '--name', name, '[nsq:perm] make the folder')
      await waitStatus(name, ['needs-input'], 120_000)
      for (let i = 0; i < 20 && ntfyPosts.length === before; i++) await sleep(250)
      const post = ntfyPosts[before]
      check(
        `${short}: needs you → one ntfy push with the name and the question only`,
        post?.body?.topic === 'nsq-e2e-topic' &&
          post.body.title === `${name} needs you` &&
          /mkdir/.test(post.body.message) &&
          post.auth === 'Bearer tk_e2e' &&
          Object.keys(post.body).sort().join(',') === 'message,priority,tags,title,topic',
        post
      )
      await sleep(1500)
      nsq('answer', name, 'yes')
      await waitStatus(name, ['finished'], 120_000)
      check(
        `${short}: no second push for the same question`,
        ntfyPosts.length === before + 1,
        ntfyPosts.length - before
      )
    }

    if (runs('phone')) {
      const name = `${short}-phone`
      rmSync(join(sandbox.project, PERM_DIR), { recursive: true, force: true })
      const on = nsq('phone', 'on', '--port', '0')
      const port = /port (\d+)/.exec(on.stdout)?.[1]
      const token = readFileSync(join(sandbox.env.NSQ_HOME, 'phone-token'), 'utf8').trim()
      const api = async (path, body) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {})
        })
        return { status: response.status, json: await response.json().catch(() => null) }
      }
      nsq('run', short, '--name', name, '[nsq:perm] make the folder')
      await waitStatus(name, ['needs-input'], 120_000)
      const state = await api('/api/state')
      const agent = state.json?.agents?.find((a) => a.name === name)
      check(
        `${short}: phone sees needs-input with the question`,
        agent?.status === 'needs-input' && Boolean(agent?.detail),
        agent
      )
      await sleep(1500)
      const answered = await api(`/api/agent/${agent?.id}/answer`, { key: 'yes' })
      const done = await waitStatus(name, ['finished'], 120_000)
      check(
        `${short}: answered from the phone → finished, the command ran`,
        answered.status === 202 &&
          done.agent?.status === 'finished' &&
          existsSync(join(sandbox.project, PERM_DIR)),
        { answered: answered.status, seen: done.seen }
      )
      const sent = await api(`/api/agent/${agent?.id}/prompt`, {
        text: '[nsq:hello] again from the phone'
      })
      await waitStatus(name, ['working'], 30_000)
      const again = await waitStatus(name, ['finished'], 120_000)
      check(
        `${short}: a prompt from the phone runs a turn`,
        sent.status === 202 && again.agent?.status === 'finished',
        again.seen
      )
      nsq('phone', 'off')
    }

    if (runs('resume')) {
      const name = runs('hello') ? `${short}-hello` : `${short}-resume`
      if (!runs('hello')) {
        nsq('run', short, '--name', name, '[nsq:hello] say hello')
        await waitStatus(name, ['finished'], 90_000)
      }
      nsq('down')
      check(`${short}: daemon stopped`, list().length === 0)
      nsq('up')
      const back = await waitStatus(name, ['idle', 'working', 'finished'], 60_000, 45_000)
      const peek = await waitScreen(name, /NSQ_HELLO_DONE/, RESUME_SCREEN_MS)
      check(`${short}: agent back after a daemon restart`, back.agent?.running === true, back.seen)
      check(
        `${short}: the resumed session shows the earlier turn`,
        /NSQ_HELLO_DONE/.test(peek),
        peek.slice(-400)
      )
    }

    if (runs('update')) {
      const name = `${short}-update`
      nsq('run', short, '--name', name, '[nsq:hello] say hello')
      await waitStatus(name, ['finished'], 90_000)
      nsq('down')
      // nsq as `npm i -g` would lay it out (0.1.0), a registry saying 0.1.1, an npm that "installs"
      // it by rewriting the copy's version: the daemon must do the rest by itself.
      const { makeInstalledCopy, startFakeRegistry } = await import('./update-fixture.mjs')
      const registry = await startFakeRegistry({ latest: '0.1.1' })
      const copyWork = join(WORK, `update-${short}`)
      mkdirSync(copyWork, { recursive: true })
      const copy = makeInstalledCopy({
        root: ROOT,
        work: copyWork,
        version: '0.1.0',
        registry: registry.base
      })
      const copyEnv = { ...sandbox.env, ...copy.env }
      // This step is about the daemon's own updater: this repository's nsq (newer than the copy)
      // polls the agent here and must not hand the daemon over to itself (that is `handover`).
      sandbox.env.NSQ_NO_HANDOVER = '1'
      const nsqCopy = (...args) =>
        spawnSync(process.execPath, [copy.bin, ...args], {
          env: copyEnv,
          cwd: sandbox.project,
          encoding: 'utf8',
          timeout: 120_000,
          windowsHide: true
        })
      const stateFile = join(sandbox.env.NSQ_HOME, 'daemon.json')
      const daemonState = () => {
        try {
          return JSON.parse(readFileSync(stateFile, 'utf8'))
        } catch {
          return null
        }
      }
      try {
        nsqCopy('up')
        const before = daemonState()
        check(
          `${short}: nsq 0.1.0 (installed copy) runs the daemon`,
          before?.version === '0.1.0',
          before?.version
        )
        let after = null
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          const state = daemonState()
          if (state && state.pid !== before?.pid && state.version === '0.1.1') {
            after = state
            break
          }
          // Asynchronous waits only: the stand-in registry answers from this process.
          await sleep(500)
        }
        const calls = copy.readNpmCalls()
        check(
          `${short}: the update was installed in the background (npm -g, same prefix)`,
          calls.length === 1 &&
            calls[0].includes('neurosquad@0.1.1') &&
            calls[0].includes(realpathSync(copy.prefix)),
          calls
        )
        check(`${short}: the daemon restarted onto 0.1.1 by itself (agent idle)`, after !== null, {
          version: daemonState()?.version
        })
        const back = await waitStatus(name, ['idle', 'working', 'finished'], 60_000, 45_000)
        const peek = await waitScreen(name, /NSQ_HELLO_DONE/, RESUME_SCREEN_MS)
        check(
          `${short}: the agent is back after the update`,
          back.agent?.running === true,
          back.seen
        )
        check(
          `${short}: the agent resumed its session after the update`,
          /NSQ_HELLO_DONE/.test(peek),
          peek.slice(-400)
        )
        check(
          `${short}: the update check sent no credentials or ids`,
          registry.requests.length > 0 &&
            registry.requests.every(
              (r) => !r.headers.authorization && !r.headers.cookie && !r.headers['npm-session']
            ),
          registry.requests.map((r) => r.url)
        )
      } finally {
        delete sandbox.env.NSQ_NO_HANDOVER
        nsqCopy('down')
        await registry.close()
        // The dependency link first: never follow it into the repository's node_modules.
        try {
          unlinkSync(join(copy.packageDir, 'node_modules'))
        } catch {
          // gone
        }
        rmSync(copyWork, { recursive: true, force: true })
      }
    }

    if (runs('cost')) {
      const rows = JSON.parse(nsq('cost', '--json').stdout || '[]').filter(
        (row) => row.harness === harness
      )
      const requests = rows.reduce((sum, row) => sum + row.requests, 0)
      const output = rows.reduce((sum, row) => sum + row.totals.output, 0)
      const scripted = fake.requests.filter(
        (r) => r.protocol && !r.side && r.usage?.output === STEP_USAGE.output
      )
      check(
        `${short}: cost read from the harness's own log`,
        requests > 0 && output >= STEP_USAGE.output,
        {
          requests,
          output,
          fakeScripted: scripted.length,
          rows: rows.map((row) => ({
            name: row.name,
            requests: row.requests,
            usd: row.usd,
            unpriced: row.unpricedRequests
          }))
        }
      )
    }

    if (runs('openrouter')) {
      const name = `${short}-or`
      const before = fake.requests.length
      nsq(
        'run',
        short,
        '--name',
        name,
        '--provider',
        'openrouter',
        '--model',
        short === 'opencode' ? 'fake-model' : 'fake/fake-model',
        '[nsq:hello] via openrouter'
      )
      const done = await waitStatus(name, ['finished'], 90_000)
      const viaOpenRouter = fake.requests.slice(before).filter((r) => r.path?.startsWith('/api/'))
      const headers = viaOpenRouter.map((r) => r.headers)
      const attributed =
        headers.length > 0 &&
        headers.every(
          (h) =>
            h['http-referer'] === 'https://neurosquad.ai/' &&
            h['x-openrouter-title'] === 'NeuroSquad' &&
            h['x-title'] === 'NeuroSquad' &&
            h['x-openrouter-categories'] === 'cli-agent,programming-app' &&
            !('x-openrouter-app-visibility' in h)
        )
      check(`${short}: OpenRouter turn finished`, done.agent?.status === 'finished', done.seen)
      check(
        `${short}: every OpenRouter request carries the attribution headers, no visibility header`,
        attributed,
        {
          requests: viaOpenRouter.length,
          sample:
            headers[0] &&
            Object.fromEntries(
              Object.entries(headers[0]).filter(([k]) =>
                /referer|title|categor|visib|authorization/i.test(k)
              )
            )
        }
      )
    }

    if (runs('custom')) {
      const add = (id, server, ...extra) =>
        nsqAsync('provider', 'add', id, '--url', `${server.base}/v1`, ...extra)
      if (!customAdded) {
        customAdded = true
        const full = await add('e2e-full', customServers.full)
        check(
          'custom: provider add tests the server and finds every endpoint',
          full.status === 0 && /endpoints: chat, responses, messages/.test(full.stdout),
          (full.stdout || full.stderr).trim()
        )
        const providers = JSON.parse(nsq('provider', 'list', '--json').stdout || '[]')
        const stored = providers.find((p) => p.id === 'e2e-full')
        const providersFile = join(sandbox.env.NSQ_HOME, 'providers.json')
        const file = existsSync(providersFile) ? readFileSync(providersFile, 'utf8') : ''
        check(
          'custom: stored without the key; the served context window kept',
          stored?.models?.find((m) => m.id === 'fake-model')?.contextWindow === 32768 &&
            !file.includes(CUSTOM_KEY),
          stored
        )
        const chat = await add('e2e-chat', customServers.chat)
        check(
          'custom: a chat-only server without a key',
          chat.status === 0 && /endpoints: chat \(/.test(chat.stdout),
          chat.stdout.trim()
        )
        const messages = await add('e2e-msgs', customServers.messages)
        check(
          'custom: an Anthropic-only server',
          messages.status === 0 && /endpoints: messages \(/.test(messages.stdout),
          messages.stdout.trim()
        )
        const remote = await nsqAsync(
          'provider',
          'add',
          'e2e-public',
          '--url',
          'http://example.com:1234'
        )
        check(
          'custom: plain http to a public host is refused',
          remote.status !== 0 && /use https/.test(remote.stderr),
          remote.stderr.trim()
        )
        const argvKey = await nsqAsync(
          'provider',
          'add',
          'e2e-argv',
          '--url',
          customServers.chat.base,
          '--key',
          'sk-x'
        )
        check(
          'custom: a key given as an argument is refused',
          argvKey.status !== 0,
          argvKey.stderr.trim()
        )
      }
      const plans = {
        claude: [['e2e-full', '/v1/messages', true]],
        codex: [
          ['e2e-full', '/v1/responses', true],
          ['e2e-chat', '/v1/chat/completions', false]
        ],
        opencode: [
          ['e2e-full', '/v1/chat/completions', true],
          ['e2e-msgs', '/v1/messages', false]
        ]
      }[short]
      const servers = { 'e2e-full': 'full', 'e2e-chat': 'chat', 'e2e-msgs': 'messages' }
      for (const [provider, path, keyed] of plans) {
        const server = customServers[servers[provider]]
        const name = `${short}-${provider}`
        const before = server.requests.length
        // Claude Code: the user's own settings.json routes elsewhere (another base URL, Bedrock).
        // Its `env` overrides the process environment — the agent must still reach this server.
        // On the full server an LM Studio-style id (`vendor/model`, like an OpenRouter slug).
        const model = provider === 'e2e-full' ? 'qwen/qwen3-coder-30b' : 'fake-model'
        const userSettings = join(sandbox.claudeDir, 'settings.json')
        const ownSettings = short === 'claude' ? readFileSync(userSettings, 'utf8') : undefined
        if (ownSettings) {
          const hostile = JSON.parse(ownSettings)
          hostile.env = {
            ...hostile.env,
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
            CLAUDE_CODE_USE_BEDROCK: '1',
            ANTHROPIC_AUTH_TOKEN: 'sk-user-own-anthropic-token-zzzz'
          }
          writeFileSync(userSettings, JSON.stringify(hostile))
        }
        const started = await nsqAsync(
          'run',
          short,
          '--name',
          name,
          '--provider',
          provider,
          '--model',
          model,
          '[nsq:hello] on my own server'
        )
        const working = await waitStatus(name, ['working', 'finished'], 60_000)
        const lines = commandLines()
        const done = await waitStatus(name, ['finished'], 90_000)
        const turns = server.requests.slice(before).filter((r) => r.protocol && !r.probe)
        const peek = await waitScreen(name, /NSQ_HELLO_DONE/, 20_000, 60)
        check(
          `${short} on ${provider}: the turn ran on that server (${path})`,
          started.status === 0 &&
            done.agent?.status === 'finished' &&
            done.agent?.provider === 'custom' &&
            /NSQ_HELLO_DONE/.test(peek) &&
            turns.length > 0 &&
            turns.every((r) => r.path === path),
          { seen: [...working.seen, ...done.seen], paths: [...new Set(turns.map((r) => r.path))] }
        )
        const scripted = turns.filter((r) => r.scenario === 'hello')
        check(
          `${short} on ${provider}: the chosen model, ${keyed ? 'the key' : 'no key'}, no attribution header`,
          scripted.length > 0 &&
            scripted.every((r) => r.model === model) &&
            turns.every((r) => {
              const h = r.headers ?? {}
              const credential = credentialOf(h)
              // Keyless: neither header may carry the key (a placeholder token is fine).
              const carriesKey = [h.authorization, h['x-api-key']].some((v) =>
                v?.endsWith(KEY_TAIL)
              )
              return (
                (keyed ? credential?.endsWith(KEY_TAIL) : !carriesKey) &&
                !('http-referer' in h) &&
                !('x-title' in h) &&
                !Object.keys(h).some((k) => k.startsWith('x-openrouter'))
              )
            }),
          turns.slice(0, 3).map((r) => ({
            model: r.model,
            credential: credentialOf(r.headers),
            attribution: Object.keys(r.headers ?? {}).filter((k) =>
              /openrouter|referer|title/.test(k)
            )
          }))
        )
        check(
          `${short} on ${provider}: the key is in no process's command line`,
          !lines.startsWith('unavailable') && !lines.includes(CUSTOM_KEY),
          lines.startsWith('unavailable') ? lines.slice(0, 200) : undefined
        )
        nsq('stop', name)
        if (ownSettings) writeFileSync(userSettings, ownSettings)
      }
      if (short === 'claude') {
        const refused = await nsqAsync(
          'run',
          'claude',
          '--name',
          'claude-chat-only',
          '--provider',
          'e2e-chat',
          '--model',
          'fake-model'
        )
        check(
          'claude on a chat-only server is refused, with the reason',
          refused.status !== 0 && /Anthropic Messages API/.test(refused.stderr),
          refused.stderr.trim()
        )
      }
    }
    if (runs('models')) await modelsScenario(short)

    if (runs('handover')) await handoverScenario(short)

    if (runs('worktree')) {
      const git = (...args) => execFileSync('git', args, { cwd: sandbox.project, stdio: 'ignore' })
      if (!existsSync(join(sandbox.project, '.git'))) {
        git('init', '-q')
        git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'add', '.')
        git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'init')
      }
      const name = `${short}-wt`
      nsq('run', short, '--name', name, '--worktree', '[nsq:hello] in a worktree')
      const done = await waitStatus(name, ['finished'], 90_000)
      const agent = done.agent
      check(
        `${short}: worktree agent runs in its own checkout`,
        Boolean(agent?.worktree?.branch === `nsq/${name}` && existsSync(agent.cwd)),
        agent?.worktree
      )
      nsq('rm', name, '--worktree')
      check(`${short}: rm --worktree deletes the checkout`, agent ? !existsSync(agent.cwd) : false)
    }
  }
} finally {
  const down = nsq('down')
  // A daemon that did not stop (a failed run): by its own PID only — and only
  // while its state file is still there (a normal stop removes it).
  const stateFile = join(sandbox.env.NSQ_HOME, 'daemon.json')
  if (down.status !== 0 || existsSync(stateFile))
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(state.pid, 'SIGKILL')
    } catch {
      // stopped
    }
  await fake.close()
  for (const server of Object.values(customServers)) await server.close()
  ntfy.close()
  const failed = checks.filter((c) => !c.ok)
  writeFileSync(join(WORK, 'checks.json'), JSON.stringify(checks, null, 2))
  log(`${checks.length - failed.length}/${checks.length} checks passed; work dir ${WORK}`)
  process.exitCode = failed.length ? 1 : 0
}
