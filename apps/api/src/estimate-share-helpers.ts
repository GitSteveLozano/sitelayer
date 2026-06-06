import type { Pool, PoolClient } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { verifyShareToken, type VerifyShareTokenResult } from './estimate-share-token.js'
import { enqueueNotification, recordMutationLedger, recordWorkflowEvent } from './mutation-tx.js'
import { listOperatorRecipientUserIds } from './notifications.js'

export const logger = createLogger('api:estimate-shares')

// Customer-facing URL prefix (React Router route, served by the SPA).
// Used to construct the share_url that's emailed/sent to the recipient.
export const PORTAL_ESTIMATES_PATH_PREFIX = '/portal/estimates/'
// API endpoint prefix (handled by handlePublicEstimateShareRoutes).
export const API_PORTAL_ESTIMATES_PATH_PREFIX = '/api/portal/estimates/'

export type EstimateLineSnapshot = {
  service_item_code: string
  quantity: number
  unit: string
  rate: number
  amount: number
  division_code: string | null
}

export type EstimateSnapshot = {
  bid_total: number
  scope_total: number
  lines: EstimateLineSnapshot[]
  /** ISO timestamp recorded at snapshot time (informational). */
  captured_at: string
}

export type EstimateShareRow = {
  id: string
  company_id: string
  project_id: string
  estimate_snapshot: EstimateSnapshot
  share_token: string
  recipient_email: string | null
  recipient_name: string | null
  sent_at: string
  expires_at: string
  accepted_at: string | null
  declined_at: string | null
  decline_reason: string | null
  viewed_at: string | null
  view_count: number
  signature_data_url: string | null
  signer_name: string | null
  signer_ip: string | null
  // estimate_share workflow columns (migration 115).
  status: string | null
  state_version: number
  message: string | null
  include_signed_link: boolean | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

export const SHARE_COLUMNS = `
  id, company_id, project_id, estimate_snapshot, share_token,
  recipient_email, recipient_name, sent_at, expires_at,
  accepted_at, declined_at, decline_reason, viewed_at, view_count,
  signature_data_url, signer_name, host(signer_ip) as signer_ip,
  status, state_version, message, include_signed_link, revoked_at,
  created_at, updated_at
`

// ---------------------------------------------------------------------------
// Helpers — kept in this module so the auth + portal handlers share one
// view of "valid token + non-expired + still resolvable".
// ---------------------------------------------------------------------------

export type ProjectRow = {
  id: string
  bid_total: number
  lifecycle_state: string
  lifecycle_state_version: number
}

export async function loadProject(
  executor: Pool | PoolClient,
  companyId: string,
  projectId: string,
): Promise<ProjectRow | null> {
  const result = await executor.query<{
    id: string
    bid_total: string | number | null
    lifecycle_state: string
    lifecycle_state_version: number
  }>(
    `select id, bid_total, lifecycle_state, lifecycle_state_version
     from projects
     where company_id = $1 and id = $2
     limit 1`,
    [companyId, projectId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    bid_total: Number(row.bid_total ?? 0),
    lifecycle_state: row.lifecycle_state,
    lifecycle_state_version: row.lifecycle_state_version,
  }
}

export async function snapshotEstimate(
  executor: Pool | PoolClient,
  companyId: string,
  projectId: string,
  bidTotal: number,
): Promise<EstimateSnapshot> {
  const result = await executor.query<{
    service_item_code: string
    quantity: string | number
    unit: string
    rate: string | number
    amount: string | number
    division_code: string | null
  }>(
    `select service_item_code, quantity, unit, rate, amount, division_code
     from estimate_lines
     where company_id = $1 and project_id = $2
     order by created_at asc, service_item_code asc`,
    [companyId, projectId],
  )
  const lines: EstimateLineSnapshot[] = result.rows.map((row) => ({
    service_item_code: row.service_item_code,
    quantity: Number(row.quantity),
    unit: row.unit,
    rate: Number(row.rate),
    amount: Number(row.amount),
    division_code: row.division_code,
  }))
  const scopeTotal = lines.reduce((sum, line) => sum + line.amount, 0)
  return {
    bid_total: bidTotal,
    scope_total: Math.round(scopeTotal * 100) / 100,
    lines,
    captured_at: new Date().toISOString(),
  }
}

export type ShareLookupOk = { ok: true; row: EstimateShareRow }
export type ShareLookupErr = { ok: false; status: number; error: string }
export type ShareLookupResult = ShareLookupOk | ShareLookupErr

export function classifyShareForRecipient(
  row: EstimateShareRow | null,
  verify: VerifyShareTokenResult,
): ShareLookupResult {
  if (!verify.ok) return { ok: false, status: 401, error: 'invalid share token' }
  if (!row) return { ok: false, status: 404, error: 'share link not found' }
  const expiresMs = new Date(row.expires_at).getTime()
  if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
    return { ok: false, status: 410, error: 'share link has expired' }
  }
  return { ok: true, row }
}

export async function loadShareByToken(
  executor: Pool | PoolClient,
  secret: string,
  token: string,
): Promise<ShareLookupResult> {
  const verify = verifyShareToken(token, secret)
  if (!verify.ok) return { ok: false, status: 401, error: 'invalid share token' }
  const result = await executor.query<EstimateShareRow>(
    `select ${SHARE_COLUMNS}
     from estimate_share_links
     where share_token = $1
     limit 1`,
    [token],
  )
  return classifyShareForRecipient(result.rows[0] ?? null, verify)
}

export async function loadShareByTokenForUpdate(
  client: PoolClient,
  secret: string,
  token: string,
): Promise<ShareLookupResult> {
  const verify = verifyShareToken(token, secret)
  if (!verify.ok) return { ok: false, status: 401, error: 'invalid share token' }
  const result = await client.query<EstimateShareRow>(
    `select ${SHARE_COLUMNS}
     from estimate_share_links
     where share_token = $1
     for update
     limit 1`,
    [token],
  )
  return classifyShareForRecipient(result.rows[0] ?? null, verify)
}

export async function loadProjectAndCompanyForShare(
  pool: Pool,
  row: EstimateShareRow,
): Promise<{ project_name: string; company_name: string; customer_name: string | null }> {
  const result = await pool.query<{
    project_name: string
    company_name: string
    customer_name: string | null
  }>(
    `select p.name as project_name, c.name as company_name, p.customer_name
     from projects p
     join companies c on c.id = p.company_id
     where p.company_id = $1 and p.id = $2
     limit 1`,
    [row.company_id, row.project_id],
  )
  const out = result.rows[0]
  return {
    project_name: out?.project_name ?? 'Estimate',
    company_name: out?.company_name ?? 'Sitelayer',
    customer_name: out?.customer_name ?? null,
  }
}

/**
 * Best-effort operator notification fan-out triggered when a customer
 * opens an estimate share link for the FIRST time. Subsequent views
 * silently update view_count + viewed_at without re-notifying — the
 * caller establishes "first view" via the prev_viewed_at CTE so this
 * helper just delivers.
 *
 * We don't await individual enqueue failures because the parent
 * function already wraps the fan-out in a `.catch(() => undefined)`:
 * the share view succeeds even if every notification fails. Per-row
 * errors are logged through `enqueueNotification` (mutation-tx).
 */
export async function fanOutFirstViewNotification(
  pool: Pool,
  row: EstimateShareRow,
  meta: { project_name: string; customer_name: string | null },
): Promise<void> {
  const customerLabel =
    row.recipient_name?.trim() || meta.customer_name?.trim() || row.recipient_email?.trim() || 'A customer'
  const subject = 'Customer viewed estimate'
  const bodyText = `${customerLabel} opened the estimate for ${meta.project_name}`
  const payload = {
    estimate_share_id: row.id,
    project_id: row.project_id,
    project_name: meta.project_name,
    customer_name: meta.customer_name,
    recipient_email: row.recipient_email,
    recipient_name: row.recipient_name,
    link_target: `/projects/${row.project_id}?tab=estimate`,
  }
  const recipients = await listOperatorRecipientUserIds(pool, row.company_id)
  if (recipients.length === 0) {
    // Broadcast row — worker logs via the console provider. Keeps the
    // signal visible even on a company that hasn't seated admin/office.
    await enqueueNotification({
      companyId: row.company_id,
      kind: 'estimate_share_viewed',
      subject,
      text: bodyText,
      payload,
    })
    return
  }
  for (const recipientUserId of recipients) {
    await enqueueNotification({
      companyId: row.company_id,
      recipientUserId,
      kind: 'estimate_share_viewed',
      subject,
      text: bodyText,
      payload,
    })
  }
}

export function shareStatus(row: EstimateShareRow): 'accepted' | 'declined' | 'expired' | 'revoked' | 'pending' {
  if (row.accepted_at) return 'accepted'
  if (row.declined_at) return 'declined'
  if (row.revoked_at || row.status === 'revoked') return 'revoked'
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired'
  return 'pending'
}

/**
 * Funnel status surfaced in the company-wide "estimates sent" timeline.
 * Distinct from `shareStatus` because the timeline cares about the
 * intermediate "viewed but not yet decided" state — the per-recipient
 * portal payload collapses that into `pending` (the customer doesn't
 * need to know about their own view bump).
 */
export type TimelineStatus = 'accepted' | 'declined' | 'expired' | 'revoked' | 'viewed' | 'sent'

export function computeTimelineStatus(row: {
  accepted_at: string | null
  declined_at: string | null
  expires_at: string
  viewed_at: string | null
  revoked_at?: string | null
  status?: string | null
}): TimelineStatus {
  if (row.accepted_at) return 'accepted'
  if (row.declined_at) return 'declined'
  if (row.revoked_at || row.status === 'revoked') return 'revoked'
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired'
  if (row.viewed_at) return 'viewed'
  return 'sent'
}

export function buildPortalView(row: EstimateShareRow, meta: { project_name: string; company_name: string }) {
  return {
    id: row.id,
    project_name: meta.project_name,
    company_name: meta.company_name,
    recipient_email: row.recipient_email,
    recipient_name: row.recipient_name,
    sent_at: row.sent_at,
    expires_at: row.expires_at,
    status: shareStatus(row),
    estimate: row.estimate_snapshot,
    accepted_at: row.accepted_at,
    declined_at: row.declined_at,
    decline_reason: row.decline_reason,
    signer_name: row.signer_name,
    // Don't return the signature image to viewers; only the existence
    // is surfaced via signer_name + accepted_at. The original image is
    // available to authenticated company users only (read direct from
    // the row).
  }
}

export function buildShareUrl(portalBaseUrl: string, token: string): string {
  const trimmed = portalBaseUrl.replace(/\/$/, '')
  return `${trimmed}${PORTAL_ESTIMATES_PATH_PREFIX}${encodeURIComponent(token)}`
}

// ---------------------------------------------------------------------------
// Lifecycle helper — best-effort transition. The project-lifecycle
// workflow module (`apps/api/src/routes/project-lifecycle.ts` + the
// pure reducer in `packages/workflows/src/project-lifecycle.ts`,
// migration 048) now ships. This helper still writes the SEND/ACCEPT/
// DECLINE transitions inline using the same column names and
// `workflow_event_log` shape the lifecycle endpoint uses, rather than
// delegating to that reducer — an intentional deferred refactor, not a
// missing dependency.
//
// The transition table here is a strict subset of the canonical reducer
// (SEND: estimating→sent, ACCEPT: sent→accepted, DECLINE: sent→declined).
// Anything else is a no-op so the share row remains the source of truth
// even when the lifecycle is in an unexpected state. A future cleanup
// should collapse this onto the canonical reducer via the lifecycle event
// path instead of duplicating the transition table here.
// ---------------------------------------------------------------------------

export type LifecycleEventKind = 'SEND' | 'ACCEPT' | 'DECLINE'

export type LifecycleApplyResult =
  | { kind: 'applied'; toState: string }
  | { kind: 'transition_failed'; fromState: string }
  | { kind: 'project_not_found' }

export const LIFECYCLE_TRANSITIONS: Record<LifecycleEventKind, { from: string; to: string }> = {
  SEND: { from: 'estimating', to: 'sent' },
  ACCEPT: { from: 'sent', to: 'accepted' },
  DECLINE: { from: 'sent', to: 'declined' },
}

export const PROJECT_LIFECYCLE_WORKFLOW_NAME = 'project_lifecycle'
export const PROJECT_LIFECYCLE_WORKFLOW_SCHEMA_VERSION = 1

export async function maybeApplyLifecycleEvent(
  client: PoolClient,
  args: {
    companyId: string
    projectId: string
    eventType: LifecycleEventKind
    actorUserId: string
    reason?: string
  },
): Promise<LifecycleApplyResult> {
  const projectResult = await client.query<{
    lifecycle_state: string
    lifecycle_state_version: number
  }>(
    `select lifecycle_state, lifecycle_state_version
     from projects
     where company_id = $1 and id = $2
     for update
     limit 1`,
    [args.companyId, args.projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return { kind: 'project_not_found' }

  const transition = LIFECYCLE_TRANSITIONS[args.eventType]
  const fromState = project.lifecycle_state
  if (fromState !== transition.from) {
    return { kind: 'transition_failed', fromState }
  }

  const occurredAt = new Date().toISOString()
  const nextStateVersion = project.lifecycle_state_version + 1

  const setClauses: string[] = ['lifecycle_state = $1', 'lifecycle_state_version = $2', 'updated_at = now()']
  const params: unknown[] = [transition.to, nextStateVersion]
  if (args.eventType === 'SEND') {
    setClauses.push(`lifecycle_sent_at = $${params.length + 1}`)
    params.push(occurredAt)
  } else if (args.eventType === 'ACCEPT') {
    setClauses.push(`lifecycle_accepted_at = $${params.length + 1}`)
    params.push(occurredAt)
    setClauses.push('lifecycle_declined_at = NULL')
    setClauses.push('lifecycle_decline_reason = NULL')
  } else {
    setClauses.push(`lifecycle_declined_at = $${params.length + 1}`)
    params.push(occurredAt)
    setClauses.push(`lifecycle_decline_reason = $${params.length + 1}`)
    params.push(args.reason ?? null)
  }

  params.push(args.companyId, args.projectId)
  const idIndex = params.length
  await client.query(
    `update projects
     set ${setClauses.join(', ')}
     where company_id = $${idIndex - 1} and id = $${idIndex}`,
    params,
  )

  const eventPayload: Record<string, unknown> = {
    type: args.eventType,
    actor_user_id: args.actorUserId,
    occurred_at: occurredAt,
  }
  if (args.eventType === 'DECLINE' && args.reason) {
    eventPayload.reason = args.reason
  }
  const snapshotAfter: Record<string, unknown> = {
    state: transition.to,
    state_version: nextStateVersion,
  }
  if (args.eventType === 'SEND') snapshotAfter.sent_at = occurredAt
  if (args.eventType === 'ACCEPT') {
    snapshotAfter.accepted_at = occurredAt
    snapshotAfter.declined_at = null
    snapshotAfter.decline_reason = null
  }
  if (args.eventType === 'DECLINE') {
    snapshotAfter.declined_at = occurredAt
    snapshotAfter.decline_reason = args.reason ?? null
  }

  await recordWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: PROJECT_LIFECYCLE_WORKFLOW_NAME,
    schemaVersion: PROJECT_LIFECYCLE_WORKFLOW_SCHEMA_VERSION,
    entityType: 'project',
    entityId: args.projectId,
    stateVersion: project.lifecycle_state_version,
    eventType: args.eventType,
    eventPayload,
    snapshotAfter,
    actorUserId: args.actorUserId,
  })

  // Mirror the side-effect that the canonical lifecycle route emits on
  // ACCEPT/START_WORK so a customer accepting their estimate from the
  // public portal triggers the same foreman-assignment notification a
  // staff-driven ACCEPT would. Idempotency key matches the route shape
  // (project_lifecycle:notify_foreman:<id>:<state_version>) so retries
  // and duplicate ACCEPTs upsert the same outbox row.
  if (args.eventType === 'ACCEPT') {
    const projectMeta = await client.query<{ name: string; customer_name: string | null }>(
      `select name, customer_name from projects where company_id = $1 and id = $2 limit 1`,
      [args.companyId, args.projectId],
    )
    const meta = projectMeta.rows[0] ?? { name: 'Project', customer_name: null }
    await recordMutationLedger(client, {
      companyId: args.companyId,
      entityType: 'project',
      entityId: args.projectId,
      action: 'notify_foreman_assignment',
      row: { project_id: args.projectId, lifecycle_state: transition.to, state_version: nextStateVersion },
      syncPayload: {
        project_id: args.projectId,
        project_name: meta.name,
        customer_name: meta.customer_name,
        transition: 'accepted',
        actor_user_id: args.actorUserId,
        occurred_at: occurredAt,
      },
      outboxPayload: {
        project_id: args.projectId,
        project_name: meta.name,
        customer_name: meta.customer_name,
        transition: 'accepted',
        actor_user_id: args.actorUserId,
        occurred_at: occurredAt,
      },
      mutationType: 'notify_foreman_assignment',
      idempotencyKey: `project_lifecycle:notify_foreman:${args.projectId}:${nextStateVersion}`,
    })
  }

  return { kind: 'applied', toState: transition.to }
}
