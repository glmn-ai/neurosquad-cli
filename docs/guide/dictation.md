# Voice dictation

Dictate prompts instead of typing them. Speech is recognised **on your machine**; the
text is pasted into the agent's input and **never submitted** — you read it and press Enter.

## Use it

- In the dashboard press **v**: dictation goes to the agent that is open full screen, or else the
  selected one. Press **v** again to stop.
- Or use the **global hotkey**, which works even when the terminal is not focused:
  `Ctrl+Shift+Space` on Windows and Linux, `Cmd+Shift+Space` on macOS. A quick tap starts and the
  next tap stops; holding the keys records until you let go.

The first time, nsq offers to download the speech model. Or do it up front:

```sh
nsq dictation setup        # downloads the model (checked by SHA-256)
nsq dictation status       # model, folder, hotkey
nsq dictation test my.wav  # recognise a WAV file — checks the model without a microphone
```

## Models

| Id                               | Model                                | Size    | Languages           |
| -------------------------------- | ------------------------------------ | ------- | ------------------- |
| `parakeet-tdt-0.6b-v3` (default) | NVIDIA Parakeet TDT 0.6B v3 (int8)   | ~670 MB | 25 European         |
| `whisper-large-v3-turbo`         | OpenAI Whisper large-v3-turbo (int8) | ~1 GB   | ~100, auto-detected |

Pick one in `~/.neurosquad-cli/config.json` (`"dictation": { "model": "whisper-large-v3-turbo" }`)
or per command with `--model`. Models are stored in `~/.neurosquad-cli/models`.
"NVIDIA Parakeet-TDT-0.6B-v3, licensed under CC-BY-4.0."

## Privacy

Audio never leaves the machine: recording, resampling and recognition run inside nsq, and audio is
kept in memory only for the current utterance — never written to disk. The only network access is
the one-time model download. The recognised text is cleaned of newlines and control characters, so
pasting it cannot submit a prompt or inject terminal sequences.

## Settings

```json
{
  "dictation": {
    "enabled": true,
    "hotkey": "F9",
    "mode": "toggle",
    "model": "parakeet-tdt-0.6b-v3"
  }
}
```

- `hotkey` — e.g. `F9`, `Alt+D`, `CommandOrControl+Shift+Space`; `""` turns the global hotkey off
  (the **v** key still works). The hotkey does not swallow the key, so pick one your terminal
  ignores.
- `mode` — `toggle` (press to start, press to stop) or `hold` (push-to-talk); by default a tap
  toggles and a hold records until release.
- `enabled: false` turns dictation off entirely.

## Platforms

- **macOS:** allow your terminal app **Microphone** access, and **Accessibility / Input
  Monitoring** for the global hotkey (System Settings → Privacy & Security).
- **Linux:** the global hotkey needs X11 (`libxtst`); under Wayland use **v**. On Linux arm64 the
  microphone is recorded with a tool on `PATH` (`arecord`, `parecord`, `pw-record`, `sox` or
  `ffmpeg`).
- **Windows:** nothing to set up. Not available on Windows arm64.
- Over SSH there is no global hotkey; **v** works if the machine you run nsq on has the microphone.

Dictation is an optional part of the package: if its native parts cannot load on your system, the
rest of nsq works normally.
