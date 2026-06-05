import { describe, expect, it } from 'vitest'
import {
  anthropicImageTokens,
  estimateTakeoffCost,
  geminiImageTokens,
  projectMonthlyCost,
  MODEL_PRICING,
} from './cost.js'

describe('image tokenization', () => {
  it('gemini: a small image is one 258-token unit', () => {
    expect(geminiImageTokens(300, 300)).toBe(258)
  })
  it('gemini: a large image is tiled into 768px cells × 258 tokens', () => {
    expect(geminiImageTokens(768, 768)).toBe(258) // 1 tile
    expect(geminiImageTokens(1536, 768)).toBe(516) // 2×1 tiles
    expect(geminiImageTokens(1536, 1536)).toBe(258 * 4) // 2×2 tiles
  })
  it('gemini: zero/invalid dimensions cost nothing', () => {
    expect(geminiImageTokens(0, 100)).toBe(0)
  })
  it('anthropic: ≈ pixels / 750', () => {
    expect(anthropicImageTokens(1000, 750)).toBe(1000) // 750000 / 750
  })
})

describe('estimateTakeoffCost', () => {
  const onePage = { pages: [{ widthPx: 1536, heightPx: 1536 }], promptTokens: 2000, outputTokens: 3000 }

  it('FREE path (gemini-cli) bills $0 but reports the shadow API cost (the price of flipping to paid)', () => {
    const est = estimateTakeoffCost({ provider: 'gemini-cli', ...onePage })
    expect(est.model).toBe('gemini-3.1-flash-lite') // the bang-for-buck scale model
    expect(est.imageTokens).toBe(258 * 4)
    expect(est.inputTokens).toBe(258 * 4 + 2000)
    expect(est.billedUsd).toBe(0) // subscription
    // shadow = input 3032/1e6 × 0.25 + output 3000/1e6 × 1.5 = 0.000758 + 0.0045 = 0.005258
    expect(est.shadowApiUsd).toBeCloseTo(0.0053, 4)
    expect(est.shadowApiUsd).toBeGreaterThan(0) // the free→paid delta is visible
  })

  it('local-gpu + stub also bill $0 with a shadow price', () => {
    for (const provider of ['local-gpu', 'stub'] as const) {
      const est = estimateTakeoffCost({ provider, ...onePage })
      expect(est.billedUsd).toBe(0)
      expect(est.shadowApiUsd).toBeGreaterThan(0)
    }
  })

  it('PAID path (gemini-api) bills the metered cost = its shadow cost', () => {
    const est = estimateTakeoffCost({ provider: 'gemini-api', model: 'gemini-2.5-flash', ...onePage })
    expect(est.billedUsd).toBeGreaterThan(0)
    expect(est.billedUsd).toBe(est.shadowApiUsd)
    // flash: input 3032/1e6 × 0.3 + output 3000/1e6 × 2.5 = 0.00091 + 0.0075 ≈ 0.0084
    expect(est.billedUsd).toBeCloseTo(0.0084, 3)
  })

  it('anthropic uses pixel-area tokenization, not gemini tiles', () => {
    const est = estimateTakeoffCost({ provider: 'anthropic-api', model: 'claude-sonnet-4-5', ...onePage })
    expect(est.imageTokens).toBe(anthropicImageTokens(1536, 1536)) // not 258*4
    expect(est.billedUsd).toBeGreaterThan(0)
  })

  it('batch tier halves the metered cost (takeoff is async → the real scale rate)', () => {
    const std = estimateTakeoffCost({ provider: 'gemini-api', model: 'gemini-3.1-flash-lite', ...onePage })
    const batch = estimateTakeoffCost({
      provider: 'gemini-api',
      model: 'gemini-3.1-flash-lite',
      ...onePage,
      tier: 'batch',
    })
    expect(batch.billedUsd).toBeCloseTo(std.billedUsd / 2, 3) // both round to 4dp
  })

  it('throws on an unknown model', () => {
    expect(() => estimateTakeoffCost({ provider: 'gemini-api', model: 'nope', pages: [] })).toThrow(/unknown model/)
  })
})

describe('projectMonthlyCost', () => {
  it('scales a per-takeoff shadow cost to a monthly/annual budget', () => {
    const m = projectMonthlyCost(0.0338, 1000)
    expect(m.monthlyUsd).toBeCloseTo(33.8, 1)
    expect(m.annualUsd).toBeCloseTo(405.6, 1)
  })
})

describe('MODEL_PRICING is a maintainable snapshot', () => {
  it('every entry has positive metered rates + a known image family', () => {
    for (const [, p] of Object.entries(MODEL_PRICING)) {
      expect(p.inputPerMillion).toBeGreaterThan(0)
      expect(p.outputPerMillion).toBeGreaterThan(0)
      expect(['gemini', 'anthropic']).toContain(p.imageModel)
    }
  })
})
