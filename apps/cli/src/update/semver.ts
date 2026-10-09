// Just enough semver for the updater: x.y.z with an optional prerelease, compared by the rules of
// semver.org (a prerelease sorts before its release; numeric identifiers numerically).

interface Parsed {
  core: [number, number, number]
  pre: string[]
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(text: string): Parsed | null {
  const match = VERSION.exec(text.trim())
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : []
  }
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== null
}

/** <0 when a is older than b, 0 when equal, >0 when newer. Invalid versions sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    const diff = pa.core[i]! - pb.core[i]!
    if (diff) return diff
  }
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx) return -1
    if (ny) return 1
    return x < y ? -1 : 1
  }
  return 0
}

export function isNewer(candidate: string, current: string): boolean {
  return isValidVersion(candidate) && compareVersions(candidate, current) > 0
}

export function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.pre.length ?? 0) > 0
}

/** A build that was never published: the workspace placeholder or a dev tag. */
export function isDevVersion(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return true
  if (parsed.core.every((n) => n === 0)) return true
  return parsed.pre.some((id) => /^(dev|local|snapshot)$/i.test(id))
}

/**
 * Whether `nodeVersion` satisfies an `engines.node` range. Only the forms packages actually use
 * here are understood (`>=x.y.z`, `>=x.y`, `^x.y.z`, `x`, `||`-joined); anything else counts as
 * satisfied — npm itself decides at install time.
 */
export function nodeSatisfies(range: string | undefined, nodeVersion: string): boolean {
  if (!range || !range.trim()) return true
  const node = parseVersion(nodeVersion.replace(/^v/, ''))
  if (!node) return true
  const pad = (text: string): string => {
    const parts = text.split('.')
    while (parts.length < 3) parts.push('0')
    return parts.join('.')
  }
  const one = (part: string): boolean | null => {
    const clauses = part.trim().split(/\s+/).filter(Boolean)
    if (!clauses.length) return null
    for (const clause of clauses) {
      const match = /^(>=|>|\^|~|=)?v?(\d+(?:\.\d+){0,2})$/.exec(clause)
      if (!match) return null
      const want = pad(match[2]!)
      const cmp = compareVersions(`${node.core.join('.')}`, want)
      const [major, minor] = want.split('.').map(Number)
      switch (match[1]) {
        case '>=':
          if (cmp < 0) return false
          break
        case '>':
          if (cmp <= 0) return false
          break
        case '^':
          if (cmp < 0 || node.core[0] !== major) return false
          break
        case '~':
          if (cmp < 0 || node.core[0] !== major || node.core[1] !== minor) return false
          break
        default:
          if (match[2]!.split('.').length === 1 ? node.core[0] !== major : cmp !== 0) return false
      }
    }
    return true
  }
  let understood = false
  for (const part of range.split('||')) {
    const result = one(part)
    if (result === null) continue
    understood = true
    if (result) return true
  }
  return !understood
}
