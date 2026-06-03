import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { PermissionAction } from '@sitelayer/domain'
import { z } from 'zod'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { HttpError, parseJsonBody } from '../http-utils.js'
import { observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { enqueueNotification, recordMutationLedger, recordWorkflowEvent, withCompanyClient } from '../mutation-tx.js'
import { listIssueRecipientUserIds } from '../notifications.js'
import { withMutationTx } from '../mutation-tx.js'
import { assertKeyInCompany, type BlueprintStorage } from '../storage.js'
import {
  parseWorkerIssueAttachmentMultipart,
  WorkerIssueAttachmentUploadError,
} from '../worker-issue-attachment-upload.js'
import {
  FIELD_EVENT_WORKFLOW_NAME,
  FIELD_EVENT_WORKFLOW_SCHEMA_VERSION,
  nextFieldEventEvents,
  parseFieldEventEventRequest,
  transitionFieldEventWorkflow,
  type FieldEventResolutionAction,
  type FieldEventWorkflowEvent,
  type FieldEventWorkflowSnapshot,
  type FieldEventWorkflowState,
} from '@sitelayer/workflows'

/**
 * Routes for `wk-issue` from Sitemap §11 — worker "Flag a problem" pings.
 *
 * - POST /api/worker-issues  open ticket (any role; the worker filing
 *                            the issue is the actor on the row)
 * - GET  /api/worker-issues  list open issues for triage (admin/foreman/
 *                            office); supports ?resolved=true to see the
 *                            full history.
 *
 * The POST path also enqueues `notifications` rows for the company's
 * foreman/admin/office members so the foreman gets a push without having
 * to sit on the dashboard. Recipient resolution is intentionally broad —
 * the cost of an extra notification on a small construction company is
 * lower than a dropped ping.
 */
export type WorkerIssueRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  /** LAYER 2 named-action overlay; runs AFTER requireRole. See server.ts. */
  requirePermission: (action: PermissionAction, opts?: { amountCents?: number; otHours?: number }) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  /**
   * Storage backend (DO Spaces or local FS). Required by the attachment
   * upload + download endpoints; same instance the daily-logs and
   * blueprints routes use.
   */
  storage: BlueprintStorage
  /** Per-attachment cap (bytes). Photos are big; voice notes are small. */
  maxAttachmentBytes: number
  /** Whether the attachment download path returns presigned URLs. */
  attachmentDownloadPresigned: boolean
  /** Stream-back response shaping for attachment downloads. */
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
  sendFileRedirect: (location: string) => void
}

export type WorkerIssueAttachmentRow = {
  id: string
  company_id: string
  worker_issue_id: string
  kind: 'voice' | 'photo'
  storage_key: string
  mime_type: string
  size_bytes: string | number
  created_at: string
}

const ATTACHMENT_COLUMNS = `
  id, company_id, worker_issue_id, kind, storage_key, mime_type, size_bytes, created_at
`

const ALLOWED_KINDS = ['materials_out', 'crew_short', 'safety', 'other'] as const
type IssueKind = (typeof ALLOWED_KINDS)[number]

const KIND_LABELS: Record<IssueKind, string> = {
  materials_out: 'Out of materials',
  crew_short: 'Crew short',
  safety: 'Safety',
  other: 'Something else',
}

function parseKind(value: unknown): IssueKind | null {
  if (typeof value !== 'string') return null
  return (ALLOWED_KINDS as readonly string[]).includes(value) ? (value as IssueKind) : null
}

const ALLOWED_SEVERITIES = ['question', 'slowing', 'stopped'] as const
type IssueSeverity = (typeof ALLOWED_SEVERITIES)[number]

/**
 * Parse the create-time severity. Falls back to the migration-049 column
 * default ('slowing') when absent or invalid so the typed column is always
 * populated — this is what the auto-escalator's `severity='stopped'` filter
 * keys on (apps/worker/src/field-event-escalation.ts). The previous create
 * path omitted severity entirely and smuggled it into the message body as a
 * `[severity:…]` tag, so no UI-created issue ever became 'stopped' on the
 * column and 15-min auto-escalation could never fire.
 */
