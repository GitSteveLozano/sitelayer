import type { PoolClient } from 'pg'
import {
  FIELD_EVENT_WORKFLOW_NAME,
  FIELD_EVENT_WORKFLOW_SCHEMA_VERSION,
  transitionFieldEventWorkflow,
  type FieldEventWorkflowSnapshot,
} from '@sitelayer/workflows'

/**
 * Durable timer: auto-escalate severity='stopped' worker_issues that
 * have been sitting open longer than the threshold. The reducer's
 * ESCALATE event applies the same audit trail a human would.
 *
 * This is the first use of the periodic-task-as-timer pattern called
 * out in the audit. The function runs once per worker heartbeat. Each
 * claim/transition pair runs in its own transaction so a bad row
 * can't strand earlier ones.
 *
 * The 15-min default matches the field-event spec; tunable via env.
 */

export type AutoEscalateConfig = {
  ageMinutes: number
  /** Cap per heartbeat — keep audit-log volume bounded. */
  maxPerTick: number
  /** System-actor id stamped on the escalation. */
  systemUserId: string
}

export const DEFAULT_AUTO_ESCALATE_CONFIG: AutoEscalateConfig = {
  ageMinutes: 15,
  maxPerTick: 25,
  systemUserId: 'system:auto-escalation',
}

export type AutoEscalateSummary = {
  processed: number
  escalated: number
  failed: number
}

interface OpenStoppedRow {
  id: string
  company_id: string
  state_version: number
}

export async function processFieldEventAutoEscalation(
  client: PoolClient,
  companyId: string,
  config: AutoEscalateConfig = DEFAULT_AUTO_ESCALATE_CONFIG,
): Promise<AutoEscalateSummary> {
  // Claim phase: pick rows that are open, severity='stopped', and aged
  // past the threshold. `state = 'open'` is the persisted workflow state
  // (migration 112) — cleaner and immune to the per-column stale-trail
  // problem the old `resolved_at IS NULL AND escalated_to_estimator_at IS
  // NULL` derivation had. A row that's been escalated/resolved/dismissed by
  // a human already left 'open' and shouldn't be re-fired.
  const claimed = await client.query<OpenStoppedRow>(
    `select id, company_id, state_version
       from worker_issues
       where company_id = $1
         and state = 'open'
         and severity = 'stopped'
         and created_at <= now() - ($2 || ' minutes')::interval
       order by created_at asc
       limit $3
       for update skip locked`,
    [companyId, String(config.ageMinutes), config.maxPerTick],
  )

  let escalated = 0
  let failed = 0
  const now = new Date().toISOString()

  for (const row of claimed.rows) {
    try {
      // Hydrate a minimal snapshot — the reducer reads `state` for the
      // transition guard and spreads the rest. Other audit fields stay
      // unset (all optional on the snapshot type) and will be written
      // by the UPDATE below.
      const snapshot: FieldEventWorkflowSnapshot = {
        state: 'open',
        state_version: row.state_version,
      }
      const next = transitionFieldEventWorkflow(snapshot, {
        type: 'ESCALATE',
        escalated_at: now,
        escalator_user_id: config.systemUserId,
        reason: 'auto_15min_stopped',
      })
      // Persist the new state. Concurrent human ESCALATE/RESOLVE would
      // have moved state_version forward; our FOR UPDATE held the row so
      // that path is serialized after us.
      await client.query(
        `update worker_issues
           set state = $5,
               state_version = $2,
               escalated_to_estimator_at = $3,
               escalation_reason = $4
         where id = $1`,
        [row.id, next.state_version, now, 'auto_15min_stopped', next.state],
      )
      // Append workflow_event_log for replay tooling.
      await client.query(
        `insert into workflow_event_log
           (company_id, workflow_name, schema_version, entity_type, entity_id,
            state_version, event_type, event_payload, snapshot_after, actor_user_id)
         values ($1, $2, $3, 'worker_issue', $4, $5, 'ESCALATE',
                 jsonb_build_object(
                   'escalated_at', $6::text,
                   'escalator_user_id', $7::text,
                   'reason', 'auto_15min_stopped'
                 ),
                 to_jsonb($8::json), $7)`,
        [
          row.company_id,
          FIELD_EVENT_WORKFLOW_NAME,
          FIELD_EVENT_WORKFLOW_SCHEMA_VERSION,
          row.id,
          row.state_version, // version BEFORE the transition — matches the per-version unique constraint
          now,
          config.systemUserId,
          JSON.stringify(next),
        ],
      )
      escalated++
    } catch (err) {
      failed++
      // Don't rethrow — the claim already advanced; logging is enough.
      // Caller decides whether to surface via Sentry.
      void err
    }
  }

  return { processed: claimed.rowCount ?? 0, escalated, failed }
}
