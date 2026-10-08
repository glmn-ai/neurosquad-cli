// The speech-to-text models dictation can run. All of them run locally through
// sherpa-onnx; nothing is sent off the machine. Files are pinned to a fixed
// HuggingFace commit and verified by size and SHA-256 after download.

export type AsrModelId = 'parakeet-tdt-0.6b-v3' | 'whisper-large-v3-turbo'

/** Which sherpa-onnx `modelConfig` shape the model needs. */
export type AsrModelKind = 'transducer' | 'whisper'

/** What a file is to sherpa-onnx — drives `modelConfig` (see recognizer.ts). */
export type AsrFileRole = 'encoder' | 'decoder' | 'joiner' | 'tokens'

export interface AsrModelFile {
  /** Filename on disk, inside the model's own directory. */
  name: string
  role: AsrFileRole
  /** Direct download URL, pinned to a commit (`resolve/<sha>/...`). */
  url: string
  /** Exact size in bytes. */
  bytes: number
  /** Hex SHA-256 the file must hash to. */
  sha256: string
}

export interface AsrModelDescriptor {
  id: string
  kind: AsrModelKind
  /** Display name, e.g. "Whisper large-v3-turbo". */
  name: string
  vendor: string
  /** Parameter count, e.g. "0.6B". */
  params: string
  /** SPDX id of the model weights' license. */
  license: string
  /** Attribution line to show wherever the model is offered. */
  attribution: string
  /** Directory name under `modelsDir`. */
  dirName: string
  files: AsrModelFile[]
  /** Roughly how long each chunk of a long utterance should be (seconds). */
  targetChunkSeconds: number
  /** How many chunks of one utterance are decoded concurrently. */
  parallelDecodes: number
  /** Hard ceiling per chunk in seconds, 0 for none (Whisper truncates past 30 s). */
  maxChunkSeconds: number
  /** Whisper only: `''` lets the model detect the language per utterance. */
  language?: string
}

/** A file of a HuggingFace repo at a fixed commit. */
function hf(repo: { id: string; rev: string }, file: string): string {
  return `https://huggingface.co/${repo.id}/resolve/${repo.rev}/${file}`
}

const PARAKEET_REPO = {
  id: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  rev: '2bda32ec70b097a55adaa07d9a7173915b43cc78'
}
const WHISPER_TURBO_REPO = {
  id: 'csukuangfj/sherpa-onnx-whisper-turbo',
  rev: '2ca6ff69fc878651b770880507669577ac41c2ff'
}

export const ASR_MODELS: readonly AsrModelDescriptor[] = [
  {
    id: 'parakeet-tdt-0.6b-v3',
    kind: 'transducer',
    name: 'Parakeet TDT 0.6B v3',
    vendor: 'NVIDIA',
    params: '0.6B',
    license: 'CC-BY-4.0',
    attribution: 'NVIDIA Parakeet-TDT-0.6B-v3, licensed under CC-BY-4.0.',
    dirName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    files: [
      {
        name: 'encoder.int8.onnx',
        role: 'encoder',
        url: hf(PARAKEET_REPO, 'encoder.int8.onnx'),
        bytes: 652184281,
        sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247'
      },
      {
        name: 'decoder.int8.onnx',
        role: 'decoder',
        url: hf(PARAKEET_REPO, 'decoder.int8.onnx'),
        bytes: 11845275,
        sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e'
      },
      {
        name: 'joiner.int8.onnx',
        role: 'joiner',
        url: hf(PARAKEET_REPO, 'joiner.int8.onnx'),
        bytes: 6355277,
        sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3'
      },
      {
        name: 'tokens.txt',
        role: 'tokens',
        url: hf(PARAKEET_REPO, 'tokens.txt'),
        bytes: 93939,
        sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d'
      }
    ],
    targetChunkSeconds: 8,
    parallelDecodes: 4,
    maxChunkSeconds: 0
  },
  {
    id: 'whisper-large-v3-turbo',
    kind: 'whisper',
    name: 'Whisper large-v3-turbo',
    vendor: 'OpenAI',
    params: '0.8B',
    license: 'MIT',
    attribution: 'OpenAI Whisper large-v3-turbo, licensed under MIT.',
    dirName: 'sherpa-onnx-whisper-turbo',
    files: [
      {
        name: 'turbo-encoder.int8.onnx',
        role: 'encoder',
        url: hf(WHISPER_TURBO_REPO, 'turbo-encoder.int8.onnx'),
        bytes: 674716297,
        sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b'
      },
      {
        name: 'turbo-decoder.int8.onnx',
        role: 'decoder',
        url: hf(WHISPER_TURBO_REPO, 'turbo-decoder.int8.onnx'),
        bytes: 361080764,
        sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547'
      },
      {
        name: 'turbo-tokens.txt',
        role: 'tokens',
        url: hf(WHISPER_TURBO_REPO, 'turbo-tokens.txt'),
        bytes: 816730,
        sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
      }
    ],
    // Whisper pads every decode to a 30 s window, so chunks are long and few,
    // and only two run at once (each holds its own activations).
    targetChunkSeconds: 25,
    parallelDecodes: 2,
    maxChunkSeconds: 28,
    language: ''
  }
]

export const DEFAULT_ASR_MODEL_ID: AsrModelId = 'parakeet-tdt-0.6b-v3'

export function getAsrModel(id: string): AsrModelDescriptor | undefined {
  return ASR_MODELS.find((model) => model.id === id)
}

export function asrModelTotalBytes(model: AsrModelDescriptor): number {
  return model.files.reduce((sum, file) => sum + file.bytes, 0)
}
