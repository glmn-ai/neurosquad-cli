// The dashboard's phone panel (Q): the pairing QR right in the terminal, with the link, the
// mode (this computer / local network / online), when the token expires, who is connected and
// the actions (online, LAN, a new token); and a Notifications tab that sets up ntfy push and
// shows the QR that subscribes the phone in the ntfy app.
//
// The pairing link and the ntfy topic work like passwords: they are fetched from the daemon only
// while this panel is open, shown only here, and dropped when it closes.
import { encode } from 'uqr'
import {
  animations,
  frame,
  seg,
  type Line,
  type Rgb,
  type Seg,
  type Theme
} from '@neurosquad/tui-theme'
import type { PhoneView, PushView, Request } from '../protocol.js'
import type { Canvas } from './canvas.js'
import type { KeyEvent } from './keys.js'
import type { Rect } from './layout.js'
import { fitText } from './widgets.js'

/** The QR's own colours, whatever the theme: phones read dark-on-light with the most contrast. */
export const QR_DARK: Rgb = { r: 0, g: 0, b: 0 }
export const QR_LIGHT: Rgb = { r: 255, g: 255, b: 255 }
/** Light modules around the code (the quiet zone): the panel around it is dark. */
const QR_BORDER = 2

export interface QrBlock {
  lines: Line[]
  /** Cells. */
  width: number
  height: number
  ecc: 'M' | 'L'
}

/**
 * `text` as a QR code of half-block characters: two modules per cell, top and bottom, light
 * modules drawn in the light colour on the dark one (so a terminal without colours still shows
 * light on its dark background). Medium error correction when it fits, else low; null when it
 * does not fit `maxWidth` × `maxHeight` cells.
 */
export function qrBlock(text: string, maxWidth: number, maxHeight: number): QrBlock | null {
  for (const ecc of ['M', 'L'] as const) {
    const qr = encode(text, { ecc, border: QR_BORDER })
    const size = qr.size
    const height = Math.ceil(size / 2)
    if (size > maxWidth || height > maxHeight) continue
    const style = { fg: QR_LIGHT, bg: QR_DARK }
    const lines: Line[] = []
    for (let y = 0; y < size; y += 2) {
      let row = ''
      for (let x = 0; x < size; x++) {
        const top = !qr.data[y]![x]
        // The row below the last one is light (still quiet zone).
        const bottom = y + 1 < size ? !qr.data[y + 1]![x] : true
        row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
      }
      lines.push([seg(row, style)])
    }
    return { lines, width: size, height, ecc }
  }
  return null
}

/** Words to lines of at most `width` cells; a word longer than that (a URL) is cut. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return []
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length) {
      const room = line ? width - line.length - 1 : width
      if (rest.length <= room) {
        line = line ? `${line} ${rest}` : rest
        rest = ''
      } else if (line && rest.length <= width) {
        out.push(line)
        line = ''
      } else {
        const take = Math.max(1, room)
        line = line ? `${line} ${rest.slice(0, take)}` : rest.slice(0, take)
        rest = rest.slice(take)
        out.push(line)
        line = ''
      }
    }
  }
  if (line) out.push(line)
  return out
}

/** "in 11 h 20 min", "in 4 min", "now". */
export function inTime(ms: number): string {
  if (ms <= 60_000) return 'in under a minute'
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 48) return `in ${Math.floor(hours / 24)} days`
  if (hours > 0) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  return `in ${minutes} min`
}

/** A link a phone can open: not this computer's loopback. */
function reachable(link: string): boolean {
  try {
    const host = new URL(link).hostname
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]'
  } catch {
    return false
  }
}

export interface PhonePanelHost {
  request<T = unknown>(request: Request): Promise<T>
  /** Phone access as the daemon last said (the `phones` event). */
  phone(): PhoneView | null
  /** Redraw soon. */
  redraw(): void
  now?: () => number
}

export type PanelTab = 'pairing' | 'notifications'

interface Pending {
  question: string
  yes: () => void
}

