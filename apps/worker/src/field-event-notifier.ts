/**
 * Field-event notification handler.
 *
 * Drains mutation_outbox rows enqueued by the field-event workflow
 * (packages/workflows/src/field-event.ts) and the project-lifecycle
 * workflow (packages/workflows/src/project-lifecycle.ts) and turns
 * them into `notifications` rows. Push delivery is not in scope for
 * this slice — the existing notifications drain
 * (apps/worker/src/notifications.ts) picks up the inserted rows on its
 * next tick and routes them through the channel dispatcher.
 *
 * Four mutation_types are claimed here:
 *   notify_worker_resolution    — RESOLVE event. Notify the worker who
 *                                 filed the ticket (recipient =
 *                                 reporter_clerk_user_id).
 *   notify_estimator_escalation — ESCALATE event. Fan-out to estimator
 *                                 / admin-role members of the company.
 *   notify_foreman_assignment   — Project-lifecycle ACCEPT or
 *                                 START_WORK. Resolve the foreman
 *                                 assigned to the project and notify
 *                                 them; if no foreman is assigned, fan
 *                                 out to admin/office.
 *   notify_field_request_denied — Owner denied a field request
 *                                 (work_item.status_changed → wont_do,
 *                                 apps/api/src/routes/work-requests.ts).
 *                                 Notify the foreman who filed it
 *                                 (recipient = created_by_user_id) with
 *                                 the owner's denial note; the payload
 *                                 carries a `/foreman/denied/:id` route
 *                                 so the inbox deep-links to the
 *                                 denied-feedback screen (msg__42).
 *
 * Idempotency is provided by the outbox row's idempotency_key
 * (`worker_issue:notify_*:<id>:<state_version>`,
 * `project_lifecycle:notify_foreman:<id>:<state_version>`, or
 * `context_work_item:notify_denied:<event_id>`), so a
 * re-claim after a worker crash inserts a notification row at most
 * once per state_version / denial event.
 *
 * The handler never calls any external API and only writes to
 * `notifications` and `mutation_outbox`. All work for one row happens
 * in a single transaction, mirroring `processLockLaborEntries`.
 */

import type { QueueClient } from '@sitelayer/queue'

export type FieldEventNotifierSummary = {
  processed: number
  notified: number
  skipped: number
  failed: number
}

type ClaimedRow = {
  id: string
  entity_id: string
  mutation_type:
    | 'notify_worker_resolution'
    | 'notify_estimator_escalation'
    | 'notify_foreman_assignment'
    | 'notify_field_request_denied'
  payload: Record<string, unknown>
  attempt_count: number
}

const FIELD_EVENT_MUTATION_TYPES = [
  'notify_worker_resolution',
  'notify_estimator_escalation',
  'notify_foreman_assignment',
  'notify_field_request_denied',
] as const

export const FIELD_EVENT_NOTIFIER_MAX_ATTEMPTS = 5

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function listProjectForemen(client: QueueClient, companyId: string, projectId: string): Promise<string[]> {
  // Project-level assignment is the source of truth for "who's running
  // this site" (per migration 046's design note). Company-level role is
  // a fallback only when no project_assignments row exists. We return
  // every active foreman assignment; a project may legitimately have
  // multiple foremen during a handoff window.
  const result = await client.query<{ clerk_user_id: string }>(
    `select clerk_user_id from project_assignments
     where company_id = $1 and project_id = $2 and role = 'foreman' and deleted_at is null`,
    [companyId, projectId],
  )
  return result.rows.map((r) => r.clerk_user_id)
}

async function listAdminOfficeRecipients(client: QueueClient, companyId: string): Promise<string[]> {
  // Fallback fan-out when notify_foreman_assignment fires before any
  // foreman has been assigned. Same shape as listEstimatorRecipients
  // — admin/office members are the catch-all queue for unowned work.
  const result = await client.query<{ clerk_user_id: string }>(
    `select cm.clerk_user_id from company_memberships cm
     where cm.company_id = $1 and cm.role in ('admin', 'office')`,
    [companyId],
  )
  return result.rows.map((r) => r.clerk_user_id)
}

