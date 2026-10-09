// Dictation end to end on a CI runner, without a microphone: a sentence is
// synthesised by the OS's own speech engine (Windows SAPI, macOS `say`,
// Linux `espeak-ng`), recognised by the real sherpa-onnx pipeline with a small
// model (Whisper tiny.en, ~104 MB, SHA-256 checked) and pasted by the nsq
// daemon into an agent, which must get the text as a paste and no Enter.
// With no speech engine on the runner it falls back to the model's sample
// recording (checksum-verified).
//
//   node scripts/e2e-ci/dictation.mjs --root <repo under test> --work <scratch> [--models <dir>]
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { args, makeChecks, makeLog, plain, rootFrom, sleep, writeChecks } from './lib.mjs'

const { get } = args()
const root = rootFrom(get)
const work = resolve(get('work', join(root, '..', '.nsq-e2e', `dictation-${Date.now()}`)))
const modelsDir = resolve(get('models', join(work, 'models')))
mkdirSync(work, { recursive: true })
mkdirSync(modelsDir, { recursive: true })
process.env.NSQ_HOME = join(work, 'nsq')
process.env.NSQ_NO_NOTIFY = '1'

const log = makeLog()
const { rows, check, skip } = makeChecks(log)

const dictationDist = join(root, 'packages', 'dictation', 'dist', 'index.js')
const clientDist = join(root, 'apps', 'cli', 'dist', 'client', 'client.js')
if (!existsSync(dictationDist) || !existsSync(clientDist)) {
  skip('dictation', 'this build has no dictation package or daemon client')
  writeChecks(work, rows)
  process.exit(0)
}
const dictation = await import(pathToFileURL(dictationDist).href)
const { DaemonClient } = await import(pathToFileURL(clientDist).href)

const REPO =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/d026532c022fa99fd789d6b32446a1df7b6bfc43'
const MODEL = {
  id: 'whisper-tiny.en-test',
  kind: 'whisper',
  name: 'Whisper tiny.en (test)',
  vendor: 'OpenAI',
  params: '39M',
  license: 'MIT',
  attribution: 'OpenAI Whisper tiny.en, licensed under MIT.',
  dirName: 'sherpa-onnx-whisper-tiny.en',
  files: [
    {
      name: 'tiny.en-encoder.int8.onnx',
      role: 'encoder',
      url: `${REPO}/tiny.en-encoder.int8.onnx`,
      bytes: 12937772,
      sha256: '0ce578b827c94a961aacb8fa14b02f096504b337e5c94be37c36238cbe3e8bc6'
    },
    {
      name: 'tiny.en-decoder.int8.onnx',
      role: 'decoder',
      url: `${REPO}/tiny.en-decoder.int8.onnx`,
      bytes: 89853865,
      sha256: '06c0e6ff6348d427e51839219d1c886c18cfdf411e629e33f5e1679bff9c1527'
    },
    {
      name: 'tiny.en-tokens.txt',
      role: 'tokens',
      url: `${REPO}/tiny.en-tokens.txt`,
      bytes: 835554,
      sha256: '306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930'
    }
  ],
  targetChunkSeconds: 25,
  parallelDecodes: 1,
  maxChunkSeconds: 28,
  language: 'en'
}

// ---- 1. speech ---------------------------------------------------------------------------
const wavPath = join(work, 'speech.wav')
let phrase = 'Please run the unit tests and fix the failing one'
let engine = null
const has = (cmd) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status ===
  0
try {
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${wavPath.replaceAll("'", "''")}', $f); $s.Speak('${phrase}'); $s.Dispose()`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    })
    engine = 'Windows SAPI'
  } else if (process.platform === 'darwin' && has('say')) {
    execFileSync('say', ['-o', wavPath, '--file-format=WAVE', '--data-format=LEI16@16000', phrase])
    engine = 'macOS say'
  } else if (has('espeak-ng')) {
    execFileSync('espeak-ng', ['-s', '150', '-w', wavPath, phrase])
    engine = 'espeak-ng'
  }
} catch (error) {
  log('speech engine failed:', String(error).slice(0, 300))
  engine = null
}
if (!engine || !existsSync(wavPath)) {
  const response = await globalThis.fetch(`${REPO}/test_wavs/0.wav`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    '6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f'
  )
    throw new Error('sample wav checksum')
  phrase =
    'After early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels'
  writeFileSync(wavPath, bytes)
  engine = 'model sample recording (no speech engine here)'
}
let wav = dictation.decodeWav(readFileSync(wavPath))
if (wav.sampleRate !== 16000)
  wav = { samples: resample(wav.samples, wav.sampleRate, 16000), sampleRate: 16000 }
