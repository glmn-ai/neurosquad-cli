import { describe, expect, it } from 'vitest'
import { attachReplay, detachReset } from './attach.js'
import { gridToText } from './grid.js'
import { NO_INPUT_MODES, encodeFocus, encodePaste, hostModeChanges } from './input.js'
import { makeHost, makeView, write } from './__test__/helpers.js'

describe('paste and focus pass-through', () => {
  it('brackets a paste only when the program asked for it', () => {
    expect(encodePaste('a\nb', { bracketedPaste: false })).toBe('a\rb')
    expect(encodePaste('a\r\nb', { bracketedPaste: true })).toBe('\x1b[200~a\rb\x1b[201~')
  })

  it('a paste cannot close the bracket early', () => {
    expect(encodePaste('x\x1b[201~rm -rf /\n', { bracketedPaste: true })).toBe(
      '\x1b[200~xrm -rf /\r\x1b[201~'
    )
  })

  it('reports focus only when the program asked for it', () => {
    expect(encodeFocus(true, { sendFocus: false })).toBe('')
    expect(encodeFocus(true, { sendFocus: true })).toBe('\x1b[I')
    expect(encodeFocus(false, { sendFocus: true })).toBe('\x1b[O')
  })
})

describe('host input modes', () => {
  it('sends only what differs', () => {
    const to = {
      ...NO_INPUT_MODES,
      bracketedPaste: true,
      mouseTracking: 'any' as const,
      mouseEncoding: 'sgr' as const
    }
    expect(hostModeChanges(NO_INPUT_MODES, to)).toBe('\x1b[?2004h\x1b[?1006h\x1b[?1003h')
    expect(hostModeChanges(to, to)).toBe('')
    expect(hostModeChanges(to, NO_INPUT_MODES)).toBe('\x1b[?2004l\x1b[?1006l\x1b[?1003l')
  })

  it('switches everything off when forced', () => {
    const reset = hostModeChanges(NO_INPUT_MODES, NO_INPUT_MODES, true)
    for (const seq of ['?2004l', '?1004l', '?1l', '?1006l', '?1000l', '?1002l', '?1003l']) {
      expect(reset).toContain(`\x1b[${seq}`)
    }
    expect(reset).toContain('\x1b>')
  })
})

describe('raw attach', () => {
  it('replays the screen (alternate included) and resets the host on detach', async () => {
    const view = makeView({ cols: 10, rows: 3 })
    await write(view, 'shell$\x1b[?1049h\x1b[?2004h\x1b[2;3HTUI')
    const host = makeHost(10, 3)
    await write(host, 'garbage')
    await write(host, attachReplay(view))
    const shown = host.snapshot()
    expect(shown.alternate).toBe(true)
    expect(gridToText(shown)).toBe(gridToText(view.snapshot()))
    expect(host.modes().bracketedPaste).toBe(true)
    await write(host, detachReset(view))
    expect(host.modes().bracketedPaste).toBe(false)
    expect(host.snapshot().alternate).toBe(false)
  })
})
