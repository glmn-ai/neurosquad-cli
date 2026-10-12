import { afterEach, describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { createTheme } from '@neurosquad/tui-theme'
import { createTermView, gridToText } from '@neurosquad/term-view'
import type { PhoneView, PushView, Request } from '../protocol.js'
import { Canvas } from './canvas.js'
import { PhonePanel, inTime, qrBlock, wrap } from './phonePanel.js'
import { gridPicture } from './screenshot.js'
import { DaemonTooOldError } from '../client/outdated.js'

const TOKEN = 'ab'.repeat(24)
const TUNNEL = 'https://fake-e2e-tunnel.trycloudflare.com'
const ONLINE_LINK = `${TUNNEL}/?t=${TOKEN}`
const LAN_LINK = `http://192.168.1.20:8766/?t=${TOKEN}`

const theme = createTheme({ colorLevel: 3, unicode: true, isTTY: true, env: {} })

/** What the dashboard would put on the terminal, parsed by a real terminal emulator. */
async function screenshot(panel: PhonePanel, cols = 120, rows = 34) {
  const canvas = new Canvas(cols, rows, { bg: 'appBg' })
  panel.draw(canvas, theme, { width: cols, height: rows })
  const view = createTermView({ cols, rows })
  view.write(canvas.diff(theme, undefined).out)
  await view.flush()
  const grid = view.snapshot()
  view.dispose?.()
  return { grid, text: gridToText(grid) }
}

function decode(grid: Parameters<typeof gridPicture>[0]): string | undefined {
  const picture = gridPicture(grid)
  return jsQR(picture.data, picture.width, picture.height)?.data
}

interface FakeOptions {
  phone: PhoneView | null
  links?: string[]
  push?: PushView
}

function fakeHost(options: FakeOptions) {
  const requests: Request[] = []
  let push = options.push ?? { on: false }
  const host = {
    requests,
    phone: () => options.phone,
    redraw: () => {},
    now: () => 1_000_000,
    async request<T>(request: Request): Promise<T> {
      requests.push(request)
      if (request.t === 'phone' && request.action === 'pair') {
        return { links: options.links ?? [] } as T
      }
      if (request.t === 'push') {
        if (request.action === 'setup') {
          push = {
            on: true,
            source: 'keyring',
            host: 'ntfy.sh',
            topic: 'nsq-0123456789abcdef01234567',
            topicUrl: 'https://ntfy.sh/nsq-0123456789abcdef01234567',
            androidLink: 'ntfy://ntfy.sh/nsq-0123456789abcdef01234567?display=nsq'
          }
        }
        if (request.action === 'test') push = { ...push, last: { at: 1, ok: true, kind: 'test' } }
        return push as T
      }
      return { status: { online: options.phone?.online } } as T
    }
  }
  return host
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const panels: PhonePanel[] = []
afterEach(() => {
  for (const panel of panels.splice(0)) panel.close()
})
function open(host: ReturnType<typeof fakeHost>, tab?: 'pairing' | 'notifications') {
  const panel = new PhonePanel(host, tab)
  panels.push(panel)
  return panel
}

describe('phone panel', () => {
  it('shows the online pairing QR, and a phone camera reads the link from the screen', async () => {
    const phone: PhoneView = {
      running: true,
      lan: true,
      port: 8766,
      phones: [
        {
          address: '198.51.100.30',
          device: 'iPhone · Safari',
          firstSeen: 1,
          lastSeen: 2,
          open: 1,
          via: 'internet'
        }
      ],
      online: { state: 'running', mode: 'quick', url: TUNNEL },
      expireHours: 12,
      tokenIssuedAt: 1_000_000 - 3_600_000
    }
    const host = fakeHost({ phone, links: [ONLINE_LINK, LAN_LINK] })
    const panel = open(host)
    await settle()
    const shot = await screenshot(panel)
    expect(decode(shot.grid)).toBe(ONLINE_LINK)
    expect(shot.text).toContain('ONLINE')
    expect(shot.text).toContain('quick tunnel')
    expect(shot.text).toContain('in 11 h')
    expect(shot.text).toContain('1 connected')
    expect(shot.text).toContain('iPhone · Safari')
    // The other address, with →.
    panel.handleKey({ type: 'key', name: 'right', seq: '' } as never)
    expect(decode((await screenshot(panel)).grid)).toBe(LAN_LINK)
  })

  it('fits a smaller terminal (low error correction) and says so when even that does not fit', async () => {
    const phone: PhoneView = { running: true, lan: true, port: 8766, phones: [] }
    const host = fakeHost({ phone, links: [LAN_LINK] })
    const panel = open(host)
    await settle()
    const small = await screenshot(panel, 90, 28)
    expect(decode(small.grid)).toBe(LAN_LINK)
    const tiny = await screenshot(panel, 80, 18)
    expect(decode(tiny.grid)).toBeUndefined()
    expect(tiny.text).toContain('Make the window bigger')
  })

  it('a computer-only address gets no QR, and the panel offers the Wi-Fi or online', async () => {
    const phone: PhoneView = { running: true, lan: false, port: 8766, phones: [] }
    const panel = open(fakeHost({ phone, links: [`http://127.0.0.1:8766/?t=${TOKEN}`] }))
    await settle()
    const shot = await screenshot(panel)
    expect(decode(shot.grid)).toBeUndefined()
    expect(shot.text).toContain('A phone cannot reach this computer-only address')
    expect(shot.text).not.toContain(TOKEN)
  })

  it('going online, a new token and the LAN ask first, then send the request', async () => {
    const phone: PhoneView = { running: true, lan: false, port: 8766, phones: [] }
    const host = fakeHost({ phone, links: [] })
    const panel = open(host)
    await settle()
    panel.handleKey({ type: 'key', name: 'o', seq: 'o' } as never)
    expect((await screenshot(panel)).text).toContain('Go online?')
    expect(host.requests.some((r) => r.t === 'phone' && r.action === 'on')).toBe(false)
    panel.handleKey({ type: 'key', name: 'y', seq: 'y' } as never)
    await settle()
    expect(host.requests).toContainEqual({ t: 'phone', action: 'on', lan: false, online: true })
    // The tunnel did not come up: the error is shown inline.
    await settle()
    expect((await screenshot(panel)).text).toContain('could not go online')
    panel.handleKey({ type: 'key', name: 'r', seq: 'r' } as never)
    panel.handleKey({ type: 'key', name: 'n', seq: 'n' } as never)
    expect(host.requests.some((r) => r.t === 'phone' && r.action === 'rotate')).toBe(false)
    panel.handleKey({ type: 'key', name: 'r', seq: 'r' } as never)
    panel.handleKey({ type: 'key', name: 'y', seq: 'y' } as never)
    await settle()
    expect(host.requests).toContainEqual({ t: 'phone', action: 'rotate' })
    expect(panel.handleKey({ type: 'key', name: 'escape', seq: '\x1b' } as never)).toBe('close')
  })

  it('sets up notifications and shows the QR the ntfy app subscribes with', async () => {
    const phone: PhoneView = { running: false, lan: false, phones: [] }
    const host = fakeHost({ phone })
    const panel = open(host, 'notifications')
    await settle()
    const off = await screenshot(panel)
    expect(off.text).toContain('Phone notifications are off')
    expect(off.text).toContain('nsq phone push ntfy --url --token')
    panel.handleKey({ type: 'key', name: 's', seq: 's' } as never)
    await settle()
    await settle()
    const android = await screenshot(panel)
    expect(decode(android.grid)).toBe('ntfy://ntfy.sh/nsq-0123456789abcdef01234567?display=nsq')
    expect(android.text).toContain('Android')
    panel.handleKey({ type: 'key', name: 'i', seq: 'i' } as never)
    const iphone = await screenshot(panel)
    expect(decode(iphone.grid)).toBe('https://ntfy.sh/nsq-0123456789abcdef01234567')
    expect(iphone.text).toContain('nsq-0123456789abcdef01234567')
    panel.handleKey({ type: 'key', name: 't', seq: 't' } as never)
    await settle()
    await settle()
    const tested = await screenshot(panel)
    expect(tested.text).toContain('delivered')
    expect(host.requests).toContainEqual({ t: 'push', action: 'test', reveal: true })
  })

  it('an older daemon without push: the explanation and U instead of the request', async () => {
    const phone: PhoneView = { running: false, lan: false, phones: [] }
    let restarted = 0
    const host = {
      ...fakeHost({ phone }),
      supports: (capability: string) => capability !== 'push',
      daemonVersion: () => '0.3.0',
      restartDaemon: () => {
        restarted++
      }
    }
    const panel = open(host, 'notifications')
    await settle()
    const shot = await screenshot(panel)
    expect(shot.text).toContain('Phone notifications need a newer daemon')
    expect(shot.text).toContain('The running daemon is nsq 0.3.0; this needs 0.4.0 or newer.')
    expect(shot.text).toContain('Press U to restart it now')
    expect(shot.text).not.toContain('unknown request')
    // s does not ask a daemon that cannot answer.
    panel.handleKey({ type: 'key', name: 's', seq: 's' } as never)
    await settle()
    expect(host.requests.some((r) => r.t === 'push')).toBe(false)
    // U asks first, then restarts.
    panel.handleKey({ type: 'key', name: 'U', seq: 'U' } as never)
    expect((await screenshot(panel)).text).toContain(
      'Restart the daemon (now 0.3.0) on this nsq now?'
    )
    expect(restarted).toBe(0)
    panel.handleKey({ type: 'key', name: 'y', seq: 'y' } as never)
    expect(restarted).toBe(1)
  })

  it('"unknown request" from a daemon that claimed push still explains itself', async () => {
    const phone: PhoneView = { running: false, lan: false, phones: [] }
    const base = fakeHost({ phone })
    const host = {
      ...base,
      daemonVersion: () => '0.3.0',
      restartDaemon: () => {},
      async request<T>(request: Request): Promise<T> {
        if (request.t === 'push') {
          base.requests.push(request)
          throw new DaemonTooOldError('0.3.0', '0.4.0', 'push')
        }
        return base.request<T>(request)
      }
    }
    const panel = open(host, 'notifications')
    await settle()
    await settle()
    const shot = await screenshot(panel)
    expect(shot.text).toContain('The running daemon is nsq 0.3.0; this needs 0.4.0 or newer.')
    expect(shot.text).toMatch(/U\s+restart the daemon now/)
  })

  it('online needs a newer daemon: explained in the pairing tab, U offered', async () => {
    const phone: PhoneView = { running: true, lan: false, port: 8766, phones: [] }
    const host = {
      ...fakeHost({ phone, links: [] }),
      supports: (capability: string) => capability !== 'phone.online',
      daemonVersion: () => '0.1.2',
      restartDaemon: () => {}
    }
    const panel = open(host)
    await settle()
    panel.handleKey({ type: 'key', name: 'o', seq: 'o' } as never)
    const shot = await screenshot(panel)
    expect(shot.text).toContain('The running daemon is nsq 0.1.2; this needs 0.2.0 or newer.')
    expect(host.requests.some((r) => r.t === 'phone' && r.action === 'on')).toBe(false)
  })

  it('forgets the links when it closes', async () => {
    const phone: PhoneView = { running: true, lan: true, port: 8766, phones: [] }
    const panel = new PhonePanel(fakeHost({ phone, links: [LAN_LINK] }))
    await settle()
    expect(panel.currentLink()).toBe(LAN_LINK)
    panel.close()
    expect(panel.currentLink()).toBeUndefined()
  })
})

describe('panel helpers', () => {
  it('QR sizes: medium correction when it fits, low when only that fits, none otherwise', () => {
    expect(qrBlock(ONLINE_LINK, 60, 30)?.ecc).toBe('M')
    expect(qrBlock(ONLINE_LINK, 41, 21)?.ecc).toBe('L')
    expect(qrBlock(ONLINE_LINK, 30, 15)).toBeNull()
  })

  it('wraps words and cuts long URLs', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
    expect(wrap('https://example.com/abcdef', 10)).toEqual(['https://ex', 'ample.com/', 'abcdef'])
  })

  it('says when the token expires', () => {
    expect(inTime(30_000)).toBe('in under a minute')
    expect(inTime(5 * 60_000)).toBe('in 5 min')
    expect(inTime((11 * 60 + 20) * 60_000)).toBe('in 11 h 20 min')
    expect(inTime(72 * 3_600_000)).toBe('in 3 days')
  })
})