check('speech audio synthesised', wav.samples.length > 16000, {
  engine,
  seconds: (wav.samples.length / wav.sampleRate).toFixed(1)
})

// ---- 2. the model ------------------------------------------------------------------------
if (!dictation.isModelInstalled(modelsDir, MODEL)) {
  log('downloading the small model (~104 MB)…')
  await dictation.downloadModel(modelsDir, MODEL)
}
check(
  'model installed (sizes and SHA-256 verified on download)',
  dictation.isModelInstalled(modelsDir, MODEL)
)

// ---- 3. an agent that shows what it receives ---------------------------------------------
const echo = join(work, 'echo-agent.mjs')
writeFileSync(
  echo,
  [
    "process.stdin.setRawMode?.(true); process.stdin.setEncoding('utf8')",
    "process.stdout.write('\\x1b[?2004h'); console.log('READY')",
    "process.stdin.on('data', (d) => {",
    "  const pasted = d.includes('\\x1b[200~')",
    "  const text = d.replace(/\\x1b\\[20[01]~/g, '')",
    "  console.log((pasted ? 'PASTE:' : 'KEYS:') + JSON.stringify(text))",
    "  if (/\\r|\\n/.test(text)) console.log('SUBMITTED')",
    '})'
  ].join('\n')
)
const client = await DaemonClient.open('dictation-e2e')
try {
  const { agent } = await client.request({
    t: 'run',
    spec: { harness: 'command', name: 'echo', cwd: work, command: [process.execPath, echo] }
  })
  await sleep(1500)

  // ---- 4. dictation → paste ----------------------------------------------------------------
  let recognised = ''
  const states = []
  const session = dictation.createDictation({
    modelsDir,
    model: MODEL,
    hotkey: false,
    audioSource: dictation.createBufferSource(wav.samples, wav.sampleRate),
    onText: (text) => {
      recognised += text
      client.post({ t: 'paste', id: agent.id, text })
    },
    onState: (state) => states.push(state)
  })
  await session.start()
  await sleep(Math.ceil((wav.samples.length / wav.sampleRate) * 1000) + 500)
  await session.stop()
  await session.dispose()
  await sleep(1500)
  const words = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  const hit =
    words(phrase).filter((w) => words(recognised).includes(w)).length / words(phrase).length
  check('speech recognised', hit >= 0.6, {
    phrase,
    recognised,
    wordsMatched: hit.toFixed(2),
    states
  })

  let screen = ''
  const off = client.on((event) => {
    if (event.t === 'screen' && event.id === agent.id) screen = event.data
  })
  await client.request({ t: 'snapshot', id: agent.id })
  await sleep(300)
  off()
  const text = plain(screen)
  // ConPTY hands a console program reading raw keys the text without the paste markers.
  const received = process.platform === 'win32' ? /(PASTE|KEYS):.*[A-Za-z]/ : /PASTE:.*[A-Za-z]/
  check('the agent received the text as a paste', received.test(text), text.slice(-300))
  check('nothing was submitted (no Enter)', !/SUBMITTED/.test(text))
} finally {
  await client.request({ t: 'shutdown' }).catch(() => {})
  client.close()
  await sleep(1000)
  writeChecks(work, rows)
  rmSync(join(work, 'nsq'), { recursive: true, force: true })
}
const failed = rows.filter((row) => !row.ok).length
log(`${rows.length - failed}/${rows.length} checks passed`)
process.exit(failed ? 1 : 0)

function resample(samples, from, to) {
  const out = new Float32Array(Math.floor((samples.length * to) / from))
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / to
    const a = Math.floor(x)
    const b = Math.min(samples.length - 1, a + 1)
    out[i] = samples[a] + (samples[b] - samples[a]) * (x - a)
  }
  return out
}
