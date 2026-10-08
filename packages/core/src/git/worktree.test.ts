import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addWorktree, removeWorktree } from './worktree.js'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true })

let root: string
let repo: string
let owned: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-worktree-'))
  repo = join(root, 'repo')
  owned = join(root, 'agent-worktrees')
  execFileSync('git', ['init', '-q', repo], { windowsHide: true })
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

  it('never deletes a folder outside the owned root', async () => {
    const path = join(root, 'elsewhere')
    expect(await addWorktree(repo, path, 'agent/three')).toBe(path)
    breakLink(path)
    expect(await removeWorktree(repo, path, { ownedRoot: owned, retryDelaysMs: [] })).toBe(false)
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
  })
})
