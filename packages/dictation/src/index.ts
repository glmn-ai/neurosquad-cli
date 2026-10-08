export {
  createDictation,
  normalizeTranscript,
  DictationError,
  type Dictation,
  type DictationErrorCode,
  type DictationOptions,
  type DictationState,
  type DictationStateInfo,
  type HotkeyOptions
} from './dictation.js'
export {
  ASR_MODELS,
  DEFAULT_ASR_MODEL_ID,
  asrModelTotalBytes,
  getAsrModel,
  type AsrFileRole,
  type AsrModelDescriptor,
  type AsrModelFile,
  type AsrModelId,
  type AsrModelKind
} from './models.js'
export {
  deleteModel,
  downloadModel,
  isModelInstalled,
  modelDir,
  type DownloadModelOptions,
  type DownloadProgress
} from './modelStore.js'
export type { FetchLike } from './download.js'
export {
  MODEL_SAMPLE_RATE,
  decodeWav,
  encodeWav,
  int16ToFloat32,
  pcm16ToFloat32,
  resample,
  type WavAudio
} from './audio.js'
export {
  createMicSource,
  createBufferSource,
  type BufferSourceOptions,
  createCommandSource,
  createPvRecorderSource,
  detectRecorderCommand,
  listPvRecorderDevices,
  pvRecorderSupported,
  recorderCandidates,
  MicUnavailableError,
  type AudioSource,
  type CaptureInfo,
  type MicOptions,
  type RecorderCommand
} from './capture/index.js'
export {
  HotkeyListener,
  parseAccelerator,
  HOLD_THRESHOLD_MS,
  type HotkeyMode,
  type KeyHook,
  type KeyEvent,
  type ParsedAccelerator
} from './hotkey/listener.js'
export { NativeWork } from './nativeWork.js'
export { loadSherpaEngine, buildModelConfig, type AsrEngine } from './recognizer.js'