async function listEstimatorRecipients(client: QueueClient, companyId: string): Promise<string[]> {
  // Estimator role isn't a first-class CompanyRole today (the union is
  // admin/foreman/office/member); admin members own the estimator
  // queue, so they're the fan-out target for an ESCALATE. Once the
  // estimator role lands as its own value, this query becomes the
  // single place to update — the route doesn't need to change.
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
 * Single-batch drain. Caller owns the pool; pass any pg-compatible
 * client (Pool, PoolClient) and the function manages its own
 * transactions per row, the same shape `processLockLaborEntries`
 * uses. Returns counts so the worker heartbeat can log them.
 */
export async function processFieldEventNotifications(
  client: QueueClient,
  companyId: string,
  limit = 25,
): Promise<FieldEventNotifierSummary> {
  let notified = 0
  let skipped = 0
  let failed = 0
  let processed = 0

  // Phase 1: claim. Own tx so the 'processing' marker is durable
  // even if every per-row body throws.
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
      [companyId, limit, [...FIELD_EVENT_MUTATION_TYPES]],
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

      if (row.mutation_type === 'notify_worker_resolution') {
        const reporterId = asString(payload.reporter_clerk_user_id)
        const message = asString(payload.message_to_worker) ?? '(no message)'
        const action = asString(payload.action) ?? 'resolved'
        const subject = 'Your foreman replied'
        const text = `Foreman action: ${action}\n\n${message}`
        if (!reporterId) {
          // No recipient — mark the row applied so it doesn't loop.
          // The audit trail is the worker_issues row itself; a missing
          // reporter id is a data shape bug, not a delivery failure.
          await client.query(
            `update mutation_outbox set status = 'applied', applied_at = now(), error = $3
             where company_id = $1 and id = $2`,
            [companyId, row.id, 'no recipient — skipped'],
          )
          await client.query('commit')
          skipped++
          continue
        }
        await insertNotification(client, {
          companyId,
          recipientUserId: reporterId,
          kind: 'worker_issue_resolved',
          subject,
          text,
          payload,
        })
      } else if (row.mutation_type === 'notify_foreman_assignment') {
        // Project-lifecycle ACCEPT (Loop 5: Sales handoff) or START_WORK
        // (Loop 1: Morning Brief). Resolve the foreman from
        // project_assignments; if unassigned, fan out to admin/office so
        // someone picks it up and assigns a foreman.
        const projectId = asString(payload.project_id) ?? row.entity_id
        const projectName = asString(payload.project_name) ?? '(unnamed project)'
        const customerName = asString(payload.customer_name) ?? '(unknown customer)'
        const transition = asString(payload.transition) ?? 'accepted'
        const subject = transition === 'started' ? 'Work started' : 'New project assigned'
        const text =
          transition === 'started'
            ? `Work has started on "${projectName}" for ${customerName}.`
            : `New project assigned: "${projectName}" for ${customerName}.`
        const foremen = await listProjectForemen(client, companyId, projectId)
        if (foremen.length > 0) {
          for (const recipientUserId of foremen) {
            await insertNotification(client, {
              companyId,
              recipientUserId,
              kind: 'foreman_assignment',
              subject,
              text,
              payload,
            })
          }
        } else {
          // No foreman picked yet — fan out to admin/office. Each
          // admin/office member gets their own delivery attempt; if no
          // such recipients exist either, fall back to a broadcast row
          // so the event isn't silently dropped (mirrors the estimator
          // escalation path below).
          const fallback = await listAdminOfficeRecipients(client, companyId)
          if (fallback.length === 0) {
            await insertNotification(client, {
              companyId,
              recipientUserId: null,
              kind: 'foreman_assignment',
              subject,
              text,
              payload,
            })
          } else {
            for (const recipientUserId of fallback) {
              await insertNotification(client, {
                companyId,
                recipientUserId,
                kind: 'foreman_assignment',
                subject,
                text,
                payload,
              })
            }
          }
        }
      } else if (row.mutation_type === 'notify_field_request_denied') {
        // Owner denied a field request. Single recipient: the foreman who
        // filed it (created_by_user_id, stamped as recipient_user_id by the
        // API enqueue). The notification payload keeps the API-stamped
        // `/foreman/denied/:id` route so the role inbox deep-links into the
        // denied-feedback screen. No fan-out fallback: a missing creator id
        // is a data-shape bug, not a delivery failure (mirrors
        // notify_worker_resolution).
        const recipientId = asString(payload.recipient_user_id)
        const title = asString(payload.title) ?? '(untitled request)'
        const reason = asString(payload.denial_message)
        const subject = `Request denied: ${title}`
        const text = reason ?? `Your request "${title}" won't move forward as submitted.`
        if (!recipientId) {
          await client.query(
            `update mutation_outbox set status = 'applied', applied_at = now(), error = $3
             where company_id = $1 and id = $2`,
            [companyId, row.id, 'no recipient — skipped'],
          )
          await client.query('commit')
          skipped++
          continue
        }
        await insertNotification(client, {
          companyId,
          recipientUserId: recipientId,
          kind: 'field_request_denied',
          subject,
          text,
          payload: {
            ...payload,
            route: asString(payload.route) ?? `/foreman/denied/${row.entity_id}`,
          },
        })
      } else {
        // notify_estimator_escalation: fan out to estimator/admin
        // members of the company. Insert one notifications row per
        // recipient so each gets their own delivery attempt.
        const reason = asString(payload.reason) ?? '(no reason)'
        const kindLabel = asString(payload.kind) ?? 'issue'
        const severity = asString(payload.severity) ?? 'slowing'
        const subject = `Field issue escalated to estimator (${severity})`
        const text = `Issue type: ${kindLabel}\nSeverity: ${severity}\nReason: ${reason}`
        const recipients = await listEstimatorRecipients(client, companyId)
        if (recipients.length === 0) {
          // No estimator/admin seat: insert a broadcast row so the
          // event isn't silently dropped. The notifications drain
          // logs broadcast rows via the console provider.
          await insertNotification(client, {
            companyId,
            recipientUserId: null,
            kind: 'field_event_escalation',
            subject,
            text,
            payload,
          })
        } else {
          for (const recipientUserId of recipients) {
            await insertNotification(client, {
              companyId,
              recipientUserId,
              kind: 'field_event_escalation',
              subject,
              text,
              payload,
            })
          }
        }
      }

      await client.query(
        `update mutation_outbox
           set status = 'applied', applied_at = now(), error = null
         where company_id = $1 and id = $2`,
        [companyId, row.id],
      )
      await client.query('commit')
      notified++
      // Touch this var so TS doesn't complain about unused helper for
      // future expansion (e.g. severity-based fast-path).
      void asNumber(payload.state_version)
    } catch (err) {
      await client.query('rollback').catch(() => {})
      failed++
      const message = err instanceof Error ? err.message : String(err)
      const exhausted = row.attempt_count >= FIELD_EVENT_NOTIFIER_MAX_ATTEMPTS
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

  return { processed, notified, skipped, failed }
}

// =============================================================================
// AUTO-ESCALATION INTEGRATION POINT
// =============================================================================
//
// Per the workflow doc in field-event.ts: when a worker_issues row has
// severity='stopped' and is older than 15 minutes without a RESOLVE,
// the system should auto-escalate to the estimator queue.
//
// The drain helper for that follow-up slice should:
//   1. Claim periodic-task rows of type 'field_event_escalation_check'
//      (or run on an unconditional 1-minute heartbeat — to be decided
//      when the periodic-task surface lands).
//   2. SELECT id, state_version FROM worker_issues
//      WHERE company_id = $1
//        AND severity = 'stopped'
//        AND resolved_at IS NULL
//        AND escalated_to_estimator_at IS NULL
//        AND created_at < now() - interval '15 minutes'
//      FOR UPDATE SKIP LOCKED;
//   3. For each row, build an ESCALATE FieldEventWorkflowEvent with
//      escalator_user_id = '__system_auto_escalation__' and
//      reason = 'auto_15min_stopped', run it through
//      transitionFieldEventWorkflow, persist via the same UPDATE the
//      PATCH route uses, append to workflow_event_log, and enqueue
//      notify_estimator_escalation through recordMutationLedger.
//   4. The notifier above then drains that outbox row exactly like a
//      human-driven ESCALATE — no code path here changes.
//
// Not implemented in this slice. Leaving the explicit recipe here so
// the follow-up agent doesn't have to re-derive it.
