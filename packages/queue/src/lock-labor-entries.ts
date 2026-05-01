import type { QueueClient } from './index.js'

// ---------------------------------------------------------------------------
// lock_labor_entries dedicated handler
//
// Drains mutation_outbox rows with mutation_type='lock_labor_entries' that
// the time-review workflow's APPROVE / REOPEN transitions enqueue.
// Idempotency key from the route is
//   time_review:lock:<run_id>:<state_version>
// so an APPROVE → REOPEN → APPROVE cycle produces three distinct rows
// (one per state_version), and the row's payload carries the action
// ('lock' | 'unlock') the handler should apply.
//
// Both directions are idempotent at the SQL level:
//   - lock:   only updates rows where review_locked_at is null, so a
//             replay against already-locked rows is a no-op.
//   - unlock: filters by review_run_id = run_id, so an unlock won't
//             accidentally release entries that have since been
//             re-locked by a later run.
//
// No external API call, no failure path beyond DB errors. The handler
// runs each row in its own transaction so a stuck row doesn't strand
// earlier ones in the same heartbeat.
// ---------------------------------------------------------------------------

export type LockLaborEntriesAction = 'lock' | 'unlock'

export interface LockLaborEntriesPayload {
  action: LockLaborEntriesAction
  run_id: string
  covered_entry_ids: string[]
  approved_at: string | null
  state_version: number
}

export type LockLaborEntriesSummary = {
  processed: number
  locked: number
  unlocked: number
  failed: number
}

type ClaimedLockRow = {
  id: string
  entity_id: string
  payload: LockLaborEntriesPayload
  attempt_count: number
}

/**
 * Max attempts before a structurally-broken row gets parked at
 * status='failed' so it stops looping. Exposed so the worker can override
 * it via env if a deploy needs more headroom for transient flakes.
 */
export const LOCK_LABOR_ENTRIES_MAX_ATTEMPTS = 5

/**
 * Claim and apply up to `limit` lock_labor_entries outbox rows for the
 * given company. Each row is processed in its own transaction so a
 * row-level failure can't strand sibling work or hold the lease.
 */
export async function processLockLaborEntries(
  client: QueueClient,
  companyId: string,
  limit = 25,
): Promise<LockLaborEntriesSummary> {
  let locked = 0
  let unlocked = 0
  let failed = 0
  let processed = 0

  // Claim a batch in one tx (FOR UPDATE SKIP LOCKED is what makes
  // multiple worker replicas safe). The 5-minute lease matches the
  // generic drain so a crashed worker recovers quickly.
  await client.query('begin')
  let claimed: ClaimedLockRow[]
  try {
    const claimResult = await client.query<{
      id: string
      entity_id: string
      payload: LockLaborEntriesPayload
      attempt_count: number
    }>(
      `update mutation_outbox
         set status = 'processing',
             attempt_count = attempt_count + 1,
             next_attempt_at = now() + interval '5 minutes',
             error = null
       where id in (
         select id
         from mutation_outbox
         where company_id = $1
           and mutation_type = 'lock_labor_entries'
           and (
             (status = 'pending' and next_attempt_at <= now())
             or (status = 'processing' and next_attempt_at <= now())
           )
         order by next_attempt_at asc, created_at asc
         limit $2
         for update skip locked
       )
       returning id, entity_id, payload, attempt_count`,
      [companyId, limit],
    )
    claimed = claimResult.rows
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }

  for (const row of claimed) {
    processed++
    await client.query('begin')
    try {
      const payload = row.payload
      if (!payload || (payload.action !== 'lock' && payload.action !== 'unlock')) {
        throw new Error(`invalid lock_labor_entries payload: ${JSON.stringify(payload)}`)
      }
      const ids = Array.isArray(payload.covered_entry_ids)
        ? payload.covered_entry_ids.filter((id): id is string => typeof id === 'string')
        : []

      if (payload.action === 'lock') {
        // Only stamp rows that aren't already locked. A replay (same
        // state_version) is a no-op; a later run trying to re-lock the
        // same entries would also no-op until the prior run is unlocked.
        if (ids.length > 0) {
          await client.query(
            `update labor_entries
               set review_locked_at = coalesce($3::timestamptz, now()),
                   review_run_id = $2
             where company_id = $1
               and id = any($4::uuid[])
               and review_locked_at is null`,
            [companyId, payload.run_id, payload.approved_at, ids],
          )
        }
        locked++
      } else {
        // Unlock only the entries currently associated with this run id.
        // Prevents collateral damage if a different run has since locked
        // a subset of the same entries.
        if (ids.length > 0) {
          await client.query(
            `update labor_entries
               set review_locked_at = null,
                   review_run_id = null
             where company_id = $1
               and review_run_id = $2
               and id = any($3::uuid[])`,
            [companyId, payload.run_id, ids],
          )
        }
        unlocked++
      }

      await client.query(
        `update mutation_outbox
           set status = 'applied', applied_at = now(), error = null
         where company_id = $1 and id = $2`,
        [companyId, row.id],
      )
      await client.query('commit')
    } catch (err) {
      await client.query('rollback').catch(() => {})
      failed++
      const message = err instanceof Error ? err.message : String(err)
      // After LOCK_LABOR_ENTRIES_MAX_ATTEMPTS the row gets parked at
      // status='failed' so a structurally broken payload (bad action,
      // unparseable ids, ...) doesn't loop forever bumping
      // attempt_count and spamming the DB. Earlier attempts get a
      // 1-minute backoff and stay 'pending' so transient flakes
      // (connection reset, lock contention) recover on their own.
      const exhausted = row.attempt_count >= LOCK_LABOR_ENTRIES_MAX_ATTEMPTS
      try {
        await client.query(
          `update mutation_outbox
             set status = $4,
                 next_attempt_at = now() + interval '1 minute',
                 error = $3
           where company_id = $1 and id = $2`,
          [companyId, row.id, message.slice(0, 500), exhausted ? 'failed' : 'pending'],
        )
      } catch {
        // ignore
      }
    }
  }

  return { processed, locked, unlocked, failed }
}
