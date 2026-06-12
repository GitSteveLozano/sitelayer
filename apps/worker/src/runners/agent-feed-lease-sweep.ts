import type { Pool } from 'pg'
import { setCompanyGuc } from '../runner-utils.js'

/**
 * Agent-feed claim-lease expiry sweep.
 *
 * The agent-feed claim (`POST /api/agent-feed/callbacks` status='accepted')
 * moves a concern pending -> claimed, but an executor that crashes after
 * claiming would otherwise wedge the concern in 'claimed' forever — no other
 * executor can claim it and no terminal Callback will ever arrive. This
 * runner requeues concerns stuck in 'claimed' past the lease window back to
 * 'pending' (claimed_at cleared) so the next poll can re-serve them, and
 * stamps an `agent.dispatch_expired` event on the linked work item's timeline
 * (the lease-expiry lifecycle vocabulary in context-handoff.ts
 * HANDOFF_EVENT_TYPES — a sitelayer-local extension alongside
 * agent.callback_missing) so the requeue is visible to triage.
 *
 * Lease window: AGENT_FEED_CLAIM_LEASE_MINUTES (default 30). Cadence:
 * AGENT_FEED_CLAIM_SWEEP_INTERVAL_MS (default 5 min), throttled PER COMPANY
 * (a Map keyed by company id) so the multi-tenant drain loop sweeps every
 * company on its own cadence instead of rotating one company per interval.
 * The work item's status is intentionally left alone — a re-claim
 * re-acknowledges it, and the 24h work-dispatch-reconciler stays the L4
 * backstop for an item that never gets re-claimed.
 */

export type AgentFeedLeaseSweepSummary = {
  ran: boolean
  requeued: number
  failed: number
}

export type AgentFeedLeaseSweepDeps = {
  pool: Pool
}

export function createAgentFeedLeaseSweepRunner(deps: AgentFeedLeaseSweepDeps) {
  const { pool } = deps
  const lastRunAtByCompany = new Map<string, number>()

  return {
    async maybeSweep(companyId: string): Promise<AgentFeedLeaseSweepSummary> {
      const intervalMs = readPositiveInt('AGENT_FEED_CLAIM_SWEEP_INTERVAL_MS', 300_000)
      const now = Date.now()
      const lastRunAt = lastRunAtByCompany.get(companyId) ?? 0
      if (now - lastRunAt < intervalMs) return { ran: false, requeued: 0, failed: 0 }
      lastRunAtByCompany.set(companyId, now)
      return sweepExpiredClaims(pool, companyId)
    },
  }
}

type ExpiredClaimRow = {
  id: string
  audience: string
  concern_ref: string
  work_item_id: string | null
  capture_session_id: string | null
  claimed_at: string
}

async function sweepExpiredClaims(pool: Pool, companyId: string): Promise<AgentFeedLeaseSweepSummary> {
  const leaseMinutes = readPositiveInt('AGENT_FEED_CLAIM_LEASE_MINUTES', 30)
  const limit = Math.min(readPositiveInt('AGENT_FEED_CLAIM_SWEEP_LIMIT', 25), 100)
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const expired = await client.query<ExpiredClaimRow>(
      `select id, audience, concern_ref, work_item_id::text as work_item_id,
              capture_session_id::text as capture_session_id, claimed_at::text as claimed_at
         from agent_feed_concerns
        where company_id = $1
          and status = 'claimed'
          and claimed_at < now() - make_interval(mins => $2::int)
        order by claimed_at asc
        limit $3
        for update skip locked`,
      [companyId, leaseMinutes, limit],
    )
    let requeued = 0
    for (const row of expired.rows) {
      const result = await client.query(
        `update agent_feed_concerns
            set status = 'pending',
                claimed_at = null,
                updated_at = now()
          where company_id = $1 and id = $2 and status = 'claimed'`,
        [companyId, row.id],
      )
      const rowsUpdated = result.rowCount ?? 0
      requeued += rowsUpdated
      if (rowsUpdated > 0 && row.work_item_id) {
        // One event per expired claim (claimed_at in the key so a later
        // re-claim that expires again logs again).
        const eventKey = `agent_feed:${row.concern_ref}:lease_expired:${row.claimed_at}`
        await client.query(
          `insert into context_handoff_events (
             company_id, work_item_id, event_type, actor_kind, actor_ref,
             source_system, payload, metadata, idempotency_key, capture_session_id,
             redaction_version
           ) values ($1, $2, 'agent.dispatch_expired', 'system', 'agent_feed_lease_sweep',
             'sitelayer-worker', $3::jsonb, $4::jsonb, $5, $6::uuid,
             'context-handoff-v1')
           on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing`,
          [
            companyId,
            row.work_item_id,
            JSON.stringify({
              message:
                'An executor claimed the agent-feed concern but went silent past the lease window; the concern was requeued.',
              audience: row.audience,
              concern_ref: row.concern_ref,
              claimed_at: row.claimed_at,
              lease_minutes: leaseMinutes,
              requeued: true,
            }),
            JSON.stringify({
              reason: 'agent_feed_claim_lease_expired',
              dispatch_surface: 'agent_feed',
              audience: row.audience,
            }),
            eventKey,
            row.capture_session_id,
          ],
        )
      }
    }
    await client.query('commit')
    return { ran: true, requeued, failed: 0 }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
