/**
 * Crew-schedule confirm processor.
 *
 * Drains the two declared crew_schedule outbox side effects
 * (packages/workflows/src/crew-schedule.ts → sideEffectTypes):
 *
 *   materialize_labor_entries — enqueued on a non-noop CONFIRM by BOTH
 *     the headless /events route and the legacy /confirm route. Inserts
 *     one `confirmed` labor_entry per supplied per-worker entry and bumps
 *     projects.version. This is the keystone that makes both confirm
 *     paths behaviorally equivalent (the reducer stays pure; the
 *     after-effects live here, drained once, idempotently).
 *
 *   notify_foreman_decline — enqueued on a DECLINE. Resolves the project
 *     foreman(s) (project_assignments, falling back to admin/office) and
 *     inserts a `notifications` row so the decline is surfaced in-band,
 *     replacing the old /api/worker-issues note.
 *
 * Idempotency: materialize_labor_entries uses a per-entity outbox key
 * (`crew_schedule:materialize_labor:<id>`), so a retry/replay claims and
 * re-applies the SAME row rather than creating new work. Before
 * inserting, the processor checks whether labor_entries already exist for
 * (company_id, project_id, occurred_on) so a re-drain after a partial
 * crash does not double-insert. All work for one row is one transaction,
 * mirroring field-event-notifier.ts / processLockLaborEntries.
 */

import type { QueueClient } from '@sitelayer/queue'

export type CrewScheduleConfirmSummary = {
  processed: number
  materialized: number
  notified: number
  skipped: number
  failed: number
}

type LaborEntryInput = {
  worker_id?: string | null
  service_item_code?: unknown
  hours?: unknown
  sqft_done?: unknown
  occurred_on?: unknown
}

type ClaimedRow = {
  id: string
  entity_id: string
  mutation_type: 'materialize_labor_entries' | 'notify_foreman_decline'
  payload: Record<string, unknown>
  attempt_count: number
}

const CREW_SCHEDULE_MUTATION_TYPES = ['materialize_labor_entries', 'notify_foreman_decline'] as const

export const CREW_SCHEDULE_CONFIRM_MAX_ATTEMPTS = 5

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function listProjectForemen(client: QueueClient, companyId: string, projectId: string): Promise<string[]> {
  const result = await client.query<{ clerk_user_id: string }>(
    `select clerk_user_id from project_assignments
     where company_id = $1 and project_id = $2 and role = 'foreman' and deleted_at is null`,
    [companyId, projectId],
  )
  return result.rows.map((r) => r.clerk_user_id)
}

async function listAdminOfficeRecipients(client: QueueClient, companyId: string): Promise<string[]> {
  const result = await client.query<{ clerk_user_id: string }>(
    `select cm.clerk_user_id from company_memberships cm
     where cm.company_id = $1 and cm.role in ('admin', 'office')`,
    [companyId],
  )
  return result.rows.map((r) => r.clerk_user_id)
}

async function insertNotification(
  client: QueueClient,
  args: {
    companyId: string
    recipientUserId: string | null
    kind: string
    subject: string
    text: string
    payload: Record<string, unknown>
  },
): Promise<void> {
  await client.query(
    `insert into notifications (
       company_id, recipient_clerk_user_id, recipient_email, kind, subject, body_text, body_html, payload
     ) values ($1, $2, null, $3, $4, $5, null, $6::jsonb)`,
    [args.companyId, args.recipientUserId, args.kind, args.subject, args.text, JSON.stringify(args.payload)],
  )
}

/**
 * Single-batch drain. Caller owns the pool; pass any pg-compatible client
 * (Pool, PoolClient) and the function manages its own transactions per row.
 */
