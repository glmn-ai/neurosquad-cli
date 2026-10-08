// Git worktree isolation for agents: each isolated agent gets its own branch
// and checkout instead of sharing the workspace's working tree. Plain `git`
// invocations, no library; failures are reported as null/false, not thrown.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

const execFileAsync = promisify(execFile)

// Worktree add/remove check out or delete every tracked file: generous, but
// bounded so a wedged git process can't hang the caller forever.
const TIMEOUT_MS = 30000

/**
 * Variables that point git at another repository, index or work tree. `cwd`
 * does not override them, so a caller (or a git hook) that set one would
 * make these commands act on the wrong repository.
 */
const GIT_LOCATION_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM'
]

/** The environment for git subprocesses: the parent's, without the repository-location variables. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  const drop = new Set(GIT_LOCATION_VARIABLES)
  for (const [key, value] of Object.entries(env)) {
    if (!drop.has(key.toUpperCase())) out[key] = value
  }
  return out
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: TIMEOUT_MS,
    windowsHide: true,
    env: gitEnv()
  })
  return stdout
}

/**
 * A path as given to git: `/` separators on Windows. Elsewhere `\` is an
 * ordinary file-name character and is kept, or `owned/..\x` would reach git
 * as `owned/../x`.
 */
function gitPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/**
 * `git worktree add -b <branch> <worktreePath> HEAD` in `repoRoot`. Returns
 * `worktreePath` on success, `null` on any failure (not a repo, git missing,
 * branch name collision, timeout). Branching from `HEAD` so the isolated copy
 * starts from whatever the workspace's checkout has committed, local-only
 * commits included.
 */
export async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string
): Promise<string | null> {
  try {
    await runGit(repoRoot, ['worktree', 'add', '-b', branch, gitPath(worktreePath), 'HEAD'])
    return worktreePath
  } catch (error) {
    console.error('gitWorktree: addWorktree failed', error)
    return null
  }
}

/** Waits before each retry of a failed remove: a just-killed process tree takes a moment to let go. */
const REMOVE_RETRY_DELAYS_MS = [1000, 3000]

export interface RemoveWorktreeOptions {
  /**
   * The folder the host keeps its own worktrees in. When given, nothing
   * outside it is ever removed (not even through git), and a checkout under
   * it that git cannot remove is deleted directly and dropped from the
   * repository's list.
   */
  ownedRoot?: string
  /** Tests only. */
  retryDelaysMs?: number[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The real path (symlinks and 8.3 short names resolved); for a path that does not exist, its nearest existing parent's. */
function realPath(path: string): string | null {
  const full = resolvePath(path)
  try {
    return realpathSync.native(full)
  } catch {
    const parent = dirname(full)
    if (parent === full) return null
    const base = realPath(parent)
    return base === null ? null : join(base, basename(full))
  }
}

/**
 * A path in the form two names of one folder compare equal in: symlinks
 * resolved (macOS `/var` is `/private/var`, and git lists worktrees by their
 * real path), Windows 8.3 short names expanded (`RUNNER~1`), `/` separators on
 * Windows (a `\` elsewhere is part of a name),
 * no trailing separator, and lower case on Windows (case-insensitive
 * filesystem, drive letters in either case). `null` when nothing of it exists.
 */
export function canonicalPath(path: string): string | null {
  const real = realPath(path)
  if (real === null) return null
  const slashed = process.platform === 'win32' ? real.replaceAll('\\', '/') : real
  // A filesystem root (`/`, `C:/`) keeps its separator.
  const trimmed = /^(?:[A-Za-z]:)?\/$/.test(slashed) ? slashed : slashed.replace(/\/+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** Whether `a` and `b` name the same folder or file (see `canonicalPath`). */
export function samePath(a: string, b: string): boolean {
  const x = canonicalPath(a)
  return x !== null && x === canonicalPath(b)
}

/** `path` is strictly inside `root`, comparing canonical paths (see `canonicalPath`). */
export function isOwnedPath(root: string, path: string): boolean {
  const base = canonicalPath(root)
  const full = canonicalPath(path)
  if (base === null || full === null) return false
  return full !== base && full.startsWith(base.endsWith('/') ? base : base + '/')
}

/** Whether `git worktree list` still names `worktreePath`. */
async function isListed(repoRoot: string, worktreePath: string): Promise<boolean> {
  try {
    const out = await runGit(repoRoot, ['worktree', 'list', '--porcelain'])
    return out
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .some((line) => samePath(line.slice('worktree '.length), worktreePath))
  } catch {
    return false
  }
}

/**
 * The repository's administrative folder for `worktreePath`
 * (`<common dir>/worktrees/<name>`), found by its `gitdir` file — which names
 * the checkout's `.git` — so it is found even when the checkout's own `.git`
 * file is gone or broken.
 */
async function adminDirOf(repoRoot: string, worktreePath: string): Promise<string | null> {
  try {
    let common = (await runGit(repoRoot, ['rev-parse', '--git-common-dir'])).trim()
    if (!common) return null
    if (!isAbsolute(common)) common = resolvePath(repoRoot, common)
    const worktrees = join(common, 'worktrees')
    const want = join(worktreePath, '.git')
    for (const name of readdirSync(worktrees)) {
      try {
        const target = readFileSync(join(worktrees, name, 'gitdir'), 'utf8').trim()
        if (samePath(target, want)) return join(worktrees, name)
      } catch {
        // not an entry
      }
    }
  } catch {
    // no worktrees folder
  }
  return null
}

/**
 * `git worktree remove --force` — when an agent with its own worktree is
 * removed, once its processes have exited. Never throws. `--force` because
 * removing the agent means removing its checkout, uncommitted changes
 * included; the branch stays, so anything the agent committed is still
 * reachable by name.
 *
 * On Windows a process that has only just exited can still hold a file
 * there and the remove fails half-way — so it is retried; a checkout of ours
 * that still will not go is deleted directly, and its entry is dropped from
 * the repository's list. Returns whether the worktree is gone (folder and
 * list entry).
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {}
): Promise<boolean> {
  if (options.ownedRoot && !isOwnedPath(options.ownedRoot, worktreePath)) {
    console.error('gitWorktree: refusing to remove a worktree outside the owned folder')
    return false
  }
  const delays = options.retryDelaysMs ?? REMOVE_RETRY_DELAYS_MS
  const git = async (args: string[]): Promise<string | null> => {
    try {
      await runGit(repoRoot, args)
      return null
    } catch (error) {
      return String(error)
    }
  }
  const pathArg = gitPath(worktreePath)
  let failure: string | null = null
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    failure = await git(['worktree', 'remove', '--force', pathArg])
    if (failure === null)
      return !existsSync(worktreePath) && !(await isListed(repoRoot, worktreePath))
  }
  console.error('gitWorktree: removeWorktree failed', failure)
  if (!options.ownedRoot) return false
  // Our own checkout: delete the folder itself (retrying while Windows lets
  // go of it), then this one entry of the repository's list.
  const admin = await adminDirOf(repoRoot, worktreePath)
  try {
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch (error) {
    console.error('gitWorktree: could not delete the worktree folder', error)
  }
  if (admin && !existsSync(worktreePath)) {
    try {
      await rm(admin, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch (error) {
      console.error('gitWorktree: could not drop the worktree entry', error)
    }
  }
  if (await isListed(repoRoot, worktreePath)) {
    const pruned = await git(['worktree', 'prune'])
    if (pruned !== null) console.error('gitWorktree: worktree prune failed', pruned)
  }
  return !existsSync(worktreePath) && !(await isListed(repoRoot, worktreePath))
}
