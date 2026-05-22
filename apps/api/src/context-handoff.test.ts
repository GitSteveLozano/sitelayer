import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REVERSIBILITY_WINDOW_SECONDS,
  REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY,
  reversibilityWindowForSeverity,
} from './context-handoff.js'

describe('reversibilityWindowForSeverity', () => {
  it('maps severity to the ontology-aligned window in seconds', () => {
    expect(reversibilityWindowForSeverity('urgent')).toBe(3600)
    expect(reversibilityWindowForSeverity('high')).toBe(21600)
    expect(reversibilityWindowForSeverity('normal')).toBe(86400)
    expect(reversibilityWindowForSeverity('low')).toBe(604800)
  })

  it('falls back to the 24h default for null / undefined severity', () => {
    expect(reversibilityWindowForSeverity(null)).toBe(DEFAULT_REVERSIBILITY_WINDOW_SECONDS)
    expect(reversibilityWindowForSeverity(undefined)).toBe(DEFAULT_REVERSIBILITY_WINDOW_SECONDS)
    expect(DEFAULT_REVERSIBILITY_WINDOW_SECONDS).toBe(86400)
  })

  it('exposes the severity table for callers that need the full mapping', () => {
    expect(REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY.urgent).toBeLessThan(
      REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY.high,
    )
    expect(REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY.high).toBeLessThan(
      REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY.normal,
    )
    expect(REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY.normal).toBeLessThan(
      REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY.low,
    )
  })
})
