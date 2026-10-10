import { describe, expect, it } from 'vitest'
import { expandTilde, tildePath } from './paths.js'

describe('tildePath', () => {
  it('shows the home folder as ~ (POSIX)', () => {
    expect(tildePath('/home/ana/project', '/home/ana', 'linux')).toBe('~/project')
    expect(tildePath('/home/ana', '/home/ana/', 'linux')).toBe('~')
    expect(tildePath('/Users/ana/work/shop', '/Users/ana', 'darwin')).toBe('~/work/shop')
  })

  it('leaves paths outside the home alone, including a sibling with the same prefix', () => {
    expect(tildePath('/home/anabel/project', '/home/ana', 'linux')).toBe('/home/anabel/project')
    expect(tildePath('/srv/app', '/home/ana', 'linux')).toBe('/srv/app')
    expect(tildePath('/home/ANA/project', '/home/ana', 'linux')).toBe('/home/ANA/project')
  })

  it('never shortens against a root home', () => {
    expect(tildePath('/srv/app', '/', 'linux')).toBe('/srv/app')
    expect(tildePath('C:\\work', 'C:\\', 'win32')).toBe('C:\\work')
  })

  it('on Windows: either separator, case-insensitive, the rest kept as written', () => {
    expect(tildePath('C:\\Users\\Ana\\project', 'C:\\Users\\ana', 'win32')).toBe('~\\project')
    expect(tildePath('c:/users/ana/project', 'C:\\Users\\Ana', 'win32')).toBe('~/project')
    expect(tildePath('C:\\Users\\Anabel\\x', 'C:\\Users\\Ana', 'win32')).toBe(
      'C:\\Users\\Anabel\\x'
    )
    expect(tildePath('E:\\Github\\project', 'C:\\Users\\Ana', 'win32')).toBe('E:\\Github\\project')
  })
})

describe('expandTilde', () => {
  it('turns ~ back into the home folder', () => {
    expect(expandTilde('~', '/home/ana', 'linux')).toBe('/home/ana')
    expect(expandTilde('~/project', '/home/ana', 'linux')).toBe('/home/ana/project')
    expect(expandTilde('~\\project', 'C:\\Users\\Ana', 'win32')).toBe('C:\\Users\\Ana\\project')
    expect(expandTilde('~/project', 'C:\\Users\\Ana', 'win32')).toBe('C:\\Users\\Ana\\project')
  })

  it('leaves everything else alone (~user, ~\\ on POSIX, plain paths)', () => {
    expect(expandTilde('~bob/x', '/home/ana', 'linux')).toBe('~bob/x')
    expect(expandTilde('~\\x', '/home/ana', 'linux')).toBe('~\\x')
    expect(expandTilde('/srv/app', '/home/ana', 'linux')).toBe('/srv/app')
  })

  it('round-trips what tildePath shows', () => {
    const home = 'C:\\Users\\Ana'
    expect(expandTilde(tildePath('C:\\Users\\Ana\\a\\b', home, 'win32'), home, 'win32')).toBe(
      'C:\\Users\\Ana\\a\\b'
    )
  })
})
