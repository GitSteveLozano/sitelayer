import { describe, expect, it } from 'vitest'
import {
  generateScaffoldModel,
  aggregatePartDemand,
  resolveScaffoldBom,
  type ScaffoldCatalogPart,
  type ScaffoldMemberRole,
  type ScaffoldPartDemandLine,
} from './scaffold-design.js'

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
    // (kept below)
    expect(true).toBe(true)
  })
})

describe('resolveScaffoldBom', () => {
  const catalog: ScaffoldCatalogPart[] = [
    { id: 'std-2m', role: 'standard', lengthMm: 2000 },
    { id: 'ledger-2.5m', role: 'ledger', lengthMm: 2500 },
    { id: 'ledger-3m', role: 'ledger', lengthMm: 3000 },
    { id: 'transom-1m', role: 'transom', lengthMm: 1000 },
    { id: 'baseplate', role: 'base_plate', lengthMm: null },
    { id: 'deck-2.5m', role: 'deck', lengthMm: 2500 },
    // no brace / guardrail parts on purpose
  ]

  it('matches each demand line to the nearest catalog part of the same role', () => {
    const demand: ScaffoldPartDemandLine[] = [
      { role: 'standard', lengthMm: 2000, quantity: 4 },
      { role: 'ledger', lengthMm: 2500, quantity: 2 },
      { role: 'transom', lengthMm: 1000, quantity: 2 },
      { role: 'base_plate', lengthMm: 0, quantity: 4 },
    ]
    const { lines, unresolved } = resolveScaffoldBom(demand, catalog)
    expect(unresolved).toHaveLength(0)
    expect(lines.find((l) => l.role === 'ledger')?.catalogPartId).toBe('ledger-2.5m')
    expect(lines.find((l) => l.role === 'base_plate')?.catalogPartId).toBe('baseplate')
    expect(lines.find((l) => l.role === 'standard')?.quantity).toBe(4)
  })

  it('picks the nearest length when no exact match exists', () => {
    const demand: ScaffoldPartDemandLine[] = [{ role: 'ledger', lengthMm: 2900, quantity: 1 }]
    const { lines } = resolveScaffoldBom(demand, catalog)
    expect(lines[0]?.catalogPartId).toBe('ledger-3m') // 3000 is nearer to 2900 than 2500
  })

  it('reports demand with no catalog part for its role as unresolved', () => {
    const demand: ScaffoldPartDemandLine[] = [
      { role: 'standard', lengthMm: 2000, quantity: 4 },
      { role: 'brace', lengthMm: 3202, quantity: 2 },
      { role: 'guardrail', lengthMm: 2500, quantity: 4 },
    ]
    const { lines, unresolved } = resolveScaffoldBom(demand, catalog)
    expect(lines).toHaveLength(1)
    expect(unresolved.map((u) => u.role).sort()).toEqual(['brace', 'guardrail'])
  })

  it('end-to-end: a generated model resolves against a catalog', () => {
    const model = generateScaffoldModel({
      baysAlongLength: 1,
      baysAlongWidth: 1,
      bayLengthMm: 2500,
      bayWidthMm: 1000,
      liftHeightMm: 2000,
      lifts: 1,
      options: { guardrails: false },
    })
    const { lines } = resolveScaffoldBom(model.partDemand, catalog)
    // standards, ledgers, transoms, base plates, deck all resolve; braces don't.
    expect(lines.some((l) => l.role === 'standard')).toBe(true)
    expect(lines.some((l) => l.role === 'deck')).toBe(true)
  })
})

describe('generateScaffoldModel (validation)', () => {
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
