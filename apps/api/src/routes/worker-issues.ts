import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
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

const ISSUE_COLUMNS = `
  id, company_id, project_id, worker_id, reporter_clerk_user_id,
  kind, message, resolved_at, resolved_by_clerk_user_id, created_at
`

const WORKFLOW_ISSUE_COLUMNS = `
  id, company_id, project_id, worker_id, reporter_clerk_user_id,
  kind, message, severity, resolved_at, resolved_by_clerk_user_id,
  resolved_action, resolution_message, state_version,
  escalated_to_estimator_at, escalation_reason, created_at
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
  resolved_at: string | null
  resolved_by_clerk_user_id: string | null
  resolved_action: string | null
  resolution_message: string | null
  state_version: number
  escalated_to_estimator_at: string | null
  escalation_reason: string | null
  created_at: string
}

const DISMISSED_ACTION_SENTINEL = '__dismissed__'

function rowToWorkflowState(row: WorkflowIssueRow): FieldEventWorkflowState {
  if (row.escalated_to_estimator_at) return 'escalated'
  if (row.resolved_at && row.resolved_action === DISMISSED_ACTION_SENTINEL) return 'dismissed'
  if (row.resolved_at) return 'resolved'
  return 'open'
}

function rowToSnapshot(row: WorkflowIssueRow): FieldEventWorkflowSnapshot {
  return {
    state: rowToWorkflowState(row),
    state_version: row.state_version,
    resolved_at: row.resolved_at,
    resolved_action:
      (row.resolved_action === DISMISSED_ACTION_SENTINEL
        ? null
        : (row.resolved_action as FieldEventResolutionAction | null)) ?? null,
    resolution_message: row.resolution_message,
    escalated_to_estimator_at: row.escalated_to_estimator_at,
    escalation_reason: row.escalation_reason,
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
      resolved_action: row.resolved_action === DISMISSED_ACTION_SENTINEL ? null : row.resolved_action,
      resolution_message: row.resolution_message,
      escalated_to_estimator_at: row.escalated_to_estimator_at,
      escalation_reason: row.escalation_reason,
      created_at: row.created_at,
    },
    next_events: nextFieldEventEvents(snapshot.state),
  }
}

export async function handleWorkerIssueRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: WorkerIssueRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/worker-issues') {
    const body = await ctx.readBody()
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
           (company_id, project_id, worker_id, reporter_clerk_user_id, kind, message)
         values ($1, $2, $3, $4, $5, $6)
         returning ${ISSUE_COLUMNS}`,
        [ctx.company.id, projectId, workerId, ctx.currentUserId, kind, message],
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
      const row = result.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'worker_issue_attachment',
        entityId: row.id,
        action: 'create',
        row: row as unknown as Record<string, unknown>,
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
          action: parsed.value.action!,
          message_to_worker: parsed.value.message_to_worker ?? null,
        }
      } else if (parsed.value.event === 'ESCALATE') {
        event = {
          type: 'ESCALATE',
          escalated_at: now,
          escalator_user_id: ctx.currentUserId,
          reason: parsed.value.reason!,
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
      // Persist. Branch by event type so we update only the relevant
      // columns and preserve the audit trail (reopen clears prior decision).
      if (event.type === 'RESOLVE') {
        await client.query(
          `update worker_issues set
             resolved_at = $1,
             resolved_by_clerk_user_id = $2,
             resolved_action = $3,
             resolution_message = $4,
             state_version = $5,
             escalated_to_estimator_at = NULL,
             escalation_reason = NULL
           where id = $6 and company_id = $7`,
          [
            event.resolved_at,
            event.resolved_by_user_id,
            event.action,
            event.message_to_worker,
            nextSnapshot.state_version,
            issueId,
            ctx.company.id,
          ],
        )
      } else if (event.type === 'ESCALATE') {
        await client.query(
          `update worker_issues set
             escalated_to_estimator_at = $1,
             escalation_reason = $2,
             state_version = $3
           where id = $4 and company_id = $5`,
          [event.escalated_at, event.reason, nextSnapshot.state_version, issueId, ctx.company.id],
        )
      } else if (event.type === 'DISMISS') {
        await client.query(
          `update worker_issues set
             resolved_at = $1,
             resolved_by_clerk_user_id = $2,
             resolved_action = $3,
             state_version = $4
           where id = $5 and company_id = $6`,
          [
            event.dismissed_at,
            event.dismissed_by_user_id,
            DISMISSED_ACTION_SENTINEL,
            nextSnapshot.state_version,
            issueId,
            ctx.company.id,
          ],
        )
      } else {
        await client.query(
          `update worker_issues set
             resolved_at = NULL,
             resolved_by_clerk_user_id = NULL,
             resolved_action = NULL,
             resolution_message = NULL,
             escalated_to_estimator_at = NULL,
             escalation_reason = NULL,
             state_version = $1
           where id = $2 and company_id = $3`,
          [nextSnapshot.state_version, issueId, ctx.company.id],
        )
      }
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
        snapshotAfter: { ...nextSnapshot } as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      // Side effects via outbox
      const fresh = await client.query<WorkflowIssueRow>(
        `select ${WORKFLOW_ISSUE_COLUMNS} from worker_issues where id = $1 and company_id = $2 limit 1`,
        [issueId, ctx.company.id],
      )
      const freshRow = fresh.rows[0]!
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
      return { kind: 'ok' as const, row: freshRow }
    })
    if (updated.kind === 'not_found') {
      ctx.sendJson(404, { error: 'worker_issue not found' })
      return true
    }
    if (updated.kind === 'version_conflict') {
      ctx.sendJson(409, { error: 'state_version stale', ...buildWorkflowResponse(updated.current) })
      return true
    }
    if (updated.kind === 'illegal_transition') {
      ctx.sendJson(409, { error: updated.message, ...buildWorkflowResponse(updated.current) })
      return true
    }
    ctx.sendJson(200, buildWorkflowResponse(updated.row))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/worker-issues') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const includeResolved = url.searchParams.get('resolved') === 'true'
    const params: unknown[] = [ctx.company.id]
    let where = 'where company_id = $1'
    if (!includeResolved) where += ' and resolved_at is null'
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
