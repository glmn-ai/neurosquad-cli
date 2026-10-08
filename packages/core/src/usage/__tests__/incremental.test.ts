// Incremental reads must give exactly what a full read of the same data gives:
// JsonlSource's per-file re-merge and OpenCodeSource's `time_updated` reads.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { JsonlSource, type LineFormat } from '../jsonlSource.js'
import { OpenCodeSource } from '../sources/opencode.js'

const dir = mkdtempSync(join(tmpdir(), 'ns-usage-incr-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A minimal format: `{ id, at, in, out, sid?, cwd? }` per line; `{ meta }` sets the file's cwd. */
const format = (root: string): LineFormat => ({
  source: 'claude-code',
  roots: () => [root],
  accept: (path) => path.endsWith('.jsonl'),
  sessionFromPath: (path) => path.replace(/^.*[\\/]/, '').replace('.jsonl', ''),
  parseLine(entry, meta, put) {
    const line = entry as { id?: string; at?: number; in?: number; out?: number; meta?: string }
    if (line.meta) {
      meta.cwd = line.meta
      return
    }
    if (!line.id) return
    put({
      nativeId: line.id,
      at: line.at ?? 0,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      input: line.in ?? 0,
      output: line.out ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      webSearches: 0
    })
  }
})

const line = (value: object): string => `${JSON.stringify(value)}\n`

async function fullRead(root: string): Promise<unknown> {
  const fresh = new JsonlSource(format(root))
  await fresh.scan()
  return fresh.records()
}

describe('JsonlSource incremental merge', () => {
  it('matches a full rebuild after appends, cross-file copies, meta-only lines and resets', async () => {
    const root = join(dir, 'jsonl')
    mkdirSync(join(root, 'p'), { recursive: true })
    const a = join(root, 'p', 'a.jsonl')
    const b = join(root, 'p', 'b.jsonl')
    const c = join(root, 'p', 'c.jsonl')
    writeFileSync(a, line({ id: 'r1', at: 10, in: 5, out: 1 }) + line({ id: 'r2', at: 30, in: 7 }))
    writeFileSync(b, line({ id: 'r3', at: 20, in: 2 }))
    const source = new JsonlSource(format(root))
    expect(await source.scan()).toBe(true)
    const first = source.records()
    expect(first).toEqual(await fullRead(root))
    expect(source.records()).toBe(first)

    // Streaming growth of r1 in a, a copy of r1 in a fork (c), a new request in b.
    appendFileSync(a, line({ id: 'r1', at: 12, in: 5, out: 9 }))
    writeFileSync(c, line({ id: 'r1', at: 11, in: 5, out: 4 }) + line({ id: 'r4', at: 5, in: 1 }))
    appendFileSync(b, line({ id: 'r5', at: 25, in: 3 }))
    expect(await source.scan()).toBe(true)
    const second = source.records()
    expect(second).not.toBe(first)
    expect(second).toEqual(await fullRead(root))
    expect(second.map((record) => record.id)).toEqual([
      'claude-code:r4',
      'claude-code:r1',
      'claude-code:r3',
      'claude-code:r5',
      'claude-code:r2'
    ])

    // A line that only names the cwd: the file's records change.
    appendFileSync(b, line({ meta: 'E:/w' }))
    expect(await source.scan()).toBe(true)
    expect(source.records()).toEqual(await fullRead(root))
    expect(source.records().find((record) => record.id === 'claude-code:r3')?.cwd).toBe('E:/w')

    // Rewritten shorter (a reset): its old requests go, unless another file has them.
    writeFileSync(c, line({ id: 'r6', at: 40, in: 4 }))
    expect(await source.scan()).toBe(true)
    expect(source.records()).toEqual(await fullRead(root))

    // Nothing new: same list.
    const settled = source.records()
    expect(await source.scan()).toBe(false)
    expect(source.records()).toBe(settled)
  })
})

interface Db {
  exec(sql: string): void
  close(): void
}

const openDb = (path: string): Db => {
  const sqlite = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(
    'node:sqlite'
  ) as { DatabaseSync: new (path: string) => Db }
  return new sqlite.DatabaseSync(path)
}

const assistant = (output: number, cost: number, cwd = 'E:/w1'): string =>
  JSON.stringify({
    role: 'assistant',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-5',
    cost,
    path: { cwd },
    time: { created: 2 },
    tokens: { input: 2, output, reasoning: 0, cache: { read: 0, write: 10 } }
  })

let tick = 1_000_000
function write(path: string, sql: string): void {
  const db = openDb(path)
  db.exec(sql)
  db.close()
  // A distinct mtime per write, however fast the test runs.
  tick += 10
  utimesSync(path, tick, tick)
}

describe('OpenCodeSource incremental reads', () => {
  it('reads only updated rows and still equals a full read; a deletion forces a full read', async () => {
    const path = join(dir, 'opencode.db')
    write(
      path,
      `CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL);
       CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
       INSERT INTO session VALUES ('ses_1', NULL, 'E:/w1');
       INSERT INTO message VALUES ('m1', 'ses_1', 1, 100, '${assistant(10, 0.01)}');
       INSERT INTO message VALUES ('m2', 'ses_1', 2, 200, '${assistant(20, 0.02)}');`
    )
    const source = new OpenCodeSource(() => path)
    const full = async (): Promise<unknown> => {
      const fresh = new OpenCodeSource(() => path)
      await fresh.scan()
      return fresh.records()
    }
    expect(await source.scan()).toBe(true)
    expect(source.records()).toEqual(await full())

    // m2 finishes streaming (same time_updated as the last seen: still re-read), m3 arrives.
    write(
      path,
      `UPDATE message SET data = '${assistant(25, 0.025)}' WHERE id = 'm2';
       INSERT INTO message VALUES ('m3', 'ses_1', 3, 300, '${assistant(30, 0.03)}');
       INSERT INTO message VALUES ('u1', 'ses_1', 4, 400, '{"role":"user"}');`
    )
    expect(await source.scan()).toBe(true)
    expect(source.records()).toEqual(await full())
    expect(source.records().map((record) => record.output)).toEqual([10, 25, 30])

    // A deleted message: the table shrank, so the whole history is read again.
    write(path, `DELETE FROM message WHERE id = 'm1'; DELETE FROM message WHERE id = 'u1';`)
    expect(await source.scan()).toBe(true)
    expect(source.records()).toEqual(await full())
    expect(source.records().map((record) => record.id)).toEqual(['opencode:m2', 'opencode:m3'])
  })
})
