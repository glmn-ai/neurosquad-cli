import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FetchLike } from './download.js'
import { ASR_MODELS, asrModelTotalBytes, type AsrModelDescriptor } from './models.js'
import { downloadModel, isModelInstalled, modelDir, type DownloadProgress } from './modelStore.js'

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

function fakeModel(files: Record<string, Uint8Array>): AsrModelDescriptor {
  const roles = ['encoder', 'decoder', 'tokens'] as const
  return {
    id: 'fake',
    kind: 'whisper',
    name: 'Fake',
    vendor: 'test',
    params: '0',
    license: 'MIT',
    attribution: 'test',
    dirName: 'fake-model',
    files: Object.entries(files).map(([name, data], index) => ({
      name,
      role: roles[index % roles.length],
      url: `https://models.invalid/${name}`,
      bytes: data.length,
      sha256: sha256(data)
    })),
    targetChunkSeconds: 8,
    parallelDecodes: 1,
    maxChunkSeconds: 0
  }
}

interface Served {
  fetch: FetchLike
  requests: { url: string; range?: string }[]
}

/** Serves `files` by URL basename; honours Range unless `ignoreRange`. */
function serve(
  files: Record<string, Uint8Array>,
  opts: { ignoreRange?: boolean; corrupt?: string } = {}
): Served {
  const requests: Served['requests'] = []
  const fetch: FetchLike = async (url, init) => {
    const name = url.split('/').pop()!
    const range = init.headers?.Range
    requests.push({ url, range })
    let body = files[name]
    if (!body) return new Response('missing', { status: 404 })
    if (opts.corrupt === name) {
      body = Uint8Array.from(body)
      body[0] ^= 0xff
    }
    const match = range && !opts.ignoreRange ? /^bytes=(\d+)-$/.exec(range) : null
    if (match) {
      return new Response(body.slice(Number(match[1])), { status: 206 })
    }
    return new Response(body, { status: 200 })
  }
  return { fetch, requests }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nsq-dictation-models-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('model catalogue', () => {
  it('pins every file to a commit and a SHA-256', () => {
    for (const model of ASR_MODELS) {
      expect(asrModelTotalBytes(model)).toBeGreaterThan(0)
      for (const file of model.files) {
        expect(file.url).toMatch(
          /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//
        )
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      }
      const roles = model.files.map((file) => file.role)
      expect(roles).toContain('encoder')
      expect(roles).toContain('decoder')
      expect(roles).toContain('tokens')
      if (model.kind === 'transducer') expect(roles).toContain('joiner')
    }
  })
})

describe('downloadModel', () => {
  const files = {
    'encoder.onnx': randomBytes(70_000),
    'decoder.onnx': randomBytes(30_000),
    'tokens.txt': new TextEncoder().encode('a 1\nb 2\n')
  }

  it('downloads, verifies and reports monotonic progress', async () => {
    const model = fakeModel(files)
    const { fetch } = serve(files)
    const progress: DownloadProgress[] = []
    expect(isModelInstalled(root, model)).toBe(false)
    await downloadModel(root, model, {
      fetch,
      onProgress: (p) => progress.push(p),
      progressIntervalMs: 0
    })
    expect(isModelInstalled(root, model)).toBe(true)
    for (const [name, data] of Object.entries(files)) {
      expect(sha256(readFileSync(join(modelDir(root, model), name)))).toBe(sha256(data))
    }
    const fractions = progress.map((p) => p.fraction)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    expect(progress.at(-1)).toMatchObject({ done: true, fraction: 1, totalBytes: 100_008 })
  })

  it('skips files that are already complete', async () => {
    const model = fakeModel(files)
    const first = serve(files)
    await downloadModel(root, model, { fetch: first.fetch })
    const second = serve(files)
    await downloadModel(root, model, { fetch: second.fetch })
    expect(second.requests).toEqual([])
  })

  it('rejects a file whose SHA-256 does not match and leaves nothing under its name', async () => {
    const model = fakeModel(files)
    const { fetch } = serve(files, { corrupt: 'decoder.onnx' })
    await expect(downloadModel(root, model, { fetch })).rejects.toThrow(/SHA-256 mismatch/)
    const dir = modelDir(root, model)
    expect(existsSync(join(dir, 'decoder.onnx'))).toBe(false)
    expect(existsSync(join(dir, 'decoder.onnx.part'))).toBe(false)
    expect(isModelInstalled(root, model)).toBe(false)
  })

  it('resumes a partial file with a Range request', async () => {
    const model = fakeModel(files)
    const dir = modelDir(root, model)
    await mkdir(dir, { recursive: true })
    writeFileSync(join(dir, 'encoder.onnx.part'), files['encoder.onnx'].subarray(0, 40_000))
    const { fetch, requests } = serve(files)
    await downloadModel(root, model, { fetch })
    expect(requests[0]).toMatchObject({ range: 'bytes=40000-' })
    expect(isModelInstalled(root, model)).toBe(true)
  })

  it('starts over when the server ignores the Range header', async () => {
    const model = fakeModel(files)
    const dir = modelDir(root, model)
    await mkdir(dir, { recursive: true })
    writeFileSync(join(dir, 'encoder.onnx.part'), files['encoder.onnx'].subarray(0, 40_000))
    const { fetch } = serve(files, { ignoreRange: true })
    await downloadModel(root, model, { fetch })
    expect(sha256(readFileSync(join(dir, 'encoder.onnx')))).toBe(sha256(files['encoder.onnx']))
  })

  it('starts over when the server answers a resume with 416', async () => {
    const model = fakeModel(files)
    const dir = modelDir(root, model)
    await mkdir(dir, { recursive: true })
    writeFileSync(join(dir, 'encoder.onnx.part'), randomBytes(1000))
    const inner = serve(files)
    const fetch: FetchLike = async (url, init) =>
      init.headers?.Range ? new Response(null, { status: 416 }) : inner.fetch(url, init)
    await downloadModel(root, model, { fetch })
    expect(sha256(readFileSync(join(dir, 'encoder.onnx')))).toBe(sha256(files['encoder.onnx']))
  })

  it('fails on HTTP errors', async () => {
    const model = fakeModel(files)
    const { fetch } = serve({})
    await expect(downloadModel(root, model, { fetch })).rejects.toThrow(/HTTP 404/)
  })

  it('stops when aborted', async () => {
    const model = fakeModel(files)
    const controller = new AbortController()
    controller.abort()
    const { fetch } = serve(files)
    await expect(downloadModel(root, model, { fetch, signal: controller.signal })).rejects.toThrow()
    expect(isModelInstalled(root, model)).toBe(false)
  })
})
