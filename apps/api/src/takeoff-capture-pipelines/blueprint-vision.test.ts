import { describe, expect, it } from 'vitest'
import { captureBlueprintVisionDraft, parseCountScope } from './blueprint-vision.js'

/**
 * Per-symbol AI count (M1) coverage. parseCountScope guards the payload, and
 * captureBlueprintVisionDraft's dry-run honors sheet scope + sensitivity by
 * returning ONE per-symbol `ea` quantity with one marker object per instance.
 *
 * No env (BLUEPRINT_VISION_MODE / *_API_KEY) ⇒ the dry-run path, so this needs
 * no network and no Anthropic/Gemini spend.
 */
describe('parseCountScope', () => {
  it('returns null when count_scope is absent or has no symbol label', () => {
    expect(parseCountScope({})).toBeNull()
    expect(parseCountScope({ count_scope: null })).toBeNull()
    expect(parseCountScope({ count_scope: { sheets: ['M-101'] } })).toBeNull()
    expect(parseCountScope({ count_scope: { symbol: { label: '   ' } } })).toBeNull()
  })

  it('parses a well-formed scope and defaults an unknown sensitivity to NORMAL', () => {
    const scope = parseCountScope({
      count_scope: {
        symbol: { label: 'Diffuser — 24" round', sheet: 'A-104' },
        sheets: ['M-101', 'M-102', '  '],
        sensitivity: 'loose',
      },
    })
    expect(scope).not.toBeNull()
    expect(scope?.symbol.label).toBe('Diffuser — 24" round')
    expect(scope?.symbol.sheet).toBe('A-104')
    // Empty/whitespace sheet entries are filtered out.
    expect(scope?.sheets).toEqual(['M-101', 'M-102'])
    expect(scope?.sensitivity).toBe('LOOSE')

    const fallback = parseCountScope({ count_scope: { symbol: { label: 'X' }, sensitivity: 'nonsense' } })
    expect(fallback?.sensitivity).toBe('NORMAL')
  })
})

describe('captureBlueprintVisionDraft — per-symbol count (dry-run)', () => {
  it('returns a single per-symbol ea quantity with one marker object per instance', async () => {
    const { result } = await captureBlueprintVisionDraft(
      {
        dryRun: true,
        count_scope: { symbol: { label: 'Diffuser — 24" round' }, sheets: ['M-101', 'M-102'], sensitivity: 'NORMAL' },
      },
      '11111111-1111-4111-8111-111111111111',
    )
    // One rolled-up quantity for the chosen symbol.
    expect(result.quantities).toHaveLength(1)
    const q = result.quantities[0]!
    expect(q.unit).toBe('ea')
    expect(q.description).toContain('Diffuser')
    // NORMAL = 5 hits/sheet × 2 sheets = 10 instances.
    expect(q.value).toBe(10)
    // One geometry object (marker) per instance, referenced from the quantity.
    expect(result.geometry?.objects).toHaveLength(10)
    expect(q.geometryRefs).toEqual(result.geometry?.objects?.map((o) => o.id))
    // Each marker carries a bbox origin for the review canvas.
    for (const o of result.geometry?.objects ?? []) {
      expect(Array.isArray(o.bbox)).toBe(true)
      expect(o.category).toBe('Diffuser — 24" round')
    }
  })

  it('honors sheet scope (more sheets ⇒ more instances) and sensitivity (STRICT < LOOSE)', async () => {
    const projectId = '22222222-2222-4222-8222-222222222222'
    const oneSheet = await captureBlueprintVisionDraft(
      { dryRun: true, count_scope: { symbol: { label: 'Outlet' }, sheets: ['M-101'], sensitivity: 'NORMAL' } },
      projectId,
    )
    const twoSheets = await captureBlueprintVisionDraft(
      { dryRun: true, count_scope: { symbol: { label: 'Outlet' }, sheets: ['M-101', 'M-102'], sensitivity: 'NORMAL' } },
      projectId,
    )
    expect(twoSheets.result.quantities[0]!.value).toBeGreaterThan(oneSheet.result.quantities[0]!.value)

    const strict = await captureBlueprintVisionDraft(
      { dryRun: true, count_scope: { symbol: { label: 'Outlet' }, sheets: ['M-101'], sensitivity: 'STRICT' } },
      projectId,
    )
    const loose = await captureBlueprintVisionDraft(
      { dryRun: true, count_scope: { symbol: { label: 'Outlet' }, sheets: ['M-101'], sensitivity: 'LOOSE' } },
      projectId,
    )
    expect(loose.result.quantities[0]!.value).toBeGreaterThan(strict.result.quantities[0]!.value)
  })

  it('falls back to the whole-draft path when no symbol is chosen', async () => {
    const { result } = await captureBlueprintVisionDraft({ dryRun: true }, '33333333-3333-4333-8333-333333333333')
    // Whole-draft EIFS demo has multiple quantities and no per-symbol objects.
    expect(result.quantities.length).toBeGreaterThan(1)
    expect(result.geometry?.objects ?? []).toHaveLength(0)
  })
})

describe('captureBlueprintVisionDraft — provenance honesty', () => {
  it('every synchronous result is explicitly labelled stub-dry-run', async () => {
    // Whole-draft demo stub.
    const wholeDraft = await captureBlueprintVisionDraft({ dryRun: true }, '44444444-4444-4444-8444-444444444444')
    expect(wholeDraft.provenance).toBe('stub-dry-run')
    // Per-symbol count stub.
    const count = await captureBlueprintVisionDraft(
      { dryRun: true, count_scope: { symbol: { label: 'Outlet' }, sheets: ['M-101'], sensitivity: 'NORMAL' } },
      '44444444-4444-4444-8444-444444444444',
    )
    expect(count.provenance).toBe('stub-dry-run')
  })

  it('has no live-provider entry point left in this module (async split)', () => {
    // The LIVE Gemini/Anthropic pipeline moved to @sitelayer/pipe-blueprint
    // (live-capture.ts) and runs in the worker. The synchronous module accepts
    // only (payload, projectId) — there is no parameter through which live
    // bytes can be injected, so the error→DEMO_ROWS fallback class is
    // structurally gone from the HTTP path.
    expect(captureBlueprintVisionDraft.length).toBe(2)
  })
})