export async function processCrewScheduleConfirm(
  client: QueueClient,
  companyId: string,
  limit = 25,
): Promise<CrewScheduleConfirmSummary> {
  let materialized = 0
  let notified = 0
  let skipped = 0
  let failed = 0
  let processed = 0

  // Phase 1: claim. Own tx so the 'processing' marker is durable even if
  // every per-row body throws.
  await client.query('begin')
  let claimed: ClaimedRow[]
  try {
    const claimResult = await client.query<ClaimedRow>(
      `update mutation_outbox
         set status = 'processing',
             attempt_count = attempt_count + 1,
             next_attempt_at = now() + interval '5 minutes',
             error = null
       where id in (
         select id
         from mutation_outbox
         where company_id = $1
           and mutation_type = any($3::text[])
           and (
             (status = 'pending' and next_attempt_at <= now())
             or (status = 'processing' and next_attempt_at <= now())
           )
         order by next_attempt_at asc, created_at asc
         limit $2
         for update skip locked
       )
       returning id, entity_id, mutation_type, payload, attempt_count`,
      [companyId, limit, [...CREW_SCHEDULE_MUTATION_TYPES]],
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
      const payload = row.payload ?? {}

      if (row.mutation_type === 'materialize_labor_entries') {
        const projectId = asString(payload.project_id)
        const occurredOn = asString(payload.scheduled_for)
        const entries = Array.isArray(payload.entries) ? (payload.entries as LaborEntryInput[]) : []

        if (!projectId) {
          await client.query(
            `update mutation_outbox set status = 'applied', applied_at = now(), error = $3
             where company_id = $1 and id = $2`,
            [companyId, row.id, 'no project_id — skipped'],
          )
          await client.query('commit')
          skipped++
          continue
        }

        // Idempotency guard: if labor_entries already exist for this
        // (company, project, day), a prior drain of the same key already
        // materialized them — skip the insert to avoid duplicates.
        const occurredFilter = occurredOn ? 'and occurred_on = $3::date' : ''
        const existing = await client.query<{ n: number }>(
          `select count(*)::int as n from labor_entries
             where company_id = $1 and project_id = $2 ${occurredFilter} and deleted_at is null`,
          occurredOn ? [companyId, projectId, occurredOn] : [companyId, projectId],
        )
        const alreadyMaterialized = (existing.rows[0]?.n ?? 0) > 0

        if (!alreadyMaterialized) {
          for (const entry of entries) {
            const code = asString(entry.service_item_code)
            const hours = asNumber(entry.hours)
            const on = asString(entry.occurred_on) ?? occurredOn
            if (!code || hours === null || !on) continue
            await client.query(
              `insert into labor_entries
                 (company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on)
               values ($1, $2, $3, $4, $5, coalesce($6, 0), 'confirmed', $7)`,
              [companyId, projectId, asString(entry.worker_id), code, hours, asNumber(entry.sqft_done) ?? 0, on],
            )
          }
          // Bump the parent project version so derived estimate/analytics
          // caches recompute (mirrors the old inline /confirm behavior).
          await client.query(
            `update projects set version = version + 1, updated_at = now()
               where company_id = $1 and id = $2`,
            [companyId, projectId],
          )
        }

        await client.query(
          `update mutation_outbox set status = 'applied', applied_at = now(), error = null
             where company_id = $1 and id = $2`,
          [companyId, row.id],
        )
        await client.query('commit')
        materialized++
        continue
      }

      // notify_foreman_decline — surface the decline to the project foreman.
      const projectId = asString(payload.project_id) ?? row.entity_id
      const reason = asString(payload.reason) ?? '(no reason given)'
      const scheduledFor = asString(payload.scheduled_for) ?? '(unknown day)'
      const subject = 'Crew assignment declined'
      const text = `A worker declined the crew assignment for ${scheduledFor}.\n\nReason: ${reason}`
      const foremen = await listProjectForemen(client, companyId, projectId)
      const recipients = foremen.length > 0 ? foremen : await listAdminOfficeRecipients(client, companyId)
      if (recipients.length === 0) {
        await insertNotification(client, {
          companyId,
          recipientUserId: null,
          kind: 'crew_schedule_declined',
          subject,
          text,
          payload,
        })
      } else {
        for (const recipientUserId of recipients) {
          await insertNotification(client, {
            companyId,
            recipientUserId,
            kind: 'crew_schedule_declined',
            subject,
            text,
            payload,
          })
        }
      }
      await client.query(
        `update mutation_outbox set status = 'applied', applied_at = now(), error = null
           where company_id = $1 and id = $2`,
        [companyId, row.id],
      )
      await client.query('commit')
      notified++
    } catch (err) {
      await client.query('rollback').catch(() => {})
      failed++
      const message = err instanceof Error ? err.message : String(err)
      const exhausted = row.attempt_count >= CREW_SCHEDULE_CONFIRM_MAX_ATTEMPTS
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
        // ignore — the lease will requeue on its own after 5 minutes.
      }
    }
  }

  return { processed, materialized, notified, skipped, failed }
}