export class PhonePanel {
  tab: PanelTab
  /** The pairing links (they carry the token): the online one first, then the network ones. */
  links: string[] = []
  linkIndex = 0
  push: PushView | null = null
  /** Which phone the ntfy QR is for. */
  ntfyFor: 'android' | 'iphone' = 'android'
  busy: string | undefined
  error: string | undefined
  note: string | undefined
  pending: Pending | null = null
  private signature = ''
  private closed = false
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly host: PhonePanelHost,
    tab: PanelTab = 'pairing'
  ) {
    this.tab = tab
    this.signature = this.phoneSignature()
    void this.loadLinks()
    void this.loadPush()
    // The expiry countdown and the spinner move on their own.
    this.ticker = setInterval(() => this.host.redraw(), 1000)
    this.ticker.unref?.()
  }

  private now(): number {
    return this.host.now ? this.host.now() : Date.now()
  }

  close(): void {
    this.closed = true
    this.links = []
    this.push = null
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  /** The QR's link: the selected reachable one (none when phones cannot reach any). */
  currentLink(): string | undefined {
    const usable = this.links.filter(reachable)
    if (!usable.length) return undefined
    return usable[Math.min(this.linkIndex, usable.length - 1)]
  }

  /** What the Notifications QR carries. */
  ntfyLink(): string | undefined {
    if (!this.push?.on) return undefined
    return this.ntfyFor === 'android' ? this.push.androidLink : this.push.topicUrl
  }

  private phoneSignature(): string {
    const phone = this.host.phone()
    if (!phone) return ''
    return JSON.stringify([
      phone.running,
      phone.lan,
      phone.port,
      phone.online?.state,
      phone.online?.url,
      phone.tokenIssuedAt
    ])
  }

  /** Phone access changed (a `phones` event): a new link when the address or the token did. */
  phoneChanged(): void {
    const signature = this.phoneSignature()
    if (signature === this.signature) return
    this.signature = signature
    void this.loadLinks()
  }

  async loadLinks(): Promise<void> {
    try {
      const reply = await this.host.request<{ links?: string[] }>({ t: 'phone', action: 'pair' })
      if (this.closed) return
      this.links = reply.links ?? []
      this.linkIndex = Math.min(this.linkIndex, Math.max(0, this.links.length - 1))
    } catch (error) {
      if (!this.closed) this.error = errorText(error)
    }
    this.host.redraw()
  }

  async loadPush(): Promise<void> {
    try {
      const view = await this.host.request<PushView>({
        t: 'push',
        action: 'status',
        reveal: true
      })
      if (!this.closed) this.push = view
    } catch (error) {
      if (!this.closed) this.error = errorText(error)
    }
    this.host.redraw()
  }

  /** Runs one action: busy while it runs, its error inline. */
  private run(label: string, work: () => Promise<void>): void {
    if (this.busy) return
    this.busy = label
    this.error = undefined
    this.note = undefined
    this.host.redraw()
    work().then(
      () => {
        this.busy = undefined
        this.host.redraw()
      },
      (error: unknown) => {
        this.busy = undefined
        if (!this.closed) this.error = errorText(error)
        this.host.redraw()
      }
    )
  }

  private ask(question: string, yes: () => void): void {
    this.pending = { question, yes }
  }

  // ---- actions --------------------------------------------------------------------------------

  private phoneOn(change: { lan?: boolean; online: boolean }, label: string): void {
    this.run(label, async () => {
      const reply = await this.host.request<{
        status?: { online?: PhoneView['online'] }
      }>({ t: 'phone', action: 'on', ...change })
      const online = reply.status?.online
      if (change.online && online?.state !== 'running') {
        throw new Error(`could not go online: ${online?.error ?? 'the tunnel did not start'}`)
      }
      await this.loadLinks()
      // The online link first: that is the one to scan now.
      if (change.online) this.linkIndex = 0
    })
  }

  goOnline(): void {
    const phone = this.host.phone()
    const lan = phone?.running ? phone.lan : false
    this.ask('Go online? Anyone with the link and token can control your agents.', () =>
      this.phoneOn({ lan, online: true }, 'going online…')
    )
  }

  goOffline(): void {
    const phone = this.host.phone()
    this.ask('Go offline? Phones connected from the internet are cut off.', () =>
      this.phoneOn({ lan: phone?.lan ?? false, online: false }, 'going offline…')
    )
  }

  toggleLan(): void {
    const phone = this.host.phone()
    const online = isOnline(phone)
    if (!phone?.running) {
      this.phoneOn({ lan: true, online: false }, 'turning phone access on…')
      return
    }
    const lan = !phone.lan
    const act = (): void =>
      this.phoneOn(
        { lan, online },
        lan ? 'opening to the local network…' : 'closing to this computer…'
      )
    if (online && phone.online?.mode !== 'named') {
      // The server restarts on the new address, and the quick tunnel with it.
      this.ask(
        `${lan ? 'LAN on' : 'LAN off'}? The quick tunnel restarts at a new address (pair again).`,
        act
      )
    } else act()
  }

  rotate(): void {
    this.ask('New pairing token? Every paired phone is signed out and pairs again.', () =>
      this.run('replacing the token…', async () => {
        await this.host.request({ t: 'phone', action: 'rotate' })
        await this.loadLinks()
        this.note = 'new pairing token: scan the QR again'
      })
    )
  }

  setupPush(): void {
    const act = (): void =>
      this.run('creating the topic…', async () => {
        const view = await this.host.request<PushView>({ t: 'push', action: 'setup' })
        this.push = view
        if (view.keyringMissing) {
          throw new Error(
            'no OS keyring here to keep the topic: set NSQ_NTFY_URL where the daemon starts instead'
          )
        }
        this.note = 'scan the QR with the phone, then t sends a test'
      })
    if (this.push?.on) {
      this.ask('New topic? The phone stops getting notifications until it subscribes again.', act)
    } else act()
  }

  testPush(): void {
    this.run('sending a test…', async () => {
      const view = await this.host.request<PushView>({
        t: 'push',
        action: 'test',
        reveal: true
      })
      this.push = view
      if (view.last && !view.last.ok) throw new Error(`the test failed: ${view.last.error}`)
      this.note = 'test sent: it should be on the phone now'
    })
  }

  pushOff(): void {
    this.ask('Turn phone notifications off?', () =>
      this.run('turning off…', async () => {
        const view = await this.host.request<PushView>({ t: 'push', action: 'off' })
        this.push = view
        if (view.keyringMissing) {
          throw new Error(
            'no OS keyring here: push comes from NSQ_NTFY_URL — remove it where the daemon starts'
          )
        }
        this.note = 'notifications off'
      })
    )
  }

  /** A key; returns 'close' when the panel should go. */
  handleKey(key: KeyEvent): 'close' | undefined {
    const k = key.name
    if (this.pending) {
      const pending = this.pending
      if (k === 'y' || k === 'enter') {
        this.pending = null
        pending.yes()
      } else if (k === 'n' || k === 'escape') this.pending = null
      return undefined
    }
    if (k === 'escape' || k === 'q' || k === 'Q') return 'close'
    if (k === 'tab' || (k === 'left' && key.ctrl) || (k === 'right' && key.ctrl)) {
      this.tab = this.tab === 'pairing' ? 'notifications' : 'pairing'
      this.error = undefined
      this.note = undefined
      if (this.tab === 'notifications') void this.loadPush()
      return undefined
    }
    if (this.busy) return undefined
    if (this.tab === 'pairing') {
      const phone = this.host.phone()
      switch (k) {
        case 'o':
        case 'O':
          if (isOnline(phone)) this.goOffline()
          else this.goOnline()
          return undefined
        case 'l':
          this.toggleLan()
          return undefined
        case 'r':
          if (phone?.running) this.rotate()
          return undefined
        case 'left':
        case 'right': {
          const count = this.links.filter(reachable).length
          if (count > 1) this.linkIndex = (this.linkIndex + (k === 'left' ? count - 1 : 1)) % count
          return undefined
        }
      }
      return undefined
    }
    switch (k) {
      case 's':
      case 'n':
        this.setupPush()
        return undefined
      case 't':
        if (this.push?.on) this.testPush()
        return undefined
      case 'i':
      case 'a':
        this.ntfyFor = this.ntfyFor === 'android' ? 'iphone' : 'android'
        return undefined
      case 'x':
        if (this.push?.on) this.pushOff()
        return undefined
    }
    return undefined
  }

  // ---- drawing --------------------------------------------------------------------------------

  /** Draws the panel centred on a `screen`-sized canvas. */
  draw(canvas: Canvas, theme: Theme, screen: { width: number; height: number }): void {
    const w = Math.min(108, screen.width - 2)
    const h = Math.min(32, screen.height - 2)
    const x = Math.floor((screen.width - w) / 2)
    const y = Math.max(1, Math.floor((screen.height - h) / 2))
    const lines = frame(theme, {
      width: w,
      height: h,
      state: 'focused',
      title: [seg(' Phone ', { fg: 'text', bg: 'tileBg', bold: true })],
      bg: 'tileBg'
    })
    lines.forEach((line, row) => canvas.put(x, y + row, line, w))
    const r: Rect = { x: x + 2, y: y + 1, width: w - 4, height: h - 2 }
    const put = (row: number, line: Line, col = 0, width = r.width - col): void => {
      if (row >= 0 && row < r.height) canvas.put(r.x + col, r.y + row, line, width)
    }
    put(0, this.tabs())
    const content: Rect = { x: r.x, y: r.y + 2, width: r.width, height: r.height - 4 }
    if (this.tab === 'pairing') this.drawPairing(canvas, theme, content)
    else this.drawNotifications(canvas, theme, content)
    put(r.height - 1, this.hints())
  }

  private tabs(): Line {
    const tab = (label: string, on: boolean): Seg =>
      seg(
        ` ${label} `,
        on ? { fg: 'accentFg', bg: 'accent', bold: true } : { fg: 'mutedText', bg: 'tileBg' }
      )
    return [
      tab('Pairing', this.tab === 'pairing'),
      seg(' ', { bg: 'tileBg' }),
      tab('Notifications', this.tab === 'notifications'),
      seg('   Tab switches', { fg: 'faintText', bg: 'tileBg' })
    ]
  }

  private hints(): Line {
    if (this.pending) {
      return [
        seg(`${this.pending.question}  `, { fg: 'warning', bg: 'tileBg', bold: true }),
        seg('y', { fg: 'accentText', bg: 'tileBg', bold: true }),
        seg(' yes  ', { fg: 'mutedText', bg: 'tileBg' }),
        seg('n', { fg: 'accentText', bg: 'tileBg', bold: true }),
        seg(' no', { fg: 'mutedText', bg: 'tileBg' })
      ]
    }
    const phone = this.host.phone()
    const pairs: [string, string][] =
      this.tab === 'pairing'
        ? [
            ['o', isOnline(phone) ? 'go offline' : 'go online'],
            ['l', phone?.running ? (phone.lan ? 'LAN off' : 'LAN on') : 'on for the Wi-Fi'],
            ...(phone?.running ? ([['r', 'new token']] as [string, string][]) : []),
            ...(this.links.filter(reachable).length > 1
              ? ([['←→', 'address']] as [string, string][])
              : []),
            ['Esc', 'close']
          ]
        : this.push?.on
          ? [
              ['t', 'send test'],
              ['i', this.ntfyFor === 'android' ? 'iPhone QR' : 'Android QR'],
              ['n', 'new topic'],
              ['x', 'turn off'],
              ['Esc', 'close']
            ]
          : [
              ['s', 'set up phone notifications'],
              ['Esc', 'close']
            ]
    const line: Line = []
    for (const [k, label] of pairs) {
      line.push(seg(k, { fg: 'accentText', bg: 'tileBg', bold: true }))
      line.push(seg(` ${label}   `, { fg: 'mutedText', bg: 'tileBg' }))
    }
    return line
  }

  /** The status line: busy, an error, a note — or nothing. */
  private statusLines(theme: Theme, width: number): Line[] {
    if (this.busy) {
      return [
        [
          animations.spinner(theme, Date.now(), { bg: 'tileBg' }),
          seg(` ${this.busy}`, { fg: 'accentText', bg: 'tileBg' })
        ]
      ]
    }
    if (this.error) {
      return wrap(this.error, width).map((text) => [seg(text, { fg: 'danger', bg: 'tileBg' })])
    }
    if (this.note) {
      return wrap(this.note, width).map((text) => [seg(text, { fg: 'success', bg: 'tileBg' })])
    }
    return []
  }

  /** QR on the left, `info` on the right (or only `info` when there is no QR or no room). */
  private layout(
    canvas: Canvas,
    area: Rect,
    link: string | undefined,
    info: (width: number, qr: QrBlock | null) => Line[]
  ): void {
    const minInfo = 34
    const qr = link ? qrBlock(link, area.width - minInfo - 3, area.height) : null
    const infoX = qr ? area.x + qr.width + 3 : area.x
    const infoWidth = area.x + area.width - infoX
    qr?.lines.forEach((line, row) => canvas.put(area.x, area.y + row, line, qr.width))
    info(infoWidth, qr).forEach((line, row) => {
      if (row < area.height) canvas.put(infoX, area.y + row, line, infoWidth)
    })
  }

  private drawPairing(canvas: Canvas, theme: Theme, area: Rect): void {
    const phone = this.host.phone()
    const label = (text: string): Seg => seg(fitText(text, 10), { fg: 'mutedText', bg: 'tileBg' })
    const body = (text: string, fg: Seg['fg'] = 'bodyText', bold = false): Seg =>
      seg(text, { fg, bg: 'tileBg', bold })
    if (!phone?.running) {
      const lines: Line[] = [
        [body('Phone access is off.', 'text', true)],
        [],
        [body('Turn it on to see your agents, answer them and send prompts from a phone.')],
        [],
        [
          seg('l', { fg: 'accentText', bg: 'tileBg', bold: true }),
          body('  on for the Wi-Fi: a phone on the same network')
        ],
        [
          seg('o', { fg: 'accentText', bg: 'tileBg', bold: true }),
          body('  online: from anywhere, through a Cloudflare tunnel')
        ],
        [],
        ...this.statusLines(theme, area.width)
      ]
      lines.forEach((line, row) => canvas.put(area.x, area.y + row, line, area.width))
      return
    }
    const link = this.currentLink()
    this.layout(canvas, area, link, (width, qr) => {
      const online = phone.online
      const lines: Line[] = []
      const mode: Seg[] =
        online?.state === 'running'
          ? [
              seg(' ONLINE ', { fg: 'accentFg', bg: 'danger', bold: true }),
              body(` ${online.mode === 'named' ? 'named tunnel' : 'quick tunnel'}`)
            ]
          : [body(phone.lan ? 'Local network' : 'This computer only')]
      lines.push([label('Mode'), ...mode])
      if (online?.state === 'running') {
        for (const text of wrap(
          'Reachable from the internet: anyone with this link controls your agents. o turns it off.',
          width - 10
        ))
          lines.push([label(''), seg(text, { fg: 'danger', bg: 'tileBg' })])
      }
      if (online?.state === 'installing') {
        lines.push([
          label(''),
          body(
            `downloading cloudflared ${Math.floor((online.progress ?? 0) * 100)}% `,
            'accentText'
          ),
          ...animations.progressBar(theme, Date.now(), {
            width: Math.max(6, Math.min(20, width - 40)),
            ratio: online.progress ?? 0
          })
        ])
      } else if (online?.state === 'starting') {
        lines.push([
          label(''),
          animations.spinner(theme, Date.now(), { bg: 'tileBg' }),
          body(' starting the tunnel…', 'accentText')
        ])
      } else if (online?.state === 'error') {
        for (const text of wrap(`online failed: ${online.error ?? 'unknown error'}`, width - 10))
          lines.push([label(''), seg(text, { fg: 'danger', bg: 'tileBg' })])
      }
      lines.push([])
      const usable = this.links.filter(reachable)
      if (link) {
        const which =
          usable.length > 1
            ? `  (${Math.min(this.linkIndex, usable.length - 1) + 1}/${usable.length}, ←→)`
            : ''
        lines.push([
          label('Scan'),
          body('with the phone camera', 'text', true),
          body(which, 'faintText')
        ])
        for (const text of wrap(link, width))
          lines.push([seg(text, { fg: 'accentText', bg: 'tileBg' })])
        lines.push([body('The link is the key to your agents: do not share it.', 'faintText')])
      } else {
        lines.push([body('A phone cannot reach this computer-only address.', 'warning')])
        lines.push([body('l: open it to the Wi-Fi · o: go online', 'mutedText')])
      }
      if (link && !qr) {
        lines.push([body('Make the window bigger to see the QR code.', 'warning')])
      }
      lines.push([])
      const issued = phone.tokenIssuedAt
      lines.push([
        label('Expires'),
        phone.expireHours && issued !== undefined
          ? body(inTime(issued + phone.expireHours * 3_600_000 - this.now()))
          : body('never', 'mutedText'),
        ...(phone.expireHours ? [] : [body('  (nsq phone on --expire 12h)', 'faintText')])
      ])
      const phones = phone.phones
      lines.push([
        label('Phones'),
        body(
          phones.length ? `${phones.length} connected` : 'none connected',
          phones.length ? 'text' : 'mutedText'
        )
      ])
      for (const p of phones.slice(0, 3)) {
        lines.push([
          label(''),
          body(
            fitText(
              `${p.device}  ${p.address}${p.via ? ' (internet)' : ''}${p.open ? '  live' : ''}`,
              width - 10
            ).trimEnd()
          )
        ])
      }
      if (phones.length > 3)
        lines.push([label(''), body(`+${phones.length - 3} more`, 'mutedText')])
      const status = this.statusLines(theme, width)
      if (status.length) lines.push([], ...status)
      return lines
    })
  }

  private drawNotifications(canvas: Canvas, theme: Theme, area: Rect): void {
    const push = this.push
    const label = (text: string): Seg => seg(fitText(text, 10), { fg: 'mutedText', bg: 'tileBg' })
    const body = (text: string, fg: Seg['fg'] = 'bodyText', bold = false): Seg =>
      seg(text, { fg, bg: 'tileBg', bold })
    const lastLine = (): Line[] => {
      const last = push?.last
      if (!last) return [[label('Last push'), body('none yet', 'mutedText')]]
      const at = new Date(last.at).toLocaleTimeString()
      return [
        [
          label('Last push'),
          body(`${at} ${last.kind === 'test' ? 'test' : 'needs you'} — `),
          last.ok
            ? body('delivered', 'success')
            : body(`failed: ${last.error ?? 'error'}`, 'danger')
        ]
      ]
    }
    if (!push?.on) {
      const lines: Line[] = [
        [body('Phone notifications are off.', 'text', true)],
        [],
        ...wrap(
          'When an agent needs you, ntfy sends its name and its question to your phone — nothing else from the terminal.',
          area.width
        ).map((text) => [body(text)]),
        [],
        [
          seg('s', { fg: 'accentText', bg: 'tileBg', bold: true }),
          body('  set up: a new private topic on ntfy.sh, then scan the QR with the phone')
        ],
        [],
        [
          body(
            'Your own ntfy server or an access token: nsq phone push ntfy --url --token',
            'faintText'
          )
        ],
        [],
        ...lastLine(),
        ...(this.statusLines(theme, area.width).length
          ? [[], ...this.statusLines(theme, area.width)]
          : [])
      ]
      lines.forEach((line, row) => canvas.put(area.x, area.y + row, line, area.width))
      return
    }
    this.layout(canvas, area, this.ntfyLink(), (width) => {
      const lines: Line[] = []
      lines.push([
        label('Status'),
        body('on', 'success', true),
        body(` · ntfy on ${push.host ?? '?'}${push.hasToken ? ' with an access token' : ''}`),
        ...(push.source === 'env' ? [body(' (NSQ_NTFY_URL)', 'faintText')] : [])
      ])
      lines.push([])
      if (this.ntfyFor === 'android') {
        lines.push([label('Android'), body('scan with the camera', 'text', true)])
        for (const text of wrap(
          'It opens the ntfy app (Google Play, F-Droid) on this topic and subscribes it.',
          width
        ))
          lines.push([body(text)])
      } else {
        lines.push([label('iPhone'), body('scan with the camera', 'text', true)])
        for (const text of wrap(
          'It opens the topic in the ntfy web app. For the ntfy iOS app: + → Topic name:',
          width
        ))
          lines.push([body(text)])
        lines.push([body(push.topic ?? '?', 'accentText', true)])
        if (push.host && push.host !== 'ntfy.sh') {
          lines.push([body('with "Use another server":', 'mutedText')])
          for (const text of wrap(new URL(push.topicUrl ?? 'https://x/').origin, width))
            lines.push([body(text, 'accentText')])
        }
      }
      lines.push([])
      lines.push([label('Topic')])
      for (const text of wrap(push.topicUrl ?? '', width))
        lines.push([seg(text, { fg: 'accentText', bg: 'tileBg' })])
      lines.push([body('Anyone with the topic can read it: keep it private.', 'faintText')])
      lines.push([])
      lines.push(...lastLine())
      lines.push([body('Own server / token: nsq phone push ntfy --url --token', 'faintText')])
      const status = this.statusLines(theme, width)
      if (status.length) lines.push([], ...status)
      return lines
    })
  }
}

function isOnline(phone: PhoneView | null | undefined): boolean {
  const state = phone?.online?.state
  return state === 'running' || state === 'starting' || state === 'installing'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
