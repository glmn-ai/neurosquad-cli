import { describe, expect, it } from 'vitest'
import { parseArgs } from './args.js'
import { parseExpireHours } from './commands.js'

describe('nsq phone on --online flags', () => {
  it('reads --expire as hours, days or off', () => {
    expect(parseExpireHours('12')).toBe(12)
    expect(parseExpireHours('12h')).toBe(12)
    expect(parseExpireHours('2d')).toBe(48)
    expect(parseExpireHours('off')).toBeNull()
    expect(parseExpireHours('0')).toBeNull()
    expect(parseExpireHours('-3')).toBeUndefined()
    expect(parseExpireHours('soon')).toBeUndefined()
    expect(parseExpireHours('99999d')).toBeUndefined()
  })

  it('takes values for --expire, --hostname and --tunnel-port, not for --tunnel-token', () => {
    const args = parseArgs([
      'phone',
      'on',
      '--online',
      '--tunnel-token',
      '--hostname',
      'nsq.example.com',
      '--tunnel-port',
      '8767',
      '--expire',
      '12h'
    ])
    expect(args.flags.get('online')).toBe(true)
    expect(args.flags.get('tunnel-token')).toBe(true)
    expect(args.flags.get('hostname')).toBe('nsq.example.com')
    expect(args.flags.get('tunnel-port')).toBe('8767')
    expect(args.flags.get('expire')).toBe('12h')
    expect(args.positional).toEqual(['phone', 'on'])
  })
})
