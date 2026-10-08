// One write path for JSON stores. A plain `writeFileSync` truncates the file
// first, so a crash or power loss mid-write leaves half a file. Here the new
// content goes to a temp file beside the target and is renamed over it: the
// target is always either the old file or the new one, never a torn one.
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, rename, rm, writeFile } from 'node:fs/promises'

// Windows: an antivirus scanner, the search indexer or a backup tool briefly
// holding the target makes the rename fail with one of these. It clears
// within milliseconds, so a few short retries almost always succeed.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRIES = 5
const RETRY_DELAY_MS = 15

let sequence = 0

/**
 * The previous content of a file that had to be written in place (the target
 * stayed locked through every retry): `<file>.bak`, kept until the next
 * atomic write succeeds, so a crash during the in-place write still leaves a
 * whole copy for readJsonFile to fall back to.
 */
const backupOf = (file: string): string => `${file}.bak`
const backedUp = new Set<string>()

function backupBeforeInPlace(file: string): void {
  try {
    if (existsSync(file)) {
      copyFileSync(file, backupOf(file))
      backedUp.add(file)
    }
  } catch (error) {
    console.warn(`atomicWrite: could not back up ${file} before an in-place write`, error)
  }
}

/**
 * After a successful atomic write the backup is stale — also one an earlier
 * process left behind (its in-memory record is gone), which readJsonFile
 * would otherwise restore over newer content one day.
 */
function dropBackup(file: string): void {
  backedUp.delete(file)
  rmSync(backupOf(file), { force: true })
}

function pause(ms: number): void {
  // Synchronous on purpose: every store's save is synchronous.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Writes `text` to `file` via temp file + rename. Throws like `writeFileSync` would. */
export function writeFileAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${++sequence}.tmp`
  try {
    writeFileSync(temp, text)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, file)
      dropBackup(file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code && TRANSIENT.has(code) && attempt < RETRIES) {
        pause(RETRY_DELAY_MS * (attempt + 1))
        continue
      }
      // Not a lock (a full disk, a folder in the way…): the in-place write
      // would risk a torn file for nothing. Clean up and report it.
      if (!code || !TRANSIENT.has(code)) {
        rmSync(temp, { force: true })
        throw error
      }
      // Still locked: save in place rather than lose the change — after
      // keeping a whole copy of the old content (readJsonFile falls back to
      // it) — and never leave the temp file behind.
      backupBeforeInPlace(file)
      try {
        writeFileSync(file, text)
      } finally {
        rmSync(temp, { force: true })
      }
      return
    }
  }
}

/**
 * `writeFileAtomic` off the main thread's critical path: the same temp file +
 * rename, but awaited, with the transient-lock retries as timers instead of a
 * blocking wait. For stores that coalesce their saves.
 */
export async function writeFileAtomicAsync(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.${++sequence}.tmp`
  try {
    await writeFile(temp, text)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, file)
      backedUp.delete(file)
      await rm(backupOf(file), { force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code && TRANSIENT.has(code) && attempt < RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
        continue
      }
      if (!code || !TRANSIENT.has(code)) {
        await rm(temp, { force: true })
        throw error
      }
      try {
        await copyFile(file, backupOf(file))
        backedUp.add(file)
      } catch {
        // No old file, or unreadable too: nothing to keep.
      }
      try {
        await writeFile(file, text)
      } finally {
        await rm(temp, { force: true })
      }
      return
    }
  }
}

/**
 * Reads and parses a JSON store file — the read side of the stores above.
 * Content that does not parse is never silently replaced by an empty store
 * (the first save would make the loss permanent): the bad file is moved
 * aside to `<file>.corrupt-<time>` for the user or support to recover, and
 * the backup of an interrupted in-place write (`<file>.bak`) is used when
 * there is one. Throws when nothing usable is left — the caller's own
 * fallback (an empty store) applies then. A read error (a lock) is retried
 * briefly and rethrown without touching the file.
 */
export function readJsonFile(file: string): unknown {
  let text: string | undefined
  for (let attempt = 0; text === undefined; attempt += 1) {
    try {
      text = readFileSync(file, 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code && TRANSIENT.has(code) && attempt < RETRIES) {
        pause(RETRY_DELAY_MS * (attempt + 1))
        continue
      }
      throw error
    }
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    quarantine(file)
    const backup = backupOf(file)
    if (existsSync(backup)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(backup, 'utf-8'))
        console.warn(`atomicWrite: ${file} did not parse; using its backup ${backup}`)
        return parsed
      } catch {
        // The backup is no better: the caller's empty store.
      }
    }
    throw error
  }
}

/** Moves an unparsable store file aside (copies it when it cannot be moved). */
function quarantine(file: string): void {
  const aside = `${file}.corrupt-${Date.now()}`
  try {
    renameSync(file, aside)
  } catch {
    try {
      copyFileSync(file, aside)
    } catch (error) {
      console.error(`atomicWrite: could not keep the unreadable ${file}`, error)
      return
    }
  }
  console.error(`atomicWrite: ${file} is not valid JSON; kept as ${aside}`)
}
