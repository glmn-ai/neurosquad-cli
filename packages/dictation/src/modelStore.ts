// Where models live on disk (`<modelsDir>/<model.dirName>/`) and how they get
// there. A file only takes its real name after its size and SHA-256 were
// verified (download.ts), so "every file present at its exact size" is the
// installed check.
import { statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadFileResumable, existingBytes, type FetchLike } from './download.js'
import { asrModelTotalBytes, type AsrModelDescriptor } from './models.js'

export function modelDir(modelsDir: string, model: AsrModelDescriptor): string {
  return join(modelsDir, model.dirName)
}

/**
 * True when every file of the model is on disk at its exact expected size.
 * Contents are not re-hashed here: SHA-256 is checked once, before a file
 * gets its real name, so only later same-size tampering would go unnoticed.
 */
export function isModelInstalled(modelsDir: string, model: AsrModelDescriptor): boolean {
  const dir = modelDir(modelsDir, model)
  return model.files.every((file) => {
    try {
      return statSync(join(dir, file.name)).size === file.bytes
    } catch {
      return false
    }
  })
}

export interface DownloadProgress {
  modelId: string
  downloadedBytes: number
  totalBytes: number
  /** 0..1 across the whole model, resumed bytes included. */
  fraction: number
  done: boolean
}

export interface DownloadModelOptions {
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  /** Minimum interval between progress reports, ms (the final one always fires). */
  progressIntervalMs?: number
  fetch?: FetchLike
}

/**
 * Downloads every missing file of a model into `<modelsDir>/<dirName>`.
 * Idempotent: complete files are skipped, partial ones resume.
 */
export async function downloadModel(
  modelsDir: string,
  model: AsrModelDescriptor,
  options: DownloadModelOptions = {}
): Promise<void> {
  const totalBytes = asrModelTotalBytes(model)
  const interval = options.progressIntervalMs ?? 250
  let downloadedBytes = 0
  let lastReport = 0
  const report = (done: boolean): void => {
    const now = Date.now()
    if (!done && now - lastReport < interval) return
    lastReport = now
    options.onProgress?.({
      modelId: model.id,
      downloadedBytes,
      totalBytes,
      fraction: totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 0,
      done
    })
  }

  const dir = modelDir(modelsDir, model)
  await mkdir(dir, { recursive: true })
  for (const file of model.files) {
    options.signal?.throwIfAborted()
    const destination = join(dir, file.name)
    if ((await existingBytes(destination)) === file.bytes) {
      downloadedBytes += file.bytes
      report(false)
      continue
    }
    // A file under its real name at the wrong size is not ours to trust.
    await rm(destination, { force: true })
    const base = downloadedBytes
    await downloadFileResumable({
      url: file.url,
      destination,
      expectedBytes: file.bytes,
      expectedSha256: file.sha256,
      signal: options.signal,
      fetch: options.fetch,
      onBytes: (inFile) => {
        downloadedBytes = base + inFile
        report(false)
      }
    })
    downloadedBytes = base + file.bytes
  }
  report(true)
}

/** Deletes a downloaded model's directory (only inside `modelsDir`). */
export async function deleteModel(modelsDir: string, model: AsrModelDescriptor): Promise<void> {
  await rm(modelDir(modelsDir, model), { recursive: true, force: true })
}
