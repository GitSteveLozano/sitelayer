import { describe, expect, it } from 'vitest'
import { computeDeductionOverlapCorrections } from './estimate.js'

// A square cutout polygon (board space), side s, lower-left at (x,y).
const sq = (x: number, y: number, s: number) => ({
  kind: 'polygon',
  points: [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ],
})

describe('computeDeductionOverlapCorrections (gap G8 cutout net-dedup)', () => {
  it('adds back the pairwise overlap for two overlapping cutouts of the same item', () => {
    // Each square: board area 100, world quantity 100 ⇒ scale 1. Overlap = 5×5 = 25.
    const corr = computeDeductionOverlapCorrections([
      { serviceItemCode: '09 29 00', pageId: 'p1', quantity: 100, geometry: sq(0, 0, 10) },
      { serviceItemCode: '09 29 00', pageId: 'p1', quantity: 100, geometry: sq(5, 5, 10) },
    ])
    expect(corr).toHaveLength(1)
    expect(corr[0]).toMatchObject({ serviceItemCode: '09 29 00', pageId: 'p1' })
    expect(corr[0]?.correctionQuantity).toBeCloseTo(25, 1)
  })

  it('scales the correction by the cutout world quantity (quantity / board-area)', () => {
    // board area 100 but stored world quantity 400 ⇒ scale 4. overlap board 25 ⇒ world 100.
    const corr = computeDeductionOverlapCorrections([
      { serviceItemCode: 'X', pageId: 'p1', quantity: 400, geometry: sq(0, 0, 10) },
      { serviceItemCode: 'X', pageId: 'p1', quantity: 400, geometry: sq(5, 5, 10) },
    ])
    expect(corr[0]?.correctionQuantity).toBeCloseTo(100, 1)
  })

  it('does not correct across different items, pages, or for disjoint / single cutouts', () => {
    const differentItem = computeDeductionOverlapCorrections([
      { serviceItemCode: 'A', pageId: 'p1', quantity: 100, geometry: sq(0, 0, 10) },
      { serviceItemCode: 'B', pageId: 'p1', quantity: 100, geometry: sq(5, 5, 10) },
    ])
    const differentPage = computeDeductionOverlapCorrections([
      { serviceItemCode: 'A', pageId: 'p1', quantity: 100, geometry: sq(0, 0, 10) },
      { serviceItemCode: 'A', pageId: 'p2', quantity: 100, geometry: sq(5, 5, 10) },
    ])
    const disjoint = computeDeductionOverlapCorrections([
      { serviceItemCode: 'A', pageId: 'p1', quantity: 100, geometry: sq(0, 0, 10) },
      { serviceItemCode: 'A', pageId: 'p1', quantity: 100, geometry: sq(50, 50, 10) },
    ])
    const single = computeDeductionOverlapCorrections([
      { serviceItemCode: 'A', pageId: 'p1', quantity: 100, geometry: sq(0, 0, 10) },
    ])
    expect(differentItem).toHaveLength(0)
    expect(differentPage).toHaveLength(0)
    expect(disjoint).toHaveLength(0)
    expect(single).toHaveLength(0)
  })

  it('ignores non-polygon / zero-area geometry', () => {
    const corr = computeDeductionOverlapCorrections([
      {
        serviceItemCode: 'A',
        pageId: 'p1',
        quantity: 100,
        geometry: { kind: 'volume', length: 1, width: 1, height: 1 },
      },
      { serviceItemCode: 'A', pageId: 'p1', quantity: 100, geometry: null },
    ])
    expect(corr).toHaveLength(0)
  })
})
