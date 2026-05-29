import { describe, expect, it } from 'vitest'
import { parseMessageMeta } from './messaging.js'

describe('parseMessageMeta', () => {
  it('returns null for missing / null', () => {
    expect(parseMessageMeta(undefined)).toBeNull()
    expect(parseMessageMeta(null)).toBeNull()
  })

  it('returns null for non-object scalars and arrays', () => {
    expect(parseMessageMeta('approval')).toBeNull()
    expect(parseMessageMeta(42)).toBeNull()
    expect(parseMessageMeta(true)).toBeNull()
    expect(parseMessageMeta([{ kind: 'approval' }])).toBeNull()
  })

  it('passes through a plain marker object (open shape)', () => {
    expect(parseMessageMeta({ kind: 'approval', amount: 510 })).toEqual({ kind: 'approval', amount: 510 })
    expect(parseMessageMeta({ linked_field_event_id: 'evt-1' })).toEqual({ linked_field_event_id: 'evt-1' })
    // Unknown keys are tolerated — the UI falls back gracefully.
    expect(parseMessageMeta({ foo: 'bar' })).toEqual({ foo: 'bar' })
  })

  it('preserves an empty object (caller may send {} to clear no marker)', () => {
    expect(parseMessageMeta({})).toEqual({})
  })
})
