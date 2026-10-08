import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addWorktree,
  canonicalPath,
  gitEnv,
  isOwnedPath,
  removeWorktree,
  samePath
} from './worktree.js'

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

// git lists a worktree by its real path (macOS `/private/var`, Windows long
// names), not necessarily the name it was added under.
const listed = (path: string): boolean =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => samePath(line.slice('worktree '.length), path))

// A second name for `target` (a junction on Windows: no privilege needed).
const alias = (target: string, path: string): string => {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  return path
}

// The Windows 8.3 short name of an existing path; the path itself when the
// volume has short names turned off.
const shortName = (path: string): string =>
  execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`], {
    encoding: 'utf-8',
    windowsHide: true,
    windowsVerbatimArguments: true
  }).trim()

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

  it('a checkout named through a symlinked folder is still found in the list and pruned', async () => {
    // As on macOS: the caller says /var/..., git records /private/var/...
    const via = alias(root, join(mkdtempSync(join(tmpdir(), 'ns-alias-')), 'root'))
    try {
      const path = join(via, 'agent-worktrees', 'four')
      expect(await addWorktree(repo, path, 'agent/four')).toBe(path)
      breakLink(path)
      expect(await removeWorktree(repo, path, { ownedRoot: owned, retryDelaysMs: [0] })).toBe(true)
      expect(existsSync(join(owned, 'four'))).toBe(false)
      expect(listed(join(owned, 'four'))).toBe(false)
    } finally {
      rmSync(dirname(via), { recursive: true, force: true })
    }
  })

  it('never removes a worktree outside the owned root named through a symlinked folder', async () => {
    const via = alias(root, join(mkdtempSync(join(tmpdir(), 'ns-alias-')), 'root'))
    try {
      const path = join(root, 'outside-too')
      expect(await addWorktree(repo, path, 'agent/outside-too')).toBe(path)
      expect(
        await removeWorktree(repo, join(via, 'outside-too'), {
          ownedRoot: join(via, 'agent-worktrees'),
          retryDelaysMs: []
        })
      ).toBe(false)
      expect(existsSync(join(path, 'a.txt'))).toBe(true)
      expect(listed(path)).toBe(true)
    } finally {
      rmSync(dirname(via), { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'a backslash is part of a name off Windows: it cannot step out of the owned root',
    async () => {
      const path = join(root, 'outside')
      expect(await addWorktree(repo, path, 'agent/outside')).toBe(path)
      writeFileSync(join(path, 'work.txt'), 'uncommitted')
      // A child of `owned` literally named `..\outside` — not `owned/../outside`.
      await removeWorktree(repo, join(owned, '..\\outside'), {
        ownedRoot: owned,
        retryDelaysMs: []
      })
      expect(existsSync(join(path, 'work.txt'))).toBe(true)
      expect(listed(path)).toBe(true)
      // A sibling folder named `agent-worktrees\x` is not inside `agent-worktrees`.
      mkdirSync(join(root, 'agent-worktrees\\x'))
      expect(isOwnedPath(owned, join(root, 'agent-worktrees\\x'))).toBe(false)
    }
  )

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

describe('canonicalPath', () => {
  it('resolves a symlinked folder to its real path (macOS /var is /private/var)', () => {
    const real = join(root, 'real')
    mkdirSync(join(real, 'inside'), { recursive: true })
    const link = alias(real, join(root, 'link'))
    expect(canonicalPath(join(link, 'inside'))).toBe(canonicalPath(join(real, 'inside')))
    expect(samePath(join(link, 'inside'), join(real, 'inside'))).toBe(true)
    // Not there yet below the link: its nearest existing parent is resolved.
    expect(samePath(join(link, 'later', 'x'), join(real, 'later', 'x'))).toBe(true)
    expect(isOwnedPath(link, join(real, 'inside'))).toBe(true)
    expect(isOwnedPath(real, join(link, 'inside'))).toBe(true)
    expect(isOwnedPath(link, real)).toBe(false)
    expect(samePath(join(link, 'inside'), join(root, 'inside'))).toBe(false)
  })

  it('uses / separators and no trailing separator', () => {
    const path = canonicalPath(join(repo, 'a.txt'))
    expect(path).not.toBeNull()
    expect(path).not.toContain('\\')
    expect(canonicalPath(repo + '/')).toBe(canonicalPath(repo))
    expect(samePath(repo.replaceAll('\\', '/'), repo)).toBe(true)
    expect(samePath(join(root, 'none'), join(root, 'other'))).toBe(false)
  })

  it.runIf(process.platform === 'win32')(
    'ignores case, drive-letter case included, on Windows',
    () => {
      expect(samePath(repo.toUpperCase(), repo.toLowerCase())).toBe(true)
      const drive = repo.slice(0, 1)
      const flipped =
        (drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()) + repo.slice(1)
      expect(samePath(flipped, repo)).toBe(true)
      expect(isOwnedPath(owned.toUpperCase(), join(owned, 'one'))).toBe(true)
    }
  )

  it.runIf(process.platform === 'win32')('expands Windows 8.3 short names', (ctx) => {
    const long = join(root, 'a folder with a long name')
    mkdirSync(join(long, 'inside'), { recursive: true })
    const short = shortName(long)
    // Short names can be turned off per volume; then there is nothing to expand.
    if (short.toLowerCase() === long.toLowerCase()) ctx.skip()
    expect(short).toContain('~')
    expect(samePath(short, long)).toBe(true)
    expect(samePath(join(short, 'inside'), join(long, 'inside'))).toBe(true)
    expect(isOwnedPath(short, join(long, 'inside'))).toBe(true)
    expect(isOwnedPath(long, join(short, 'inside'))).toBe(true)
    expect(isOwnedPath(join(short, 'inside'), long)).toBe(false)
  })
})
