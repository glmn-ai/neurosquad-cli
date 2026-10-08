import { describe, expect, it } from 'vitest'
import { stripAnsi } from './plainText.js'

describe('stripAnsi', () => {
  it('drops colors and titles', () => {
    expect(stripAnsi('\x1b[38;2;1;2;3mNo\x1b[m \x1b]0;title\x07conversation')).toBe(
      'No conversation'
    )
  })
  it('keeps words apart that a renderer separated with cursor moves (macOS)', () => {
    const plain = stripAnsi('Quick\x1b[1Csafety\x1b[Ccheck:\x1b[12;40HIs\x1b[44Gthis')
    expect(plain.replace(/\s+/g, ' ')).toBe('Quick safety check: Is this')
  })
})
