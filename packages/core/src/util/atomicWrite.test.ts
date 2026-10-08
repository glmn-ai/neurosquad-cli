import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJsonFile, writeFileAtomic, writeFileAtomicAsync } from './atomicWrite.js'

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('writeFileAtomic', () => {
  it('replaces the file whole and leaves no temp file behind', () => {
    dir = mkdtempSync(join(tmpdir(), 'ns-atomic-'))
    const file = join(dir, 'store.json')
    writeFileAtomic(file, '{"a":1}')
    writeFileAtomic(file, '{"b":2}')
    expect(readFileSync(file, 'utf-8')).toBe('{"b":2}')
    expect(readdirSync(dir)).toEqual(['store.json'])
  })

  it('throws when the folder is missing, without writing anything', () => {
    dir = mkdtempSync(join(tmpdir(), 'ns-atomic-'))
    expect(() => writeFileAtomic(join(dir as string, 'nope', 'x.json'), '{}')).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('writeFileAtomicAsync', () => {
  it('replaces the file whole and leaves no temp file behind', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ns-atomic-'))
    const file = join(dir, 'store.json')
    await writeFileAtomicAsync(file, '{"a":1}')
    await writeFileAtomicAsync(file, '{"b":2}')
    expect(readFileSync(file, 'utf-8')).toBe('{"b":2}')
    expect(readdirSync(dir)).toEqual(['store.json'])
  })
})

describe('readJsonFile (old audit #22)', () => {
  it('parses a whole file', () => {
    dir = mkdtempSync(join(tmpdir(), 'ns-atomic-'))
    const file = join(dir, 'store.json')
    writeFileSync(file, '[1,2]')
    expect(readJsonFile(file)).toEqual([1, 2])
  })

  it('keeps a file that does not parse as .corrupt-<time> and throws (never silently empty)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ns-atomic-'))
    const file = join(dir, 'agents.json')
    writeFileSync(file, '[{"id":"a"')
    expect(() => readJsonFile(file)).toThrow()
    const names = readdirSync(dir)
    expect(names).not.toContain('agents.json')
    const kept = names.find((name) => name.startsWith('agents.json.corrupt-'))
    expect(kept).toBeDefined()
    expect(readFileSync(join(dir, kept as string), 'utf-8')).toBe('[{"id":"a"')
  })

  it('falls back to the backup of an interrupted in-place write', () => {
    dir = mkdtempSync(join(tmpdir(), 'ns-atomic-'))
    const file = join(dir, 'canvas.json')
    writeFileSync(file, '{"ws":')
    writeFileSync(`${file}.bak`, '{"ws":{"nodes":[]}}')
    expect(readJsonFile(file)).toEqual({ ws: { nodes: [] } })
  })

  it('a missing file is a read error, rethrown untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'ns-atomic-'))
    expect(() => readJsonFile(join(dir as string, 'none.json'))).toThrow(/ENOENT/)
    expect(readdirSync(dir)).toEqual([])
  })
})
