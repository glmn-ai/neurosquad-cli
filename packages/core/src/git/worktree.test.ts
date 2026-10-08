import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addWorktree, gitEnv, isOwnedPath, removeWorktree } from './worktree.js'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true, env: gitEnv() })

let root: string
let repo: string
let owned: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-worktree-'))
  repo = join(root, 'repo')
  owned = join(root, 'agent-worktrees')
  execFileSync('git', ['init', '-q', repo], { windowsHide: true, env: gitEnv() })
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// The `.git` file is hidden on Windows (not writable in place): replaced.
const breakLink = (path: string): void => {
  rmSync(join(path, '.git'), { force: true })
  writeFileSync(join(path, '.git'), 'gitdir: nowhere')
}

const listed = (path: string): boolean =>
  git(repo, 'worktree', 'list', '--porcelain')
    .replaceAll('\\', '/')
    .toLowerCase()
    .includes(path.replaceAll('\\', '/').toLowerCase())

describe('removeWorktree', () => {
  it('removes a worktree', async () => {
    const path = join(owned, 'one')
    expect(await addWorktree(repo, path, 'agent/one')).toBe(path)
    expect(await removeWorktree(repo, path, { ownedRoot: owned, retryDelaysMs: [] })).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(listed(path)).toBe(false)
  })

  it('a checkout of ours git cannot remove is deleted and pruned — no orphan in the list', async () => {
    const path = join(owned, 'two')
    expect(await addWorktree(repo, path, 'agent/two')).toBe(path)
    // Break the link so `git worktree remove` refuses it.
    breakLink(path)
    expect(await removeWorktree(repo, path, { ownedRoot: owned, retryDelaysMs: [0] })).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(listed(path)).toBe(false)
  })

  it('never removes a valid worktree outside the owned root, not even through git', async () => {
    const path = join(root, 'outside')
    expect(await addWorktree(repo, path, 'agent/outside')).toBe(path)
    writeFileSync(join(path, 'work.txt'), 'uncommitted')
    expect(await removeWorktree(repo, path, { ownedRoot: owned, retryDelaysMs: [] })).toBe(false)
    expect(existsSync(join(path, 'work.txt'))).toBe(true)
    expect(listed(path)).toBe(true)
  })

  it('never deletes a folder outside the owned root', async () => {
    const path = join(root, 'elsewhere')
    expect(await addWorktree(repo, path, 'agent/three')).toBe(path)
    breakLink(path)
    expect(await removeWorktree(repo, path, { ownedRoot: owned, retryDelaysMs: [] })).toBe(false)
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
  })
})

describe('gitEnv', () => {
  it('drops the variables that point git at another repository', () => {
    const env = gitEnv({
      PATH: '/bin',
      GIT_DIR: '/x/.git',
      git_work_tree: '/x',
      GIT_INDEX_FILE: 'i',
      GIT_AUTHOR_NAME: 'a'
    })
    expect(env).toEqual({ PATH: '/bin', GIT_AUTHOR_NAME: 'a' })
  })
})

describe('isOwnedPath', () => {
  it('is strictly inside, after resolving the paths', () => {
    expect(isOwnedPath(owned, join(owned, 'one'))).toBe(true)
    expect(isOwnedPath(owned, owned)).toBe(false)
    expect(isOwnedPath(owned, join(owned, '..', 'repo'))).toBe(false)
    expect(isOwnedPath(owned, join(root, 'agent-worktrees-2', 'x'))).toBe(false)
  })
})
