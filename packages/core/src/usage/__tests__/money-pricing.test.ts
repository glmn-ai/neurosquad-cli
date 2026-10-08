// Money and list-price math, against numbers computed by hand (and, where a
// harness recorded its own cost for the same request, against that).
import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../types.js'
import { dollarsToPico, formatUsd, picoShare, picoToDecimal, picoToExactDollars } from '../money.js'
import { MODEL_PRICES, canonicalModel, listCost, priceFor } from '../pricing.js'

const record = (fields: Partial<UsageRecord>): UsageRecord => ({
  id: 't:1',
  source: 'claude-code',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  at: 0,
  sessionId: 's',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  webSearches: 0,
  ...fields
})

describe('dollarsToPico', () => {
  it('parses plain decimals exactly', () => {
    expect(dollarsToPico('0.0336565')).toBe(33_656_500_000n)
    expect(dollarsToPico(220.7456573)).toBe(220_745_657_300_000n)
    expect(dollarsToPico(0)).toBe(0n)
    expect(dollarsToPico('12')).toBe(12_000_000_000_000n)
  })
  it('removes float noise below a picodollar', () => {
    // A real omp record: 31731 cache-write tokens × $2.50/M, stored as a float.
    expect(dollarsToPico(0.07932750000000001)).toBe(79_327_500_000n)
    expect(dollarsToPico(0.07954150000000001)).toBe(79_541_500_000n)
    expect(dollarsToPico(0.1 + 0.2)).toBe(300_000_000_000n)
  })
  it('handles exponent notation', () => {
    expect(dollarsToPico(4e-6)).toBe(4_000_000n)
    expect(dollarsToPico(8.5e-5)).toBe(85_000_000n)
    expect(dollarsToPico('1.5e2')).toBe(150_000_000_000_000n)
    expect(dollarsToPico(1e-13)).toBe(0n)
    expect(dollarsToPico(5e-13)).toBe(1n)
  })
  it('rejects garbage', () => {
    expect(dollarsToPico('abc')).toBeUndefined()
    expect(dollarsToPico(Number.NaN)).toBeUndefined()
    expect(dollarsToPico('')).toBeUndefined()
  })
})

describe('formatting', () => {
  it('rounds half away from zero, once, at display', () => {
    expect(picoToDecimal(1_234_565_000_000n, 2)).toBe('1.23')
    expect(picoToDecimal(1_235_000_000_000n, 2)).toBe('1.24')
    expect(picoToDecimal(4_999_999_999n, 2)).toBe('0.00')
    expect(picoToDecimal(5_000_000_000n, 2)).toBe('0.01')
    expect(picoToDecimal(123n, 12)).toBe('0.000000000123')
  })
  it('shows cents from a dollar up and four decimals below', () => {
    expect(formatUsd(0n)).toBe('$0.00')
    expect(formatUsd(33_656_500_000n)).toBe('$0.0337')
    expect(formatUsd(1_234_567_000_000_000n)).toBe('$1,234.57')
  })
  it('keeps every digit in the exact form', () => {
    expect(picoToExactDollars(33_656_500_000n)).toBe('0.0336565')
    expect(picoToExactDollars(2_000_000_000_000n)).toBe('2')
  })
  it('computes shares from integers', () => {
    expect(picoShare(1n, 3n)).toBe('33.3%')
    expect(picoShare(2n, 3n)).toBe('66.7%')
    expect(picoShare(3n, 3n)).toBe('100%')
    expect(picoShare(1n, 0n)).toBe('0%')
  })
})

