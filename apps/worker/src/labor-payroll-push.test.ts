import { describe, expect, it } from 'vitest'
import { decideTimeActivityPayloads } from './labor-payroll-push.js'

// Unit coverage for the split-vs-merged decision logic that drives the
// QBO TimeActivity push. The helper is the bridge between the
// per-company ot_service_item_code setting and the per-entry push
// loop:
//
//   - When the company opts out (otServiceItemCode = null), every
//     entry produces ONE payload with its full hours value — today's
//     pre-OT-split behavior, preserved as the safe default.
//
//   - When the company opts in AND the entry's hours exceed
//     splitStraightAndOt's 8h threshold, the entry produces TWO
//     payloads: straight against the entry's existing
//     service_item_code, OT against the company's OT code.
//
// The real worker also handles the QBO Item id lookup, the QBO
// Employee mapping, the per-entry POST + 401 refresh, and the
// idempotency dance against qbo_payroll_batch_ref. None of that
// matters for this helper — keeping it pure lets us test the
// straight-vs-OT split policy without standing up Postgres.

describe('decideTimeActivityPayloads', () => {
  describe('opt-out path (otServiceItemCode null)', () => {
    it('returns one straight payload with full hours when under threshold', () => {
      const result = decideTimeActivityPayloads({ hours: 6, service_item_code: 'LBR' }, null)
      expect(result).toEqual([{ kind: 'straight', hours: 6, serviceItemCode: 'LBR' }])
    })

    it('returns one straight payload with FULL hours even above threshold (today behavior)', () => {
      // The opt-out path must preserve pre-OT behavior — never split,
      // even for a 12h day. This is the safety net so existing
      // installs keep working when the migration ships before any
      // admin sets the new column.
      const result = decideTimeActivityPayloads({ hours: 12, service_item_code: 'LBR' }, null)
      expect(result).toEqual([{ kind: 'straight', hours: 12, serviceItemCode: 'LBR' }])
    })

    it('returns one straight payload with null service_item_code when entry has none', () => {
      const result = decideTimeActivityPayloads({ hours: 5, service_item_code: null }, null)
      expect(result).toEqual([{ kind: 'straight', hours: 5, serviceItemCode: null }])
    })

    it('returns empty list for zero hours (caller skips entry)', () => {
      const result = decideTimeActivityPayloads({ hours: 0, service_item_code: 'LBR' }, null)
      expect(result).toEqual([])
    })

    it('returns empty list for negative hours (defensive)', () => {
      const result = decideTimeActivityPayloads({ hours: -1, service_item_code: 'LBR' }, null)
      expect(result).toEqual([])
    })
  })

  describe('opt-in path (otServiceItemCode set)', () => {
    it('returns ONE straight payload when hours <= threshold (no OT produced)', () => {
      // 8h is the splitStraightAndOt boundary: at-or-under is still
      // all-straight, so no OT payload even though the company has
      // OT mapping configured.
      const result = decideTimeActivityPayloads({ hours: 8, service_item_code: 'LBR' }, 'LBR-OT')
      expect(result).toEqual([{ kind: 'straight', hours: 8, serviceItemCode: 'LBR' }])
    })

    it('returns ONE straight payload when hours just under threshold', () => {
      const result = decideTimeActivityPayloads({ hours: 7.5, service_item_code: 'LBR' }, 'LBR-OT')
      expect(result).toEqual([{ kind: 'straight', hours: 7.5, serviceItemCode: 'LBR' }])
    })

    it('returns straight + OT payloads when hours exceed threshold', () => {
      const result = decideTimeActivityPayloads({ hours: 10.5, service_item_code: 'LBR' }, 'LBR-OT')
      expect(result).toEqual([
        { kind: 'straight', hours: 8, serviceItemCode: 'LBR' },
        { kind: 'ot', hours: 2.5, serviceItemCode: 'LBR-OT' },
      ])
    })

    it('OT payload uses the company OT code even when entry service_item_code is null', () => {
      const result = decideTimeActivityPayloads({ hours: 12, service_item_code: null }, 'LBR-OT')
      expect(result).toEqual([
        { kind: 'straight', hours: 8, serviceItemCode: null },
        { kind: 'ot', hours: 4, serviceItemCode: 'LBR-OT' },
      ])
    })

    it('returns empty list for zero hours regardless of opt-in', () => {
      const result = decideTimeActivityPayloads({ hours: 0, service_item_code: 'LBR' }, 'LBR-OT')
      expect(result).toEqual([])
    })

    it('handles edge: hours fractionally above threshold', () => {
      const result = decideTimeActivityPayloads({ hours: 8.25, service_item_code: 'LBR' }, 'LBR-OT')
      expect(result).toEqual([
        { kind: 'straight', hours: 8, serviceItemCode: 'LBR' },
        { kind: 'ot', hours: 0.25, serviceItemCode: 'LBR-OT' },
      ])
    })
  })

  describe('opt-in path treats empty-string ot code as opt-out', () => {
    // The API PATCH normalizes empty strings to null before persisting,
    // but defense-in-depth: the helper treats falsy as "no OT mapping"
    // so a future bug in the route can't silently produce a 2-payload
    // result with a meaningless OT code.
    it('empty string OT code → opt-out behavior', () => {
      const result = decideTimeActivityPayloads({ hours: 10, service_item_code: 'LBR' }, '')
      expect(result).toEqual([{ kind: 'straight', hours: 10, serviceItemCode: 'LBR' }])
    })
  })
})
