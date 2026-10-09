import { describe, expect, it } from 'vitest'
import { keyHookUnavailable } from './uiohook.js'

describe('keyHookUnavailable', () => {
  const none = (): boolean => false
  const all = (): boolean => true

  it('lets macOS and Windows try', () => {
    expect(keyHookUnavailable('darwin', {}, none)).toBeUndefined()
    expect(keyHookUnavailable('win32', {}, none)).toBeUndefined()
  })

  it('refuses Linux without an X display (SSH, servers, CI)', () => {
    expect(keyHookUnavailable('linux', {}, all)).toMatch(/no X display/)
    expect(keyHookUnavailable('linux', { DISPLAY: '  ' }, all)).toMatch(/no X display/)
    expect(keyHookUnavailable('linux', { WAYLAND_DISPLAY: 'wayland-0' }, all)).toMatch(/Wayland/)
  })

  it('refuses a local display whose X server is not running', () => {
    expect(keyHookUnavailable('linux', { DISPLAY: ':1' }, none)).toMatch(/not running/)
    const seen: string[] = []
    const exists = (path: string): boolean => (seen.push(path), true)
    expect(keyHookUnavailable('linux', { DISPLAY: ':1.0' }, exists)).toBeUndefined()
    expect(seen).toEqual(['/tmp/.X11-unix/X1'])
  })

  it('lets a forwarded or remote display try', () => {
    expect(keyHookUnavailable('linux', { DISPLAY: 'localhost:10.0' }, none)).toBeUndefined()
  })
})
