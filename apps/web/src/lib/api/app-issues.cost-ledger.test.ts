import { describe, expect, it, vi } from 'vitest'

const fetchSupportPacketAccessLog = vi.hoisted(() => vi.fn())
vi.mock('./support-packets', () => ({ fetchSupportPacketAccessLog }))

import { fetchAppIssueCostLedger } from './app-issues'

describe('fetchAppIssueCostLedger (STEP6-UI)', () => {
  it('projects access-log rows into cost-bearing ledger entries and tallies spend', async () => {
    fetchSupportPacketAccessLog.mockResolvedValueOnce({
      access_log: [
        {
          id: '1',
          support_packet_id: 'p1',
          actor_user_id: 'u',
          access_type: 'read',
          route: null,
          request_id: 'r0',
          created_at: '2026-06-06T00:00:00Z',
          metadata: {}, // a plain read — no cost
        },
        {
          id: '2',
          support_packet_id: 'p1',
          actor_user_id: 'u',
          access_type: 'export',
          route: null,
          request_id: 'r1',
          created_at: '2026-06-06T00:01:00Z',
          metadata: { source: 'sentry', tier: 2, cost_cents: 150 },
        },
        {
          id: '3',
          support_packet_id: 'p1',
          actor_user_id: 'u',
          access_type: 'export',
          route: null,
          request_id: 'r2',
          created_at: '2026-06-06T00:02:00Z',
          metadata: { source: 'axiom', tier: 3, cost_cents: 75 },
        },
      ],
    })

    const ledger = await fetchAppIssueCostLedger('p1')
    expect(ledger.entries).toHaveLength(3)
    expect(ledger.total_cost_cents).toBe(225)
    expect(ledger.pull_count).toBe(2)
    const sentry = ledger.entries.find((e) => e.source === 'sentry')
    expect(sentry?.tier).toBe(2)
    expect(sentry?.cost_cents).toBe(150)
    // The plain read carries no source/tier/cost.
    const read = ledger.entries.find((e) => e.access_type === 'read')
    expect(read?.cost_cents).toBeNull()
  })

  it('returns zeros for an empty log', async () => {
    fetchSupportPacketAccessLog.mockResolvedValueOnce({ access_log: [] })
    const ledger = await fetchAppIssueCostLedger('p1')
    expect(ledger.entries).toEqual([])
    expect(ledger.total_cost_cents).toBe(0)
    expect(ledger.pull_count).toBe(0)
  })
})
