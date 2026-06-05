import { describe, expect, it } from 'vitest'
import { createStubProvider, createTakeoffVisionProvider, type CliRunner } from './provider.js'

const page = {
  base64: Buffer.from('fake-plan-bytes').toString('base64'),
  mimeType: 'image/png',
  widthPx: 1536,
  heightPx: 1536,
}

describe('createStubProvider', () => {
  it('returns canned extract JSON + a real (shadow) cost, $0 billed', async () => {
    const p = createStubProvider()
    const res = await p.run({ prompt: 'extract walls', page })
    expect(p.id).toBe('stub')
    expect(JSON.parse(res.text)).toMatchObject({ walls: [], notes: ['stub'] })
    expect(res.cost.billedUsd).toBe(0)
    expect(res.cost.shadowApiUsd).toBeGreaterThan(0) // the price if it had been the paid API
  })
})

describe('createCliProvider (gemini-cli) with an injected runner', () => {
  it('passes the prompt + an @file ref to the CLI and prices the run as $0 billed / shadow > 0', async () => {
    let captured: string[] = []
    const fakeRunner: CliRunner = async (args) => {
      captured = args
      return '{"imageSize":{"width":1536,"height":1536},"walls":[{"id":"w1"}],"rooms":[],"openings":[],"dimensionStrings":[],"notes":[]}'
    }
    const provider = createTakeoffVisionProvider('gemini-cli', { runner: fakeRunner })
    const res = await provider.run({ prompt: 'EXTRACT walls and rooms', page })

    expect(provider.id).toBe('gemini-cli')
    expect(captured[0]).toBe('-p') // no -m flag → subscription auto-picks
    expect(captured[1]).toContain('EXTRACT walls and rooms')
    expect(captured[1]).toMatch(/@\S+\.png/) // the @file reference
    expect(JSON.parse(res.text).walls).toHaveLength(1)
    expect(res.cost.provider).toBe('gemini-cli')
    expect(res.cost.billedUsd).toBe(0)
    expect(res.cost.shadowApiUsd).toBeGreaterThan(0)
    expect(res.cost.imageTokens).toBe(258 * 4) // 1536×1536 → 2×2 gemini tiles
  })

  it('uses a .pdf temp file when the page is a PDF', async () => {
    let captured: string[] = []
    const fakeRunner: CliRunner = async (args) => {
      captured = args
      return '{}'
    }
    const provider = createTakeoffVisionProvider('gemini-cli', { runner: fakeRunner })
    await provider.run({ prompt: 'x', page: { ...page, mimeType: 'application/pdf' } })
    expect(captured[1]).toMatch(/@\S+\.pdf/)
  })
})
