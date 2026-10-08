// One resumable, verified file download: resume a previous partial attempt
// with a Range request, check the size and SHA-256, and only then give the
// file its real name (installed-or-not is decided from filenames alone).
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** The subset of `fetch` used here, injectable for tests. */
export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<Response>

/** How many bytes of a file are already on disk (finished or partial). */
export async function existingBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Hex SHA-256 of a file, streamed. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export interface DownloadFileOptions {
  url: string
  destination: string
  expectedBytes: number
  expectedSha256: string
  signal?: AbortSignal
  /** Bytes so far for this file, including what was resumed. */
  onBytes?: (bytesInThisFile: number) => void
  fetch?: FetchLike
}

export async function downloadFileResumable(options: DownloadFileOptions): Promise<void> {
  const { url, destination, expectedBytes, expectedSha256, signal, onBytes } = options
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init))
  const partPath = `${destination}.part`
  let already = await existingBytes(partPath)
  if (already > expectedBytes) {
    await rm(partPath, { force: true })
    already = 0
  }

  if (already < expectedBytes) {
    let response = await doFetch(url, {
      signal,
      headers: already > 0 ? { Range: `bytes=${already}-` } : {}
    })
    if (already > 0 && response.status === 416) {
      // The server cannot continue this partial file: start it over.
      await response.body?.cancel()
      await rm(partPath, { force: true })
      already = 0
      response = await doFetch(url, { signal, headers: {} })
    }
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} for ${url}`)
    }
    // 206: the range was honoured and the body continues the partial file.
    // Anything else is the whole file again, so the partial is replaced.
    const append = already > 0 && response.status === 206
    if (!append) already = 0
    let received = already
    onBytes?.(received)
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > expectedBytes) {
          callback(new Error(`Server sent more than ${expectedBytes} bytes for ${url}`))
          return
        }
        onBytes?.(received)
        callback(null, chunk)
      }
    })
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(source, counter, createWriteStream(partPath, { flags: append ? 'a' : 'w' }), {
      signal
    })
  } else {
    onBytes?.(already)
  }

  const finalSize = await existingBytes(partPath)
  if (finalSize !== expectedBytes) {
    await rm(partPath, { force: true })
    throw new Error(`Downloaded ${finalSize} bytes, expected ${expectedBytes} (${destination})`)
  }
  const actual = await sha256OfFile(partPath)
  if (actual !== expectedSha256.toLowerCase()) {
    await rm(partPath, { force: true })
    throw new Error(`SHA-256 mismatch for ${url}: got ${actual}, expected ${expectedSha256}`)
  }
  await rename(partPath, destination)
}
