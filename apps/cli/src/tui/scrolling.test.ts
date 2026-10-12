import { describe, expect, it } from 'vitest'
import { createScrollback, createTermView, type TermView } from '@neurosquad/term-view'
import { InputParser, type KeyEvent, type MouseEvent } from './keys.js'
import { applyScrollKey, applyWheel, scrollKey, scrolledLabel } from './scrolling.js'

const keyOf = (seq: string): KeyEvent => {
  const [event] = new InputParser().feed(seq)
  if (event?.type !== 'key') throw new Error(`not a key: ${JSON.stringify(seq)}`)
  return event
}
const mouseOf = (seq: string): MouseEvent => {
  const [event] = new InputParser().feed(seq)
  if (event?.type !== 'mouse') throw new Error(`not a mouse event: ${JSON.stringify(seq)}`)
  return event
}

const write = (view: TermView, data: string): Promise<void> =>
  new Promise((resolve) => view.write(data, resolve))

const SHIFT_PGUP = '\x1b[5;2~'
const SHIFT_PGDN = '\x1b[6;2~'
const SHIFT_HOME = '\x1b[1;2H'
const SHIFT_END = '\x1b[1;2F'
const live = { scrolled: false, alternate: false }

describe('scroll keys', () => {
  it('Shift+PgUp/PgDn/Home/End scroll on the normal screen', () => {
    expect(scrollKey(keyOf(SHIFT_PGUP), live)).toBe('page-up')
    expect(scrollKey(keyOf(SHIFT_PGDN), live)).toBe('page-down')
    expect(scrollKey(keyOf(SHIFT_HOME), live)).toBe('top')
    expect(scrollKey(keyOf(SHIFT_END), live)).toBe('bottom')
  })

  it('plain PgUp/End go to the agent until the view is scrolled back', () => {
    expect(scrollKey(keyOf('\x1b[5~'), live)).toBeNull()
    expect(scrollKey(keyOf('\x1b[F'), live)).toBeNull()
    const scrolled = { scrolled: true, alternate: false }
    expect(scrollKey(keyOf('\x1b[5~'), scrolled)).toBe('page-up')
    expect(scrollKey(keyOf('\x1b[F'), scrolled)).toBe('bottom')
    expect(scrollKey(keyOf('\x1b[4~'), scrolled)).toBe('bottom')
    // Any other key is the agent's (and brings the live view back).
    expect(scrollKey(keyOf('a'), scrolled)).toBeNull()
    expect(scrollKey(keyOf('\r'), scrolled)).toBeNull()
    expect(scrollKey(keyOf('\x1b[A'), scrolled)).toBeNull()
  })

  it('on the alternate screen every key is the agent’s', () => {
    const alternate = { scrolled: false, alternate: true }
    for (const seq of [SHIFT_PGUP, SHIFT_PGDN, SHIFT_HOME, SHIFT_END, '\x1b[5~'])
      expect(scrollKey(keyOf(seq), alternate)).toBeNull()
  })

  it('Ctrl or Alt with them is the agent’s too', () => {
    expect(scrollKey(keyOf('\x1b[5;6~'), live)).toBeNull() // Ctrl+Shift+PgUp
    expect(scrollKey(keyOf('\x1b[5;4~'), live)).toBeNull() // Alt+Shift+PgUp
  })
})

describe('scrolling an agent', () => {
  it('3 lines a wheel notch, a page with Shift or PgUp, follow mode at the bottom', async () => {
    const view = createTermView({ cols: 20, rows: 10, scrollback: 100 })
    const scroll = createScrollback(view)
    let text = ''
    for (let i = 1; i <= 100; i++) text += `${i}\r\n`
    await write(view, text)
    expect(applyWheel(scroll, mouseOf('\x1b[<64;5;5M'))).toBe(true)
    expect(scroll.offset).toBe(3)
    applyWheel(scroll, mouseOf('\x1b[<68;5;5M')) // Shift+wheel up
    expect(scroll.offset).toBe(12)
    applyScrollKey(scroll, scrollKey(keyOf(SHIFT_PGUP), live))
    expect(scroll.offset).toBe(21)
    applyWheel(scroll, mouseOf('\x1b[<65;5;5M'))
    expect(scroll.offset).toBe(18)
    // New output: the same lines stay in view.
    await write(view, 'more\r\nand more\r\n')
    expect(scroll.offset).toBe(20)
    applyScrollKey(scroll, scrollKey(keyOf(SHIFT_END), live))
    expect(scroll.scrolled).toBe(false)
    expect(applyWheel(scroll, mouseOf('\x1b[<65;5;5M'))).toBe(false) // already live
    view.dispose()
  })

  it('labels the scrolled view', () => {
    expect(scrolledLabel(120, true)).toBe('↑ 120 lines · End or any key to return')
    expect(scrolledLabel(1, false)).toBe('↑ 1 line · wheel down or Shift+End to return')
  })
})
