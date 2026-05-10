import { describe, it, expect } from 'vitest'
import {
  TakeoffResult,
  applyReviewFloor,
  roomplanConfidenceToScore,
  derivedConfidence,
  validateTakeoffResult,
  TakeoffValidationError,
} from '../src/index.js'

const baseQuantity = {
  id: 'q1',
  description: 'Bedroom 2 — drywall',
  masterformatCode: '09 29 00',
  unit: 'sqft' as const,
  value: 240,
  confidence: 0.95,
  provenance: {
    kind: 'roomplan' as const,
    capturedRoomId: 'room-1',
    surfaceId: 'wall-3',
  },
}

const baseTakeoff = {
  schemaVersion: '1.0.0' as const,
  takeoffId: '11111111-1111-1111-1111-111111111111',
  projectId: 'spike-001',
  capturedAt: '2026-05-07T12:00:00Z',
  producedAt: '2026-05-07T12:01:00Z',
  source: 'ios.roomplan' as const,
  pipelineVersion: '0.1.0',
  units: 'imperial' as const,
  quantities: [baseQuantity],
}

describe('TakeoffResult', () => {
  it('accepts a minimal valid result', () => {
    expect(() => TakeoffResult.parse(baseTakeoff)).not.toThrow()
  })

  it('rejects a quantity with neither masterformat nor uniformat', () => {
    const bad = {
      ...baseTakeoff,
      quantities: [{ ...baseQuantity, masterformatCode: undefined }],
    }
    expect(() => TakeoffResult.parse(bad)).toThrow()
  })

  it('rejects a malformed masterformat code', () => {
    const bad = {
      ...baseTakeoff,
      quantities: [{ ...baseQuantity, masterformatCode: '9-29-00' }],
    }
    expect(() => TakeoffResult.parse(bad)).toThrow()
  })

  it('rejects confidence outside [0,1]', () => {
    const bad = {
      ...baseTakeoff,
      quantities: [{ ...baseQuantity, confidence: 1.2 }],
    }
    expect(() => TakeoffResult.parse(bad)).toThrow()
  })

  it('requires at least one quantity', () => {
    const bad = { ...baseTakeoff, quantities: [] }
    expect(() => TakeoffResult.parse(bad)).toThrow()
  })

  it('validateTakeoffResult throws TakeoffValidationError on bad input', () => {
    expect(() => validateTakeoffResult({})).toThrow(TakeoffValidationError)
  })
})

describe('review floor', () => {
  it('flips reviewRequired when any quantity is below 0.70', () => {
    const lowConf = { ...baseQuantity, id: 'q2', confidence: 0.4 }
    const result = applyReviewFloor({
      ...baseTakeoff,
      quantities: [baseQuantity, lowConf],
    })
    expect(result.reviewRequired).toBe(true)
    expect(result.warnings?.[0]?.code).toBe('low_confidence_quantities')
  })

  it('leaves reviewRequired unset when all confident', () => {
    const result = applyReviewFloor(baseTakeoff)
    expect(result.reviewRequired).toBeUndefined()
  })
})

describe('confidence helpers', () => {
  it('maps RoomPlan buckets', () => {
    expect(roomplanConfidenceToScore('high')).toBe(0.95)
    expect(roomplanConfidenceToScore('medium')).toBe(0.75)
    expect(roomplanConfidenceToScore('low')).toBe(0.45)
  })

  it('derived confidence is min(parents) * 0.9', () => {
    expect(derivedConfidence([0.9, 0.8])).toBeCloseTo(0.72)
    expect(derivedConfidence([])).toBe(0.5)
  })
})
