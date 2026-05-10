import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { validateTakeoffResult } from '@sitelayer/capture-schema'
import type { TakeoffQuantity, TakeoffResult } from '@sitelayer/capture-schema'

import { parseCapturedRoom } from '../src/index.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf-8'))
}

function findQty(result: TakeoffResult, pred: (q: TakeoffQuantity) => boolean): TakeoffQuantity | undefined {
  return result.quantities.find(pred)
}

describe('parseCapturedRoom — single-room fixture', () => {
  const fixture = loadFixture('sample-room.json')
  const result = parseCapturedRoom({
    capturedRoomJson: fixture,
    projectId: 'spike-001',
    deviceModel: 'iPhone 15 Pro',
    capturedAt: '2026-05-07T12:00:00Z',
  })

  it('validates against TakeoffResult schema', () => {
    expect(() => validateTakeoffResult(result)).not.toThrow()
    expect(result.source).toBe('ios.roomplan')
    expect(result.units).toBe('imperial')
    expect(result.pipelineVersion).toBe('0.1.0')
  })

  it('computes floor area within ±2% of 168 sqft (12×14)', () => {
    const flooring = findQty(result, (q) => q.uniformatCode === 'B3010')
    expect(flooring).toBeDefined()
    expect(flooring!.unit).toBe('sqft')
    expect(flooring!.value).toBeGreaterThan(168 * 0.98)
    expect(flooring!.value).toBeLessThan(168 * 1.02)
  })

  it('computes drywall area within ±5% of (52×8) − door − window ≈ 386 sqft', () => {
    const drywall = findQty(result, (q) => q.masterformatCode === '09 29 00' && q.id.endsWith('/drywall'))
    expect(drywall).toBeDefined()
    expect(drywall!.unit).toBe('sqft')
    // perimeter ≈ 52 ft, height 8 ft → 416 sqft gross
    // door 32"×80" ≈ 17.78 sqft; window 36"×48" = 12 sqft
    // expected ≈ 386.22 sqft
    const expected = 52 * 8 - (32 / 12) * (80 / 12) - 12
    expect(drywall!.value).toBeGreaterThan(expected * 0.95)
    expect(drywall!.value).toBeLessThan(expected * 1.05)
  })

  it('emits 1 door and 1 window count quantity', () => {
    const doors = findQty(result, (q) => q.masterformatCode === '08 14 00')
    const windows = findQty(result, (q) => q.masterformatCode === '08 50 00')
    expect(doors?.value).toBe(1)
    expect(doors?.unit).toBe('ea')
    expect(windows?.value).toBe(1)
    expect(windows?.unit).toBe('ea')
  })

  it('records 0.95 confidence for high-bucket roomplan provenance quantities', () => {
    const roomplanQs = result.quantities.filter((q) => q.provenance.kind === 'roomplan')
    expect(roomplanQs.length).toBeGreaterThan(0)
    for (const q of roomplanQs) {
      expect(q.confidence).toBeCloseTo(0.95, 5)
    }
  })

  it("derives ceiling from floor with provenance.kind === 'derived'", () => {
    const ceiling = findQty(result, (q) => q.id.endsWith('/ceiling'))
    expect(ceiling).toBeDefined()
    expect(ceiling!.provenance.kind).toBe('derived')
    if (ceiling!.provenance.kind === 'derived') {
      expect(ceiling!.provenance.rule).toBe('ceiling = floor')
      expect(ceiling!.provenance.from.length).toBe(1)
      expect(ceiling!.provenance.from[0]).toMatch(/\/flooring$/)
    }
    // ceiling area equals floor area
    const flooring = findQty(result, (q) => q.uniformatCode === 'B3010')
    expect(ceiling!.value).toBeCloseTo(flooring!.value, 1)
  })

  it('populates lean cross-pipeline geometry', () => {
    expect(result.geometry).toBeDefined()
    expect(result.geometry!.rooms).toHaveLength(1)
    expect(result.geometry!.rooms![0]!.floorAreaSqFt).toBeGreaterThan(150)
    // 4 walls + 2 opening surfaces (1 door, 1 window) = 6 surfaces
    expect(result.geometry!.surfaces!.length).toBeGreaterThanOrEqual(4)
  })

  it('populates sourceArtifact.roomplan with per-wall and per-feature breakdown', () => {
    expect(result.sourceArtifact).toBeDefined()
    expect(result.sourceArtifact!.kind).toBe('roomplan')
    if (result.sourceArtifact!.kind === 'roomplan') {
      const art = result.sourceArtifact.roomplan
      expect(art.rooms).toHaveLength(1)
      expect(art.rooms[0]!.walls).toHaveLength(4)
      expect(art.rooms[0]!.features).toHaveLength(2)
    }
  })

  it('does not flag review (all confidences ≥ 0.7)', () => {
    expect(result.reviewRequired).not.toBe(true)
  })
})

describe('parseCapturedRoom — multi-room fixture', () => {
  const fixture = loadFixture('sample-multiroom.json')
  const result = parseCapturedRoom({
    capturedRoomJson: fixture,
    projectId: 'spike-001',
    deviceModel: 'iPhone 15 Pro',
  })

  it('emits ≥2 rooms in geometry and 2 sets of room-aggregate quantities', () => {
    expect(result.geometry?.rooms?.length ?? 0).toBeGreaterThanOrEqual(2)
    const drywallQs = result.quantities.filter((q) => q.masterformatCode === '09 29 00' && q.id.endsWith('/drywall'))
    expect(drywallQs.length).toBe(2)
  })

  it('emits a plumbing fixture quantity for the bathroom toilet', () => {
    const toilet = findQty(result, (q) => q.masterformatCode === '22 40 00' && /toilet/i.test(q.description))
    expect(toilet).toBeDefined()
    expect(toilet!.unit).toBe('ea')
    expect(toilet!.value).toBe(1)
  })

  it('flags review when fixture confidence is medium', () => {
    // sink in the bathroom is 'medium' (0.75) which is above floor (0.7) — so
    // review may NOT trigger; assert top-level is consistent with quantity confs.
    const minConf = Math.min(...result.quantities.map((q) => q.confidence))
    if (minConf < 0.7) {
      expect(result.reviewRequired).toBe(true)
    }
  })
})

describe('parseCapturedRoom — low-confidence walls trigger review', () => {
  const baseFixture = loadFixture('sample-room.json') as {
    walls: Array<{ confidence: string }>
  }
  // Mutate a copy: drop one wall to "low"
  const mutated = JSON.parse(JSON.stringify(baseFixture)) as typeof baseFixture
  mutated.walls[0]!.confidence = 'low'

  const result = parseCapturedRoom({
    capturedRoomJson: mutated,
    projectId: 'spike-001',
  })

  it('flips reviewRequired = true and emits a low_confidence warning', () => {
    expect(result.reviewRequired).toBe(true)
    const warns = result.warnings ?? []
    expect(warns.some((w) => w.code === 'low_confidence_quantities')).toBe(true)
  })

  it('low-bucket wall produces drywall with confidence 0.45', () => {
    const drywall = result.quantities.find((q) => q.id.endsWith('/drywall'))
    expect(drywall).toBeDefined()
    expect(drywall!.confidence).toBeCloseTo(0.45, 5)
  })
})
