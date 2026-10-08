// Git worktree isolation for agent agents ("isolate in worktree" on
// AddAgentButton/KanbanCard): each isolated agent gets its own branch +
// checkout instead of sharing the workspace's own working tree with every
// other agent there. Same execFile + try/catch → null/void philosophy as
// gitStatus.ts — no library, plain `git` invocations, no attempt to
// distinguish *why* a call failed.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { resolve as resolvePath, sep } from 'node:path'

const execFileAsync = promisify(execFile)

// Worktree add/remove do real filesystem work (checking out every tracked
// file), unlike gitStatus.ts's two read-only commands — generous, but still
// bounded so a wedged git process can't hang the caller forever.
const TIMEOUT_MS = 30000

/**
 * `git worktree add -b <branch> <worktreePath> HEAD` in `repoRoot`. Returns
 * `worktreePath` on success, `null` on any failure (not a repo, git missing,
 * branch name collision, timeout) — same "don't guess why" convention as
 * gitStatus.ts's `getGitStatus`. Branching from `HEAD` (not a remote ref) so
 * the isolated copy starts from whatever the workspace's own checkout has
 * committed right now, including local-only commits.
 */
export async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string
): Promise<string | null> {
  try {
    await execFileAsync(
      'git',
      ['worktree', 'add', '-b', branch, worktreePath.replaceAll('\\', '/'), 'HEAD'],
      { cwd: repoRoot, timeout: TIMEOUT_MS, windowsHide: true }
    )
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
   * The folder the host keeps its own worktrees in.
   * A checkout under it that git still cannot remove is deleted directly and
   * then pruned from the repository's list — never anything outside it.
   */
  ownedRoot?: string
  /** Tests only. */
  retryDelaysMs?: number[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isInside(root: string, path: string): boolean {
  const base = resolvePath(root)
  const full = resolvePath(path)
  return full !== base && full.startsWith(base + sep)
}

/**
 * `git worktree remove --force` — called from removal.ts when a
 * worktree-isolated agent is deleted, once its processes have exited. Never
 * throws: this runs as one step of `removeAgentEverywhere`'s cleanup
 * cascade. `--force` because the point of deleting the agent is deleting
 * its whole workspace, uncommitted changes included — only the checkout
 * goes, not the branch, so anything the agent committed stays reachable by
 * branch name (`git branch --list 'agent/*'`) if it's ever needed back.
 *
 * On Windows a process that has only just exited (or a grandchild it left
 * behind) can still hold a file there, and the remove fails half-way — the
 * folder partly deleted, the entry still in `git worktree list`. So it is
 * retried; a checkout of ours that still will not go is deleted directly,
 * and `git worktree prune` drops the entry whose folder is gone. Returns
 * whether the worktree is gone.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {}
): Promise<boolean> {
  const delays = options.retryDelaysMs ?? REMOVE_RETRY_DELAYS_MS
  const git = async (args: string[]): Promise<string | null> => {
    try {
      await execFileAsync('git', args, { cwd: repoRoot, timeout: TIMEOUT_MS, windowsHide: true })
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
    if (failure === null) return true
  }
  console.error('gitWorktree: removeWorktree failed', failure)
  // Our own checkout: delete the folder itself (retrying while Windows lets
  // go of it), then let git forget the entry whose folder is gone.
  if (options.ownedRoot && isInside(options.ownedRoot, worktreePath)) {
    try {
      await rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    } catch (error) {
      console.error('gitWorktree: could not delete the worktree folder', error)
    }
  }
  const pruned = await git(['worktree', 'prune'])
  if (pruned !== null) console.error('gitWorktree: worktree prune failed', pruned)
  return !existsSync(worktreePath)
}
