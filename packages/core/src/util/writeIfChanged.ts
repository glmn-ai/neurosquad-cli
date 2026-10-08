// Per-spawn config files (a Claude agent's --settings, an OpenCode plugin) are
// rewritten on every start, usually with the very same text. Still
// synchronous — the spawn reads the file right after — but skipped when this
// run already wrote exactly that text and the file is still there.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const written = new Map<string, string>()
const madeDirs = new Set<string>()

/** The file holds exactly `text` (someone may have edited or truncated it since). */
function sameOnDisk(file: string, text: string): boolean {
  try {
    return readFileSync(file, 'utf8') === text
  } catch {
    return false
  }
}

/** Writes `text` to `file` unless it already holds exactly that text. */
export function writeFileIfChanged(file: string, text: string): void {
  if (written.get(file) === text && sameOnDisk(file, text)) return
  const dir = dirname(file)
  if (!madeDirs.has(dir)) {
    mkdirSync(dir, { recursive: true })
    madeDirs.add(dir)
  }
  written.delete(file)
  try {
    writeFileSync(file, text)
  } catch {
    // The folder may have been removed meanwhile: make it again, once.
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, text)
  }
  written.set(file, text)
}

/** A file this process wrote and someone else removed: forget it. */
export function forgetWrittenFile(file: string): void {
  written.delete(file)
}
