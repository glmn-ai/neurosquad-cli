// Dictation end to end, without a microphone: speech synthesised by the OS
// (Windows SAPI; elsewhere the model's sample recording), recognised by the
// real sherpa-onnx pipeline with a small model (Whisper tiny.en, ~104 MB,
// downloaded once with SHA-256 checks), pasted by the nsq daemon into an
// agent — which must receive it as a bracketed paste and no Enter.
//
//   npm run build && node scripts/e2e/dictation-e2e.mjs [--models <dir>]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : fallback
}
const work = resolve(join(ROOT, '..', '.nsq-e2e', `dictation-${Date.now()}`))
const modelsDir = resolve(arg('models', join(ROOT, '.cache', 'models')))
mkdirSync(work, { recursive: true })
mkdirSync(modelsDir, { recursive: true })
process.env.NSQ_HOME = join(work, 'nsq')
process.env.NSQ_NO_NOTIFY = '1'

const dictationPkg = await import(
  pathToFileURL(join(ROOT, 'packages', 'dictation', 'dist', 'index.js')).href
)
const { DaemonClient } = await import(
  pathToFileURL(join(ROOT, 'apps', 'cli', 'dist', 'client', 'client.js')).href
)

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

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok })
  console.log(
    ok ? 'PASS' : 'FAIL',
    name,
    detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)
  )
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. Speech.
const wavPath = join(work, 'speech.wav')
// What the audio says: our own sentence when Windows speaks it, else the
// model repository's sample recording (a LibriSpeech sentence).
let phrase = 'Please run the unit tests and fix the failing one'
if (process.platform === 'win32') {
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${wavPath.replaceAll("'", "''")}', $f); $s.Speak('${phrase}'); $s.Dispose()`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true
  })
} else {
  const response = await fetch(`${REPO}/test_wavs/0.wav`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    '6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f'
  )
    throw new Error('sample wav checksum')
  phrase =
    'After early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels'
  writeFileSync(wavPath, bytes)
}
check('speech audio synthesised', existsSync(wavPath))

// 2. The model (download once, verified).
if (!dictationPkg.isModelInstalled(modelsDir, MODEL)) {
  console.log('downloading the small model (~104 MB)…')
  await dictationPkg.downloadModel(modelsDir, MODEL)
}
check(
  'model installed (sizes and SHA-256 verified on download)',
  dictationPkg.isModelInstalled(modelsDir, MODEL)
)

// 3. An agent that shows what it receives.
const echo = join(work, 'echo-agent.mjs')
writeFileSync(
  echo,
  `process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');process.stdout.write('\x1b[?2004h');console.log('READY');process.stdin.on('data',(d)=>{const pasted=d.includes('\\x1b[200~');const text=d.replace(/\\x1b\\[20[01]~/g,'');console.log((pasted?'PASTE:':'KEYS:')+JSON.stringify(text));if(/\\r|\\n/.test(text))console.log('SUBMITTED')})`
)
const client = await DaemonClient.open('dictation-e2e')
try {
  const { agent } = await client.request({
    t: 'run',
    spec: { harness: 'command', name: 'echo', cwd: work, command: [process.execPath, echo] }
  })
  await sleep(1500)

  // 4. Dictation → paste.
  let recognised = ''
  const states = []
  const dictation = dictationPkg.createDictation({
    modelsDir,
    model: MODEL,
    hotkey: false,
    audioSource: dictationPkg.createBufferSource(
      dictationPkg.decodeWav(readFileSync(wavPath)).samples,
      dictationPkg.decodeWav(readFileSync(wavPath)).sampleRate
    ),
    onText: (text) => {
      recognised += text
      client.post({ t: 'paste', id: agent.id, text })
    },
    onState: (state) => states.push(state)
  })
  const wav = dictationPkg.decodeWav(readFileSync(wavPath))
  await dictation.start()
  await sleep(Math.ceil((wav.samples.length / wav.sampleRate) * 1000) + 500)
  await dictation.stop()
  await dictation.dispose()
  await sleep(1500)
  const words = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  const hit =
    words(phrase).filter((w) => words(recognised).includes(w)).length / words(phrase).length
  check('speech recognised', hit >= 0.6, { recognised, wordsMatched: hit.toFixed(2), states })

  let screen = ''
  const off = client.on((event) => {
    if (event.t === 'screen' && event.id === agent.id) screen = event.data
  })
  await client.request({ t: 'snapshot', id: agent.id })
  await sleep(300)
  off()
  // Sent as a bracketed paste; a Windows console program reading raw keys (as this
  // echo agent does) gets the text without the markers — ConPTY drops them.
  check(
    'the agent received the text',
    /(PASTE|KEYS):.*[A-Za-z]/.test(screen),
    // eslint-disable-next-line no-control-regex -- terminal escapes
    screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-300)
  )
  check('nothing was submitted (no Enter)', !/SUBMITTED/.test(screen))
} finally {
  // The daemon and the scratch folder go whatever happened above.
  await client.request({ t: 'shutdown' }).catch(() => {})
  client.close()
  await sleep(1000)
  rmSync(work, { recursive: true, force: true })
}
const failed = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exitCode = failed ? 1 : 0
