# @neurosquad/dictation

Local voice dictation for terminal apps (used by `nsq`): a global hotkey, microphone capture and
offline speech recognition with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Node.js only,
no Electron.

**Privacy: audio never leaves the machine.** Recording, resampling and recognition all run
in-process. The only network access is the one-time model download from HuggingFace, at a pinned
commit, verified by size and SHA-256. Audio is kept in memory only for the current utterance and is
never written to disk.

## Usage

```ts
import { createDictation } from '@neurosquad/dictation'

const dictation = createDictation({
  modelsDir: join(dataDir, 'models'),
  model: 'parakeet-tdt-0.6b-v3', // default
  hotkey: { accelerator: 'CommandOrControl+Shift+Space', mode: 'auto' },
  onText: (text) => pasteIntoFocusedAgent(text), // paste only — never press Enter for the user
  onPartial: (text) => showPreview(text), // optional, approximate live text
  onState: (state, info) => render(state, info) // idle | downloading | recording | transcribing | error | disposed
})

if (!dictation.isModelInstalled()) await dictation.ensureModel() // progress via onState('downloading')

await dictation.toggle() // or start() / stop() / cancel()

// Before the process exits, always:
await dictation.dispose()
```

- `onText` gets one finished utterance as a single line: newlines and control characters are
  removed, so pasting it into a terminal cannot submit or inject escape sequences.
- `start()`, `stop()`, `toggle()`, `cancel()` never reject; problems arrive as
  `onState('error', { error })` (a `DictationError` with a `code` such as `model-missing`,
  `mic-unavailable`, `hotkey-unavailable`), followed by the state the pipeline settles in.
- `dispose()` removes the hotkey, stops the microphone, aborts downloads and waits (bounded) for any
  model load or decode still running in native code. A native completion that lands after Node has
  started tearing down aborts the process, so await it before `process.exit()`.
- To switch models, dispose the instance and create a new one.

### Hotkey modes

| Mode           | Behaviour                                                                        |
| -------------- | -------------------------------------------------------------------------------- |
| `auto`         | A quick tap starts; the next tap stops. Holding (350 ms+) records until release. |
| `toggle`       | Every press starts or stops.                                                     |
| `push-to-talk` | Records only while the key is held.                                              |

Accelerators use Electron's syntax (`CommandOrControl+Shift+Space`, `Alt+D`, `F9`). The hook is
global: it fires even when the terminal is not focused, and it does not swallow the key, so the
focused app also receives it. Pick a combination your terminal ignores.

The hotkey is optional (omit `hotkey` and call `toggle()` from your own key binding). Where no global
hook is possible — SSH sessions, headless Linux, Wayland without XWayland — the app keeps working and
reports `hotkey-unavailable` once.

## Models

Downloaded on demand into `<modelsDir>/<model dir>/`; nothing is bundled in the package.

| Id                       | Model                                | Size    | Languages           | License   |
| ------------------------ | ------------------------------------ | ------- | ------------------- | --------- |
| `parakeet-tdt-0.6b-v3`   | NVIDIA Parakeet TDT 0.6B v3 (int8)   | ~670 MB | 25 European         | CC-BY-4.0 |
| `whisper-large-v3-turbo` | OpenAI Whisper large-v3-turbo (int8) | ~1 GB   | ~100, auto-detected | MIT       |

Attribution (required by CC-BY-4.0 when Parakeet is offered): "NVIDIA Parakeet-TDT-0.6B-v3, licensed
under CC-BY-4.0." Each descriptor in `ASR_MODELS` carries its `license` and `attribution` strings.

Long utterances are cut at pauses and decoded in parallel; silence is shortened before decoding.

## Microphone

| Backend                 | Platforms                                                                                                                       | Notes                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| PvRecorder (default)    | Windows x64/arm64, macOS x64/arm64, Linux x64                                                                                   | Prebuilt, no tools to install; runs in a worker thread |
| Recorder tool on `PATH` | Linux: `arecord`, `parecord`, `pw-record`, `sox`, `ffmpeg`; macOS: `sox`, `ffmpeg`; Windows: `sox` (`ffmpeg` with `mic.device`) | Fallback, e.g. Linux arm64                             |

Select with `mic: { backend: 'auto' | 'pvrecorder' | 'command', deviceIndex, device, command }`.
`listPvRecorderDevices()` lists input devices. Any rate is accepted: audio is resampled to the
model's 16 kHz with a windowed-sinc filter. A custom `AudioSource` (e.g. `createBufferSource` for a
WAV file) can be passed as `audioSource`.

### Platform notes

- **macOS:** the terminal app (Terminal, iTerm2, …) needs **Microphone** permission, and
  **Accessibility / Input Monitoring** for the global hotkey (System Settings → Privacy & Security).
- **Linux:** the global hotkey needs X11 (`libxtst`); under Wayland use an in-app key binding.
- **Windows:** no extra setup.

## Tests

`npm test` runs the pipeline against synthesized WAV audio with a fake recognizer and a mocked
download (no microphone, no network). An opt-in test runs the real sherpa-onnx recognizer on real
speech with a small model (~104 MB download):

```sh
NSQ_DICTATION_REAL_MODEL=1 npx vitest run packages/dictation/src/recognizer.real.test.ts
```

## Third-party licenses

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`) — Apache-2.0
- [PvRecorder](https://github.com/Picovoice/pvrecorder) (`@picovoice/pvrecorder-node`) — Apache-2.0
- [uiohook-napi](https://github.com/SnosMe/uiohook-napi) — MIT
- Models: Parakeet TDT 0.6B v3 — CC-BY-4.0 (NVIDIA); Whisper large-v3-turbo — MIT (OpenAI)

This package is MIT-licensed.
