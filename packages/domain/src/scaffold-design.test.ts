import { describe, expect, it } from 'vitest'
import { generateScaffoldModel, aggregatePartDemand, type ScaffoldMemberRole } from './scaffold-design.js'

function countByRole(members: { role: ScaffoldMemberRole }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of members) out[m.role] = (out[m.role] ?? 0) + 1
  return out
}

describe('generateScaffoldModel', () => {
  it('generates the expected members for a 1×1 bay, 1-lift scaffold', () => {
    const model = generateScaffoldModel({
      baysAlongLength: 1,
      baysAlongWidth: 1,
      bayLengthMm: 2500,
      bayWidthMm: 1000,
      liftHeightMm: 2000,
      lifts: 1,
      options: { basePlates: true, guardrails: true, toeboards: false },
    })
    const counts = countByRole(model.members)
    // 4 nodes → 4 base plates, 4 standard segments (1 lift each).
    expect(counts.base_plate).toBe(4)
    expect(counts.standard).toBe(4)
    // Ledgers (length): lifts(1) × (nW+1=2) × nL(1) = 2.
    expect(counts.ledger).toBe(2)
    // Transoms (width): lifts(1) × (nL+1=2) × nW(1) = 2.
    expect(counts.transom).toBe(2)
    // Braces: 2 long faces × nL(1) × lifts(1) = 2.
    expect(counts.brace).toBe(2)
    // Deck: top lift, 1 bay = 1.
    expect(counts.deck).toBe(1)
    // Guardrail perimeter at top: 2×nL + 2×nW = 2 + 2 = 4.
    expect(counts.guardrail).toBe(4)
    expect(counts.toeboard ?? 0).toBe(0)
    expect(model.bounds).toEqual({ lengthMm: 2500, widthMm: 1000, heightMm: 2000 })
  })

  it('scales standards and base plates with the node grid', () => {
    const model = generateScaffoldModel({
      baysAlongLength: 3,
      baysAlongWidth: 2,
      bayLengthMm: 2500,
      bayWidthMm: 1000,
      liftHeightMm: 2000,
      lifts: 4,
      options: { basePlates: true, guardrails: false, deckLifts: [4] },
    })
    const counts = countByRole(model.members)
    const nodes = (3 + 1) * (2 + 1) // 12
    expect(counts.base_plate).toBe(nodes) // 12
    expect(counts.standard).toBe(nodes * 4) // one segment per lift → 48
    expect(counts.guardrail ?? 0).toBe(0)
    expect(model.bounds).toEqual({ lengthMm: 7500, widthMm: 2000, heightMm: 8000 })
  })

  it('aggregates part demand by role + length and is deterministic', () => {
    const spec = {
      baysAlongLength: 2,
      baysAlongWidth: 1,
      bayLengthMm: 2500,
      bayWidthMm: 1000,
      liftHeightMm: 2000,
      lifts: 2,
    }
    const a = generateScaffoldModel(spec)
    const b = generateScaffoldModel(spec)
    // Deterministic: identical members + ids.
    expect(a.members).toEqual(b.members)
    // partDemand totals reconcile with member count.
    const demandTotal = a.partDemand.reduce((s, l) => s + l.quantity, 0)
    expect(demandTotal).toBe(a.members.length)
    // Ledgers and transoms have different nominal lengths → separate lines.
    const ledger = a.partDemand.find((l) => l.role === 'ledger')
    const transom = a.partDemand.find((l) => l.role === 'transom')
    expect(ledger?.lengthMm).toBe(2500)
    expect(transom?.lengthMm).toBe(1000)
    // aggregatePartDemand is consistent when called directly.
    expect(aggregatePartDemand(a.members)).toEqual(a.partDemand)
  })

  it('warns when no lift is decked', () => {
    const model = generateScaffoldModel({
      baysAlongLength: 1,
      baysAlongWidth: 1,
      bayLengthMm: 2500,
      bayWidthMm: 1000,
      liftHeightMm: 2000,
      lifts: 2,
      options: { deckLifts: [] },
    })
    expect(model.members.some((m) => m.role === 'deck')).toBe(false)
    expect(model.warnings.join(' ')).toContain('no working platform')
  })

  it('rejects invalid specs', () => {
    expect(() =>
      generateScaffoldModel({
        baysAlongLength: 0,
        baysAlongWidth: 1,
        bayLengthMm: 2500,
        bayWidthMm: 1000,
        liftHeightMm: 2000,
        lifts: 1,
      }),
    ).toThrow(/baysAlongLength/)
    expect(() =>
      generateScaffoldModel({
        baysAlongLength: 1,
        baysAlongWidth: 1,
        bayLengthMm: -5,
        bayWidthMm: 1000,
        liftHeightMm: 2000,
        lifts: 1,
      }),
    ).toThrow(/bayLengthMm/)
  })
})
