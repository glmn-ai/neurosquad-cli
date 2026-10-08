// Git worktree isolation for agents: each isolated agent gets its own branch
// and checkout instead of sharing the workspace's working tree. Plain `git`
// invocations, no library; failures are reported as null/false, not thrown.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

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
    await runGit(repoRoot, [
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath.replaceAll('\\', '/'),
      'HEAD'
    ])
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

/** The canonical path (symlinks resolved); for a path that does not exist, its nearest existing parent's. */
function canonical(path: string): string | null {
  const full = resolvePath(path)
  try {
    return realpathSync.native(full)
  } catch {
    const parent = dirname(full)
    if (parent === full) return null
    const base = canonical(parent)
    return base === null ? null : join(base, basename(full))
  }
}

const sameCase = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path

/** `path` is strictly inside `root`, after resolving symlinks on both. */
export function isOwnedPath(root: string, path: string): boolean {
  const base = canonical(root)
  const full = canonical(path)
  if (base === null || full === null) return false
  const b = sameCase(base)
  const f = sameCase(full)
  return f !== b && f.startsWith(b.endsWith(sep) ? b : b + sep)
}

const normal = (path: string): string =>
  sameCase(resolvePath(path).replaceAll('\\', '/')).replace(/\/+$/, '')

/** Whether `git worktree list` still names `worktreePath`. */
async function isListed(repoRoot: string, worktreePath: string): Promise<boolean> {
  try {
    const out = await runGit(repoRoot, ['worktree', 'list', '--porcelain'])
    const want = normal(worktreePath)
    return out
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .some((line) => normal(line.slice('worktree '.length)) === want)
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
    const want = normal(join(worktreePath, '.git'))
    for (const name of readdirSync(worktrees)) {
      try {
        const target = readFileSync(join(worktrees, name, 'gitdir'), 'utf8').trim()
        if (normal(target) === want) return join(worktrees, name)
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
  const pathArg = worktreePath.replaceAll('\\', '/')
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