function parseSeverity(value: unknown): IssueSeverity {
  if (typeof value === 'string' && (ALLOWED_SEVERITIES as readonly string[]).includes(value)) {
    return value as IssueSeverity
  }
  return 'slowing'
}

/**
 * Structured material-request fulfillment fields (migration 126). These are
 * issue CONTENT, not workflow state — the field_event reducer never sees them
 * and they ride untouched across every transition. The materials_out create
 * flow captures `material_label` / `material_quantity` / `material_unit` so the
 * foreman blocker detail can render the design's typed quantity hero
 * ("12 SHEETS" over "EPS INSULATION") instead of re-parsing the worker's prose,
 * and so a future yard-stock read-model can match on typed values. All three
 * are optional: a non-materials ping (or a worker who only typed free text)
 * leaves them NULL and the read side falls back to the message parse.
 */
function parseMaterialLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, 200)
}

function parseMaterialUnit(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, 32)
}

function parseMaterialQuantity(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/** pg returns `numeric` as a string; normalize the read side to a number. */
function materialQuantityToNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

const ISSUE_COLUMNS = `
  id, company_id, project_id, worker_id, reporter_clerk_user_id,
  kind, message, severity, state, resolved_at, resolved_by_clerk_user_id,
  material_label, material_quantity, material_unit, created_at
`

const WORKFLOW_ISSUE_COLUMNS = `
  id, company_id, project_id, worker_id, reporter_clerk_user_id,
  kind, message, severity, state, resolved_at, resolved_by_clerk_user_id,
  resolved_action, resolution_message, state_version,
  escalated_to_estimator_at, escalation_reason,
  dismissed_at, dismissed_by_clerk_user_id,
  material_label, material_quantity, material_unit, created_at
`

type WorkflowIssueRow = {
  id: string
  company_id: string
  project_id: string | null
  worker_id: string | null
  reporter_clerk_user_id: string | null
  kind: string
  message: string
  severity: string
  state: FieldEventWorkflowState
  resolved_at: string | null
  resolved_by_clerk_user_id: string | null
  resolved_action: string | null
  resolution_message: string | null
  state_version: number
  escalated_to_estimator_at: string | null
  escalation_reason: string | null
  dismissed_at: string | null
  dismissed_by_clerk_user_id: string | null
  material_label: string | null
  material_quantity: string | number | null
  material_unit: string | null
  created_at: string
}

function rowToSnapshot(row: WorkflowIssueRow): FieldEventWorkflowSnapshot {
  return {
    state: row.state,
    state_version: row.state_version,
    resolved_at: row.resolved_at,
    resolved_by_user_id: row.resolved_by_clerk_user_id,
    resolved_action: (row.resolved_action as FieldEventResolutionAction | null) ?? null,
    resolution_message: row.resolution_message,
    escalated_to_estimator_at: row.escalated_to_estimator_at,
    escalation_reason: row.escalation_reason,
    dismissed_at: row.dismissed_at,
    dismissed_by_user_id: row.dismissed_by_clerk_user_id,
  }
}

function buildWorkflowResponse(row: WorkflowIssueRow) {
  const snapshot = rowToSnapshot(row)
  return {
    state: snapshot.state,
    state_version: snapshot.state_version,
    context: {
      id: row.id,
      project_id: row.project_id,
      worker_id: row.worker_id,
      kind: row.kind,
      message: row.message,
      severity: row.severity,
      resolved_at: row.resolved_at,
      resolved_action: row.resolved_action,
      resolution_message: row.resolution_message,
      escalated_to_estimator_at: row.escalated_to_estimator_at,
      escalation_reason: row.escalation_reason,
      dismissed_at: row.dismissed_at,
      dismissed_by_clerk_user_id: row.dismissed_by_clerk_user_id,
      // Structured material-request fields (migration 126). Surfaced on the
      // snapshot context so the foreman blocker detail's quantity hero reads
      // typed values; numeric quantity is normalized to a number (pg returns
      // `numeric` as a string).
      material_label: row.material_label,
      material_quantity: materialQuantityToNumber(row.material_quantity),
      material_unit: row.material_unit,
      created_at: row.created_at,
    },
    next_events: nextFieldEventEvents(snapshot.state),
  }
}

// POST /api/worker-issues wire-format. PERMISSIVE: the route re-parses every
// field through tolerant helpers (parseKind / parseSeverity / parseMaterial*)
// that already coerce or fall back, so the schema only types the fields the
// handler reads and rejects e.g. `message: { ... }` up front. `.loose()` so
// unknown keys pass through untouched. material_quantity stays string-or-number
// to match `parseMaterialQuantity`'s Number(...) coercion.
const NumericInputSchema = z.union([z.number(), z.string()])

const WorkerIssueCreateBodySchema = z
  .object({
    kind: z.string().optional(),
    message: z.string().optional(),
    project_id: z.string().nullish(),
    severity: z.string().nullish(),
    material_label: z.string().nullish(),
    material_quantity: NumericInputSchema.nullish(),
    material_unit: z.string().nullish(),
  })
  .loose()

export async function handleWorkerIssueRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: WorkerIssueRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/worker-issues') {
    const parsedBody = parseJsonBody(WorkerIssueCreateBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value
    const kind = parseKind(body.kind)
    if (!kind) {
      ctx.sendJson(400, { error: `kind must be one of ${ALLOWED_KINDS.join(', ')}` })
      return true
    }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (message.length === 0) {
      ctx.sendJson(400, { error: 'message is required' })
      return true
    }
    if (message.length > 2000) {
      ctx.sendJson(400, { error: 'message must be 2000 characters or fewer' })
      return true
    }
    const projectId = typeof body.project_id === 'string' && body.project_id.length > 0 ? body.project_id : null
    const severity = parseSeverity(body.severity)
    // LAYER 2: flag_issue vs stop_work — this one route performs BOTH named
    // actions, discriminated by severity. A 'stopped' severity is a
    // work-halting safety stop (the stop_work action; matches the
    // severity='stopped' auto-escalator + the full-screen stop-work takeover);
    // any other severity is an ordinary flag_issue. The route has no
    // requireRole (any member may file), so the overlay is the only gate: both
    // actions are in EVERY built-in base, so built-in roles are unaffected and
    // the overlay exists purely so a custom role can revoke flagging/stopping.
    const issueAction: PermissionAction = severity === 'stopped' ? 'stop_work' : 'flag_issue'
    if (!ctx.requirePermission(issueAction)) return true
    // Structured material-request fields are only meaningful for an
    // out-of-materials ping; ignore them on other kinds so a stray field can't
    // attach phantom material content to a safety/crew/other issue.
    const materialLabel = kind === 'materials_out' ? parseMaterialLabel(body.material_label) : null
    const materialQuantity = kind === 'materials_out' ? parseMaterialQuantity(body.material_quantity) : null
    const materialUnit = kind === 'materials_out' ? parseMaterialUnit(body.material_unit) : null

    // Resolve worker_id from the active membership when it exists. A row
    // without a worker mapping is fine — we still want to capture the
    // ping; just leave worker_id null. The `workers` table doesn't carry
    // `clerk_user_id` directly (membership lives on `company_memberships`),
    // so we mirror clock.ts's placeholder: pick the oldest worker until
    // the Clerk user → worker mapping lands in Phase 1D.4.
    const workerLookup = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ id: string }>(
        `select id from workers where company_id = $1 and deleted_at is null order by created_at asc limit 1`,
        [ctx.company.id],
      ),
    )
    const workerId = workerLookup.rows[0]?.id ?? null

    const insertedRow = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query(
        `insert into worker_issues
           (company_id, project_id, worker_id, reporter_clerk_user_id, kind, message, severity,
            material_label, material_quantity, material_unit)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning ${ISSUE_COLUMNS}`,
        [
          ctx.company.id,
          projectId,
          workerId,
          ctx.currentUserId,
          kind,
          message,
          severity,
          materialLabel,
          materialQuantity,
          materialUnit,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('worker_issues insert returned no row')
      return row
    })

    // Best-effort foreman fan-out. Notification enqueue failures are
    // logged but don't surface to the worker — the row is the audit trail.
    const recipients = await listIssueRecipientUserIds(ctx.pool, ctx.company.id)
    const subject = `${KIND_LABELS[kind]} reported`
    const text = projectId ? `${KIND_LABELS[kind]}: ${message}` : `${KIND_LABELS[kind]} (no project): ${message}`
    const payload = {
      worker_issue_id: insertedRow.id,
      kind,
      project_id: projectId,
      reporter_clerk_user_id: ctx.currentUserId,
    }
    if (recipients.length === 0) {
      await enqueueNotification({
        companyId: ctx.company.id,
        kind: 'worker_issue',
        subject,
        text,
        payload,
      })
    } else {
      for (const recipientUserId of recipients) {
        await enqueueNotification({
          companyId: ctx.company.id,
          recipientUserId,
          kind: 'worker_issue',
          subject,
          text,
          payload,
        })
      }
    }

    ctx.sendJson(201, { worker_issue: insertedRow })
    return true
  }

  // -------------------------------------------------------------------
  // Attachment routes — voice + photo uploads/downloads.
  //
  // Issued *before* the bare /api/worker-issues/:id matcher so the path
  // /api/worker-issues/:id/attachments doesn't accidentally match the
  // detail (it wouldn't anyway because of the trailing slash, but the
  // explicit ordering documents intent).
  // -------------------------------------------------------------------

  const attachmentsMatch = url.pathname.match(/^\/api\/worker-issues\/([^/]+)\/attachments$/)
  if (req.method === 'POST' && attachmentsMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const issueId = attachmentsMatch[1]!
    // Confirm the issue exists and is owned by this company before we
    // accept upload bytes — refuse early so a misdirected upload doesn't
    // burn a multipart cycle.
    const existing = await withCompanyClient(ctx.company.id, (c) =>
      c.query<{ id: string }>(`select id from worker_issues where company_id = $1 and id = $2 limit 1`, [
        ctx.company.id,
        issueId,
      ]),
    )
    if (!existing.rows[0]) {
      ctx.sendJson(404, { error: 'worker_issue not found' })
      return true
    }

    let upload
    try {
      upload = await parseWorkerIssueAttachmentMultipart(req, ctx.storage, ctx.company.id, issueId, {
        maxFileBytes: ctx.maxAttachmentBytes,
      })
    } catch (err) {
      if (err instanceof WorkerIssueAttachmentUploadError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }

    const inserted = await withMutationTx(async (client: PoolClient) => {
      // Voice notes are 1-per-issue; replace any prior voice attachment
      // (the partial unique index would otherwise reject the insert).
      if (upload.kind === 'voice') {
        await client.query(
          `delete from worker_issue_attachments
             where company_id = $1 and worker_issue_id = $2 and kind = 'voice'`,
          [ctx.company.id, issueId],
        )
      }
      const result = await client.query<WorkerIssueAttachmentRow>(
        `insert into worker_issue_attachments
           (company_id, worker_issue_id, kind, storage_key, mime_type, size_bytes)
         values ($1, $2, $3, $4, $5, $6)
         returning ${ATTACHMENT_COLUMNS}`,
        [ctx.company.id, issueId, upload.kind, upload.storagePath, upload.mimeType, upload.bytes],
      )
      const row = result.rows[0]
      if (!row) throw new HttpError(500, 'worker issue attachment insert returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'worker_issue_attachment',
        entityId: row.id,
        action: 'create',
        row: row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })

    // Pull the issue + the full attachment list so the client gets a
    // self-sufficient response (mirrors how POST /api/daily-logs/:id/photos
    // returns the updated row + the new photo).
    const [issue, attachments] = await Promise.all([
      withCompanyClient(ctx.company.id, (c) =>
        c.query(`select ${ISSUE_COLUMNS} from worker_issues where company_id = $1 and id = $2 limit 1`, [
          ctx.company.id,
          issueId,
        ]),
      ),
      withCompanyClient(ctx.company.id, (c) =>
        c.query<WorkerIssueAttachmentRow>(
          `select ${ATTACHMENT_COLUMNS} from worker_issue_attachments
         where company_id = $1 and worker_issue_id = $2
         order by created_at asc`,
          [ctx.company.id, issueId],
        ),
      ),
    ])

    ctx.sendJson(201, {
      worker_issue: issue.rows[0] ?? null,
      attachment: inserted,
      attachments: attachments.rows,
    })
    return true
  }

  if (req.method === 'GET' && attachmentsMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const issueId = attachmentsMatch[1]!
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<WorkerIssueAttachmentRow>(
        `select ${ATTACHMENT_COLUMNS} from worker_issue_attachments
       where company_id = $1 and worker_issue_id = $2
       order by created_at asc`,
        [ctx.company.id, issueId],
      ),
    )
    ctx.sendJson(200, { attachments: result.rows })
    return true
  }

  // GET /api/worker-issues/:id/attachments/:key/file — stream bytes (or
  // 302 to a presigned URL when BLUEPRINT_DOWNLOAD_PRESIGNED=1). The
  // storage key is URL-encoded in the path because keys contain `/`.
  const attachmentFileMatch = url.pathname.match(/^\/api\/worker-issues\/([^/]+)\/attachments\/([^/]+)\/file$/)
  if (req.method === 'GET' && attachmentFileMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const issueId = attachmentFileMatch[1]!
    const rawKey = attachmentFileMatch[2]!
    const key = decodeURIComponent(rawKey)
    try {
      assertKeyInCompany(ctx.company.id, key)
    } catch (err) {
      ctx.sendJson(400, { error: err instanceof Error ? err.message : 'invalid key' })
      return true
    }
    // Confirm the key actually points at an attachment for this issue
    // before we expose bytes. Defense-in-depth: assertKeyInCompany only
    // proves company scope; the row check proves issue scope.
    const lookup = await withCompanyClient(ctx.company.id, (c) =>
      c.query<WorkerIssueAttachmentRow>(
        `select ${ATTACHMENT_COLUMNS} from worker_issue_attachments
       where company_id = $1 and worker_issue_id = $2 and storage_key = $3
       limit 1`,
        [ctx.company.id, issueId, key],
      ),
    )
    const row = lookup.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'attachment not found on this issue' })
      return true
    }
    if (ctx.attachmentDownloadPresigned) {
      const presigned = await ctx.storage.getDownloadUrl(key)
      if (presigned) {
        ctx.sendFileRedirect(presigned)
        return true
      }
    }
    const buf = await ctx.storage.get(key)
    const fileName = key.split('/').pop() || (row.kind === 'voice' ? 'voice.webm' : 'photo.jpg')
    ctx.sendFileContent(row.mime_type || 'application/octet-stream', fileName, buf)
    return true
  }

  // GET /api/worker-issues/:id — workflow snapshot for fm-blocker-detail.
  // Returns { state, state_version, context, next_events } shape mirroring
  // the time-review-runs / rental-billing-state routes so the xstate
  // machine in apps/web/src/machines/field-event.ts can consume it as-is.
  const detailMatch = url.pathname.match(/^\/api\/worker-issues\/([^/]+)$/)
  if (req.method === 'GET' && detailMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const issueId = detailMatch[1]!
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<WorkflowIssueRow>(
        `select ${WORKFLOW_ISSUE_COLUMNS} from worker_issues where company_id = $1 and id = $2 limit 1`,
        [ctx.company.id, issueId],
      ),
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'worker_issue not found' })
      return true
    }
    ctx.sendJson(200, buildWorkflowResponse(row))
    return true
  }

  // PATCH /api/worker-issues/:id — apply a field-event workflow event
  // (RESOLVE / ESCALATE / DISMISS / REOPEN). Pure reducer applied in one
  // tx with optimistic state_version check; 409 on stale version. Side
  // effects enqueued via mutation_outbox so the worker drain can fan out
  // notifications. Mirrors apps/api/src/routes/time-review-runs.ts.
  if (req.method === 'PATCH' && detailMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const issueId = detailMatch[1]!
    const rawBody = await ctx.readBody()
    const parsed = parseFieldEventEventRequest(rawBody)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const updated = await withMutationTx(async (client: PoolClient) => {
      const existing = await client.query<WorkflowIssueRow>(
        `select ${WORKFLOW_ISSUE_COLUMNS} from worker_issues
         where company_id = $1 and id = $2
         for update
         limit 1`,
        [ctx.company.id, issueId],
      )
      const row = existing.rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.state_version !== parsed.value.state_version) {
        return { kind: 'version_conflict' as const, current: row }
      }
      const beforeSnapshot = rowToSnapshot(row)
      let event: FieldEventWorkflowEvent
      const now = new Date().toISOString()
      if (parsed.value.event === 'RESOLVE') {
        event = {
          type: 'RESOLVE',
          resolved_at: now,
          resolved_by_user_id: ctx.currentUserId,
          action: parsed.value.action,
          message_to_worker: parsed.value.message_to_worker,
        }
      } else if (parsed.value.event === 'ESCALATE') {
        event = {
          type: 'ESCALATE',
          escalated_at: now,
          escalator_user_id: ctx.currentUserId,
          reason: parsed.value.reason,
        }
      } else if (parsed.value.event === 'DISMISS') {
        event = {
          type: 'DISMISS',
          dismissed_at: now,
          dismissed_by_user_id: ctx.currentUserId,
        }
      } else {
        event = {
          type: 'REOPEN',
          reopened_at: now,
          reopener_user_id: ctx.currentUserId,
        }
      }
      let nextSnapshot: FieldEventWorkflowSnapshot
      try {
        nextSnapshot = transitionFieldEventWorkflow(beforeSnapshot, event)
      } catch (err) {
        return {
          kind: 'illegal_transition' as const,
          message: err instanceof Error ? err.message : 'illegal transition',
          current: row,
        }
      }
      // Persist the FULL reducer output in one snapshot-driven UPDATE for
      // every event type. The reducer already field-cleared every per-state
      // column (RESOLVE/ESCALATE/DISMISS/REOPEN each null the columns the
      // other branches own), so binding straight from `nextSnapshot` makes
      // the SQL provably honor the reducer and collapses the four divergent
      // per-event UPDATE branches that used to drift (e.g. the old DISMISS
      // branch never cleared escalated_to_estimator_at). `state` is now a
      // persisted column rather than a derived sentinel.
      await client.query(
        `update worker_issues set
           state = $1,
           state_version = $2,
           resolved_at = $3,
           resolved_by_clerk_user_id = $4,
           resolved_action = $5,
           resolution_message = $6,
           escalated_to_estimator_at = $7,
           escalation_reason = $8,
           dismissed_at = $9,
           dismissed_by_clerk_user_id = $10
         where id = $11 and company_id = $12`,
        [
          nextSnapshot.state,
          nextSnapshot.state_version,
          nextSnapshot.resolved_at ?? null,
          nextSnapshot.resolved_by_user_id ?? null,
          nextSnapshot.resolved_action ?? null,
          nextSnapshot.resolution_message ?? null,
          nextSnapshot.escalated_to_estimator_at ?? null,
          nextSnapshot.escalation_reason ?? null,
          nextSnapshot.dismissed_at ?? null,
          nextSnapshot.dismissed_by_user_id ?? null,
          issueId,
          ctx.company.id,
        ],
      )
      // Workflow event log
      await recordWorkflowEvent(client, {
        companyId: ctx.company.id,
        workflowName: FIELD_EVENT_WORKFLOW_NAME,
        schemaVersion: FIELD_EVENT_WORKFLOW_SCHEMA_VERSION,
        entityType: 'worker_issue',
        entityId: issueId,
        stateVersion: row.state_version,
        eventType: event.type,
        eventPayload: { ...event },
        snapshotAfter: { ...nextSnapshot },
        actorUserId: ctx.currentUserId,
      })
      // Side effects via outbox
      const fresh = await client.query<WorkflowIssueRow>(
        `select ${WORKFLOW_ISSUE_COLUMNS} from worker_issues where id = $1 and company_id = $2 limit 1`,
        [issueId, ctx.company.id],
      )
      const freshRow = fresh.rows[0]
      if (!freshRow) throw new HttpError(500, 'worker issue refetch returned no row')
      if (event.type === 'RESOLVE') {
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'worker_issue',
          entityId: issueId,
          action: 'notify_worker_resolution',
          row: freshRow,
          syncPayload: {
            worker_issue_id: issueId,
            project_id: freshRow.project_id,
            reporter_clerk_user_id: freshRow.reporter_clerk_user_id,
            worker_id: freshRow.worker_id,
            action: event.action,
            message_to_worker: event.message_to_worker,
          },
          outboxPayload: {
            worker_issue_id: issueId,
            project_id: freshRow.project_id,
            reporter_clerk_user_id: freshRow.reporter_clerk_user_id,
            worker_id: freshRow.worker_id,
            action: event.action,
            message_to_worker: event.message_to_worker,
          },
          mutationType: 'notify_worker_resolution',
          idempotencyKey: `worker_issue:resolve:${issueId}:${nextSnapshot.state_version}`,
        })
      } else if (event.type === 'ESCALATE') {
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'worker_issue',
          entityId: issueId,
          action: 'notify_estimator_escalation',
          row: freshRow,
          syncPayload: {
            worker_issue_id: issueId,
            project_id: freshRow.project_id,
            reason: event.reason,
            escalator_user_id: event.escalator_user_id,
          },
          outboxPayload: {
            worker_issue_id: issueId,
            project_id: freshRow.project_id,
            reason: event.reason,
            escalator_user_id: event.escalator_user_id,
          },
          mutationType: 'notify_estimator_escalation',
          idempotencyKey: `worker_issue:escalate:${issueId}:${nextSnapshot.state_version}`,
        })
      }
      return { kind: 'ok' as const, row: freshRow, eventType: event.type }
    })
    if (updated.kind === 'not_found') {
      ctx.sendJson(404, { error: 'worker_issue not found' })
      return true
    }
    if (updated.kind === 'version_conflict') {
      ctx.sendJson(409, {
        error: 'state_version mismatch — reload and retry',
        snapshot: buildWorkflowResponse(updated.current),
      })
      return true
    }
    if (updated.kind === 'illegal_transition') {
      ctx.sendJson(409, {
        error: updated.message,
        snapshot: buildWorkflowResponse(updated.current),
      })
      return true
    }
    const outcome = workflowEventOutcome(updated.eventType)
    if (outcome) observeWorkflowEvent(FIELD_EVENT_WORKFLOW_NAME, outcome)
    ctx.sendJson(200, buildWorkflowResponse(updated.row))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/worker-issues') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const includeResolved = url.searchParams.get('resolved') === 'true'
    const params: unknown[] = [ctx.company.id]
    let where = 'where company_id = $1'
    // Default (triage inbox) shows only `open`. Now that `state` is persisted
    // we filter on it rather than `resolved_at is null` — a dismissed row
    // also has resolved_at NULL but must NOT resurface in the open inbox.
    if (!includeResolved) where += ` and state = 'open'`
    const projectId = url.searchParams.get('project_id')
    if (projectId) {
      params.push(projectId)
      where += ` and project_id = $${params.length}`
    }
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100)))
    params.push(limit)
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${ISSUE_COLUMNS} from worker_issues ${where}
       order by created_at desc
       limit $${params.length}`,
        params,
      ),
    )
    ctx.sendJson(200, { worker_issues: result.rows })
    return true
  }

  return false
}