describe('price table', () => {
  it('stores every rate as an integer multiple of 10 µ$/MTok (so 1.1x stays exact)', () => {
    for (const price of MODEL_PRICES) {
      for (const rates of [price.standard, price.fast, price.longContext?.rates]) {
        if (!rates) continue
        for (const value of Object.values(rates)) {
          if (value === undefined) continue
          expect(Number.isInteger(value)).toBe(true)
          expect(value % 10).toBe(0)
        }
      }
    }
  })
  it('matches the published Anthropic cache multipliers', () => {
    // 5m write = 1.25x input, 1h write = 2x input (pricing page).
    for (const price of MODEL_PRICES.filter((one) => one.vendor === 'anthropic')) {
      expect(price.standard.cacheWrite5m).toBe((price.standard.input * 5) / 4)
      expect(price.standard.cacheWrite1h).toBe(price.standard.input * 2)
    }
  })
  it('canonicalises ids without guessing', () => {
    expect(canonicalModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(canonicalModel('claude-opus-5[1m]')).toBe('claude-opus-5')
    expect(canonicalModel('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(canonicalModel('gpt-5-2025-08-07')).toBe('gpt-5')
    expect(canonicalModel('claude-3-5-haiku-20241022')).toBe('claude-haiku-3-5')
    expect(priceFor('claude-sonnet-5-mini')).toBeUndefined()
    expect(priceFor('Ornith-1.5-9B-Q6_K')).toBeUndefined()
  })
  it('does not price a model served by an unknown provider', () => {
    expect(priceFor('claude-sonnet-5', 'lmstudio')).toBeUndefined()
    expect(priceFor('claude-sonnet-5', 'anthropic')).toBeDefined()
    expect(priceFor('gpt-5.6-terra', 'anthropic')).toBeUndefined()
  })
})

describe('listCost', () => {
  it('bills every token kind at its own rate (Sonnet 5, both cache TTLs)', () => {
    // 1000 × $2 + 2000 × $10 + 3000 × $0.20 + 3000 × $2.50 (5m) + 1000 × $4 (1h), per million
    // = 0.002 + 0.02 + 0.0006 + 0.0075 + 0.004 = $0.0341
    const cost = listCost(
      record({ input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000, cacheWrite1h: 1000 })
    )
    expect(cost.pico).toBe(34_100_000_000n)
  })
  it('agrees to the picodollar with the cost OpenCode recorded for the same request', () => {
    // A real OpenCode row: claude-sonnet-5, input 2, output 103, cache write 13049, cost 0.0336565.
    const cost = listCost(record({ input: 2, output: 103, cacheWrite: 13049 }))
    expect(cost.pico).toBe(dollarsToPico(0.0336565))
  })
  it('agrees with the cost omp recorded', () => {
    // A real omp record: input 2, output 21, cache write 31731 (5m), total 0.07954150000000001.
    const cost = listCost(record({ input: 2, output: 21, cacheWrite: 31731 }))
    expect(cost.pico).toBe(dollarsToPico(0.07954150000000001))
  })
  it('uses the discounted cache-read rate of Opus 5.5', () => {
    expect(listCost(record({ model: 'claude-opus-5-5', cacheRead: 1_000_000 })).pico).toBe(
      200_000_000_000n
    )
  })
  it('prices fast mode and the US inference multiplier', () => {
    expect(
      listCost(record({ model: 'claude-opus-5', input: 100, output: 100, speed: 'fast' })).pico
    ).toBe(6_000_000_000n)
    expect(listCost(record({ input: 1_000_000, geo: 'us' })).pico).toBe(2_200_000_000_000n)
    // Fast mode on a model without it: no invented price.
    expect(listCost(record({ model: 'claude-sonnet-5', speed: 'fast', input: 1 })).reason).toBe(
      'unpublished-rate'
    )
  })
  it('adds web searches at $10 per 1,000', () => {
    expect(listCost(record({ model: 'claude-opus-5', input: 10, webSearches: 3 })).pico).toBe(
      30_050_000_000n
    )
  })
  it('switches GPT-5.6 to long-context rates only ABOVE 272K prompt tokens', () => {
    const base = { source: 'codex-cli', provider: 'openai', model: 'gpt-5.6-terra', output: 1000 }
    // 272,000 prompt tokens exactly: standard. 72000×$2 + 200000×$0.20 + 1000×$12 = $0.196
    expect(listCost(record({ ...base, input: 72_000, cacheRead: 200_000 })).pico).toBe(
      196_000_000_000n
    )
    // 272,001: the whole request re-priced. 72001×$4 + 200000×$0.40 + 1000×$18 = $0.386004
    expect(listCost(record({ ...base, input: 72_001, cacheRead: 200_000 })).pico).toBe(
      386_004_000_000n
    )
  })
  it('never prices an unknown model or a rate the vendor does not publish', () => {
    expect(listCost(record({ model: 'mystery', input: 5 })).reason).toBe('unknown-model')
    expect(listCost(record({ model: 'mystery', input: 5 })).pico).toBeUndefined()
    expect(listCost(record({ provider: 'openai', model: 'gpt-5.5', cacheWrite: 10 })).reason).toBe(
      'unpublished-rate'
    )
  })
})
