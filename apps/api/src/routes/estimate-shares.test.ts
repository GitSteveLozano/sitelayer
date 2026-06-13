import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { PORTAL_ESTIMATES_PATH_PREFIX, type EstimateShareRow } from '../estimate-share-helpers.js'
import { handleEstimateShareRoutes } from './estimate-shares-admin.js'
import { handlePublicEstimateShareRoutes } from './estimate-shares-portal.js'
import { generateShareToken } from '../estimate-share-token.js'
import type { BlueprintStorage, DownloadUrlOptions, PutStreamOptions } from '../storage.js'

// ---------------------------------------------------------------------------
// In-memory pg double — covers what the share routes need without spinning
// a real Postgres. Each fake responds to the SQL the route module emits by
// matching on a substring; test setup wires the rows the route should see.
// Mirrors the simple stubs other apps/api tests use; not a general-purpose
// SQL emulator.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  shares: EstimateShareRow[] = []
  projects: Row[] = []
  companies: Row[] = []
  memberships: Array<{ company_id: string; clerk_user_id: string; role: string }> = []
  workflowEvents: Row[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  notifications: Array<{
    company_id: string
    recipient_clerk_user_id: string | null
    recipient_email: string | null
    kind: string
    subject: string
    body_text: string
    payload: Record<string, unknown>
  }> = []
  captureSessions: Row[] = []
  captureEvents: Row[] = []
  captureArtifacts: Row[] = []
  supportPackets: Row[] = []
  workItems: Row[] = []
  handoffEvents: Row[] = []
  expiredOverride: { token: string; expiresAt: string } | null = null

  /** Register this fake pool with the mutation-tx module for the
   * duration of the test that owns it. */
  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  async connect() {
    // Each connect() returns a tx-scoped client. The fake's tx semantics
    // are weak: we don't roll back on throw, but the route module's `for
    // update` selects + updates land on the same backing store, which is
    // enough for the assertions below.
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    const normalized = sqlRaw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // ---- estimate_share_links ----
    if (/select[\s\S]+from estimate_share_links/i.test(sql) && /share_token = \$1/.test(sql)) {
      const [token] = params as [string]
      const row = this.shares.find((s) => s.share_token === token) ?? null
      return { rows: row ? [this.serializeShare(row)] : [], rowCount: row ? 1 : 0 }
    }
    // Revoke locks the row by company_id + id (for update) before dispatching.
    if (
      /select[\s\S]+from estimate_share_links/i.test(sql) &&
      /company_id = \$1 and id = \$2/.test(sql) &&
      /for update/i.test(sql)
    ) {
      const [companyId, id] = params as [string, string]
      const row = this.shares.find((s) => s.company_id === companyId && s.id === id) ?? null
      return { rows: row ? [this.serializeShare(row)] : [], rowCount: row ? 1 : 0 }
    }
    if (/select[\s\S]+from estimate_share_links/i.test(sql) && /project_id = \$2/.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const rows = this.shares
        .filter((s) => s.company_id === companyId && s.project_id === projectId)
        .map((s) => this.serializeShare(s))
      return { rows, rowCount: rows.length }
    }
    // GET /api/estimate-shares — company-wide timeline. The route emits
    // a CTE that projects one row per project_id (latest sent_at) joined
    // against projects. Emulate the same shape: pick the latest share per
    // project, then attach project name / customer / bid_total.
    if (/with latest as/i.test(sql) && /from estimate_share_links/i.test(sql)) {
      const [companyId] = params as [string]
      const byProject = new Map<string, EstimateShareRow>()
      for (const share of this.shares.filter((s) => s.company_id === companyId)) {
        const current = byProject.get(share.project_id)
        if (!current || new Date(share.sent_at).getTime() > new Date(current.sent_at).getTime()) {
          byProject.set(share.project_id, share)
        }
      }
      const rows = Array.from(byProject.values())
        .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())
        .map((share) => {
          const project = this.projects.find((p) => p.company_id === companyId && p.id === share.project_id)
          return {
            id: share.id,
            project_id: share.project_id,
            project_name: project?.name ?? 'Unknown',
            customer_name: project?.customer_name ?? null,
            bid_total: project?.bid_total ?? 0,
            recipient_email: share.recipient_email,
            recipient_name: share.recipient_name,
            sent_at: share.sent_at,
            expires_at: share.expires_at,
            accepted_at: share.accepted_at,
            declined_at: share.declined_at,
            decline_reason: share.decline_reason,
            viewed_at: share.viewed_at,
            view_count: share.view_count,
            signer_name: share.signer_name,
            revoked_at: share.revoked_at,
            status: share.status,
          }
        })
      return { rows, rowCount: rows.length }
    }
    if (/insert into estimate_share_links/i.test(sql)) {
      const [companyId, projectId, snapshot, token, email, name, expiresInDays, message, includeSignedLink] =
        params as [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          string | null,
          boolean | undefined,
        ]
      const now = new Date().toISOString()
      const expires = new Date(Date.now() + Number(expiresInDays) * 86_400_000).toISOString()
      const row: EstimateShareRow = {
        id: `share-${this.shares.length + 1}`,
        company_id: companyId,
        project_id: projectId,
        estimate_snapshot: JSON.parse(snapshot),
        share_token: token,
        recipient_email: email,
        recipient_name: name,
        sent_at: now,
        expires_at: expires,
        accepted_at: null,
        declined_at: null,
        decline_reason: null,
        viewed_at: null,
        view_count: 0,
        signature_data_url: null,
        signer_name: null,
        signer_ip: null,
        status: 'sent',
        state_version: 1,
        message: message ?? null,
        include_signed_link: includeSignedLink ?? true,
        revoked_at: null,
        last_accessed_at: null,
        access_count: 0,
        created_at: now,
        updated_at: now,
      }
      this.shares.push(row)
      return { rows: [this.serializeShare(row)], rowCount: 1 }
    }
    // Standalone access-audit bump (recordShareAccess) — the GET + capture
    // routes fire `set access_count = access_count + 1, last_accessed_at = now()`
    // in its own GUC-bound tx. Matched BEFORE the viewed_at/accept/decline
    // matchers (none of which contain this exact set-list).
    if (
      /update estimate_share_links/i.test(sql) &&
      /access_count = access_count \+ 1/.test(sql) &&
      /last_accessed_at = now\(\)/.test(sql) &&
      !/accepted_at = now\(\)/.test(sql) &&
      !/declined_at = now\(\)/.test(sql)
    ) {
      const [companyId, id] = params as [string, string]
      const row = this.shares.find((s) => s.company_id === companyId && s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.access_count += 1
      row.last_accessed_at = new Date().toISOString()
      return { rows: [], rowCount: 1 }
    }
    // Revoke dispatch — select ... for update, then set status/state_version/
    // revoked_at + expires_at = now().
    if (/update estimate_share_links/i.test(sql) && /set status = \$3/.test(sql)) {
      const [companyId, id, status, stateVersion, revokedAt] = params as [string, string, string, number, string]
      const row = this.shares.find((s) => s.company_id === companyId && s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      row.status = status
      row.state_version = stateVersion
      row.revoked_at = revokedAt
      row.expires_at = new Date().toISOString()
      row.updated_at = row.expires_at
      return { rows: [this.serializeShare(row)], rowCount: 1 }
    }
    if (/update estimate_share_links/i.test(sql) && /accepted_at = now\(\)/.test(sql)) {
      const [id, signerName, signatureUrl, ip] = params as [string, string, string, string | null]
      const row = this.shares.find((s) => s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      const now = new Date().toISOString()
      row.accepted_at = now
      row.signer_name = signerName
      row.signature_data_url = signatureUrl
      row.signer_ip = ip
      row.viewed_at = row.viewed_at ?? now
      row.access_count += 1
      row.last_accessed_at = now
      row.updated_at = now
      return { rows: [this.serializeShare(row)], rowCount: 1 }
    }
    if (/update estimate_share_links/i.test(sql) && /declined_at = now\(\)/.test(sql)) {
      const [id, reason] = params as [string, string]
      const row = this.shares.find((s) => s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      const now = new Date().toISOString()
      row.declined_at = now
      row.decline_reason = reason
      row.viewed_at = row.viewed_at ?? now
      row.access_count += 1
      row.last_accessed_at = now
      row.updated_at = now
      return { rows: [this.serializeShare(row)], rowCount: 1 }
    }
    if (/update estimate_share_links/i.test(sql) && /viewed_at = coalesce/.test(sql)) {
      const [id] = params as [string]
      const row = this.shares.find((s) => s.id === id)
      if (!row) return { rows: [], rowCount: 0 }
      const now = new Date().toISOString()
      const prevViewedAt = row.viewed_at
      row.viewed_at = row.viewed_at ?? now
      row.view_count += 1
      row.updated_at = now
      // Route emits a CTE update that returns prev.prev_viewed_at so the
      // caller can detect "first view" without a separate read; mirror
      // that shape when the SQL contains the CTE, fall back to the
      // legacy empty-rows shape for any other queries that hit the same
      // matcher.
      if (/prev_viewed_at/.test(sql)) {
        return { rows: [{ prev_viewed_at: prevViewedAt }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }

    // ---- projects ----
    if (/select id, bid_total, lifecycle_state/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }
    if (/select lifecycle_state, lifecycle_state_version/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 }
    }
    if (/p\.name as project_name/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      const company = this.companies.find((c) => c.id === companyId)
      if (!project || !company) return { rows: [], rowCount: 0 }
      return {
        rows: [
          {
            project_name: project.name,
            company_name: company.name,
            customer_name: project.customer_name ?? null,
          },
        ],
        rowCount: 1,
      }
    }
    if (/select service_item_code, quantity, unit, rate, amount/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      // Test data: project p1 has two lines, total 1234.56.
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      return {
        rows: project.estimate_lines as Row[],
        rowCount: (project.estimate_lines as Row[]).length,
      }
    }
    if (/update projects/i.test(sql)) {
      // Lifecycle update — rewrite mapped columns. We don't bother to
      // parse the SET clause; route tests assert via re-reading the
      // project after the fact.
      const projectId = params[params.length - 1] as string
      const companyId = params[params.length - 2] as string
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      project.lifecycle_state = params[0]
      project.lifecycle_state_version = params[1]
      // Map the remaining params loosely: 3rd param is the timestamp in
      // SEND/ACCEPT/DECLINE; for ACCEPT we also pass NULLs but those land
      // as static SET NULL clauses, not parameters.
      if (project.lifecycle_state === 'sent') project.lifecycle_sent_at = params[2]
      if (project.lifecycle_state === 'accepted') {
        project.lifecycle_accepted_at = params[2]
        project.lifecycle_declined_at = null
        project.lifecycle_decline_reason = null
      }
      if (project.lifecycle_state === 'declined') {
        project.lifecycle_declined_at = params[2]
        project.lifecycle_decline_reason = params[3]
      }
      return { rows: [], rowCount: 1 }
    }

    // ---- workflow_event_log + sync_events + mutation_outbox ----
    if (/^\s*insert into workflow_event_log/i.test(sql)) {
      this.workflowEvents.push({
        company_id: params[0],
        workflow_name: params[1],
        schema_version: params[2],
        entity_type: params[3],
        entity_id: params[4],
        state_version: params[5],
        event_type: params[6],
        event_payload: params[7],
        snapshot_after: params[8],
        actor_user_id: params[9],
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into capture_sessions/i.test(sql)) {
      const [
        id,
        companyId,
        mode,
        routePath,
        deviceKind,
        platform,
        viewport,
        appBuildSha,
        consentVersion,
        actorRef,
        authority,
        consentScope,
        consentedAt,
        metadata,
        retentionExpiresAt,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
      ]
      const existing = this.captureSessions.find((s) => s.id === id)
      if (existing) {
        if (
          existing.company_id !== companyId ||
          existing.consent_actor_kind !== 'portal_guest' ||
          existing.consent_actor_ref !== actorRef
        ) {
          return { rows: [], rowCount: 0 }
        }
        existing.last_seen_at = new Date().toISOString()
        existing.route_path = routePath ?? existing.route_path
        existing.metadata = { ...(existing.metadata as Row), ...JSON.parse(metadata) }
        existing.consent_scope = { ...(existing.consent_scope as Row), ...JSON.parse(consentScope) }
        return { rows: [existing], rowCount: 1 }
      }
      const now = new Date().toISOString()
      const row = {
        id,
        company_id: companyId,
        actor_user_id: null,
        mode,
        status: 'open',
        route_path: routePath,
        device_kind: deviceKind,
        platform,
        viewport,
        app_build_sha: appBuildSha,
        consent_version: consentVersion,
        consent_actor_kind: 'portal_guest',
        consent_actor_ref: actorRef,
        consent_authority: authority,
        consent_scope: JSON.parse(consentScope),
        consented_at: consentedAt,
        redaction_version: 'capture-session-v1',
        metadata: JSON.parse(metadata),
        started_at: now,
        last_seen_at: now,
        stopped_at: null,
        discarded_at: null,
        retention_expires_at: retentionExpiresAt,
      }
      this.captureSessions.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (/select id, status(?:, consent_scope)?\s+from capture_sessions/i.test(sql)) {
      const [id, companyId, actorRef] = params as [string, string, string]
      const row = this.captureSessions.find(
        (s) => s.id === id && s.company_id === companyId && s.consent_actor_ref === actorRef,
      )
      return {
        rows: row ? [{ id: row.id, status: row.status, consent_scope: row.consent_scope }] : [],
        rowCount: row ? 1 : 0,
      }
    }
    if (/^\s*insert into capture_session_events/i.test(sql)) {
      const [
        companyId,
        captureSessionId,
        seq,
        clientEventId,
        eventType,
        eventClass,
        routePath,
        workflowId,
        entityType,
        entityId,
        requestId,
        payload,
        occurredAt,
      ] = params as [
        string,
        string,
        number,
        string | null,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
      ]
      const duplicate =
        clientEventId &&
        this.captureEvents.some(
          (e) =>
            e.company_id === companyId &&
            e.capture_session_id === captureSessionId &&
            e.client_event_id === clientEventId,
        )
      if (duplicate) return { rows: [], rowCount: 0 }
      const row = {
        id: `capture-event-${this.captureEvents.length + 1}`,
        company_id: companyId,
        capture_session_id: captureSessionId,
        seq,
        client_event_id: clientEventId,
        event_type: eventType,
        event_class: eventClass,
        route_path: routePath,
        workflow_id: workflowId,
        entity_type: entityType,
        entity_id: entityId,
        request_id: requestId,
        payload: JSON.parse(payload),
        occurred_at: occurredAt,
      }
      this.captureEvents.push(row)
      return { rows: [{ id: row.id }], rowCount: 1 }
    }
    if (/^\s*insert into capture_artifacts/i.test(sql)) {
      const row = {
        id: `capture-artifact-${this.captureArtifacts.length + 1}`,
        company_id: params[0],
        capture_session_id: params[1],
        kind: params[2],
        storage_key: params[3],
        uri: null,
        content_type: params[4],
        byte_size: params[5],
        content_hash: params[6],
        duration_ms: params[7],
        pii_level: params[8],
        access_policy: params[9],
        metadata: JSON.parse(params[10] as string),
        retention_expires_at: params[11],
        redaction_version: params[12],
        deleted_at: null,
      }
      this.captureArtifacts.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.startsWith('select * from capture_sessions')) {
      const [companyId, id, actorRef] = params as [string, string, string]
      const row = this.captureSessions.find(
        (s) => s.company_id === companyId && s.id === id && s.consent_actor_ref === actorRef,
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('select id::text, mode') && normalized.includes('from capture_sessions')) {
      const [companyId, id] = params as [string, string]
      const row = this.captureSessions.find((session) => session.company_id === companyId && session.id === id)
      return { rows: row ? [{ ...row, id: row.id }] : [], rowCount: row ? 1 : 0 }
    }
    if (/select id, status(?:, retention_expires_at)?(?:, consent_scope)?\s+from capture_sessions/i.test(sql)) {
      const [id, companyId, actorRef] = params as [string, string, string]
      const row = this.captureSessions.find(
        (s) => s.id === id && s.company_id === companyId && s.consent_actor_ref === actorRef,
      )
      return {
        rows: row
          ? [
              {
                id: row.id,
                status: row.status,
                retention_expires_at: row.retention_expires_at,
                consent_scope: row.consent_scope,
              },
            ]
          : [],
        rowCount: row ? 1 : 0,
      }
    }
    if (normalized.includes('from capture_session_events') && normalized.includes('count(*)::text')) {
      const [companyId, captureSessionId] = params as [string, string]
      const count = this.captureEvents.filter(
        (event) => event.company_id === companyId && event.capture_session_id === captureSessionId,
      ).length
      return { rows: [{ count: String(count) }], rowCount: 1 }
    }
    if (normalized.includes('from capture_session_events')) {
      const [companyId, captureSessionId] = params as [string, string]
      const rows = this.captureEvents.filter(
        (event) => event.company_id === companyId && event.capture_session_id === captureSessionId,
      )
      return { rows, rowCount: rows.length }
    }
    if (normalized.includes('from capture_artifacts') && normalized.includes('private_artifact_count')) {
      const [companyId, captureSessionId] = params as [string, string]
      const rows = this.captureArtifacts.filter(
        (artifact) =>
          artifact.company_id === companyId && artifact.capture_session_id === captureSessionId && !artifact.deleted_at,
      )
      return {
        rows: [
          {
            artifact_count: String(rows.length),
            private_artifact_count: String(
              rows.filter((artifact) => artifact.pii_level === 'private' || artifact.pii_level === 'restricted').length,
            ),
          },
        ],
        rowCount: 1,
      }
    }
    if (normalized.includes('select storage_key') && normalized.includes('from capture_artifacts')) {
      const [captureSessionId, companyId] = params as [string, string]
      const rows = this.captureArtifacts
        .filter(
          (artifact) =>
            artifact.company_id === companyId &&
            artifact.capture_session_id === captureSessionId &&
            !artifact.deleted_at &&
            artifact.storage_key,
        )
        .map((artifact) => ({ storage_key: artifact.storage_key }))
      return { rows, rowCount: rows.length }
    }
    if (normalized.includes('from capture_artifacts')) {
      const [companyId, captureSessionId] = params as [string, string]
      const rows = this.captureArtifacts
        .filter(
          (artifact) =>
            artifact.company_id === companyId &&
            artifact.capture_session_id === captureSessionId &&
            !artifact.deleted_at,
        )
        .map(({ storage_key: _storageKey, uri: _uri, ...row }) => row)
      return { rows, rowCount: rows.length }
    }
    if (/update capture_sessions\s+set last_seen_at = now\(\)/i.test(sql)) {
      const [id, companyId] = params as [string, string]
      const row = this.captureSessions.find((s) => s.id === id && s.company_id === companyId)
      if (row) row.last_seen_at = new Date().toISOString()
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith("update capture_sessions set status = 'discarded'")) {
      const [id, companyId, actorRef, metadataRaw] = params as [string, string, string, string]
      const row = this.captureSessions.find(
        (s) => s.id === id && s.company_id === companyId && s.consent_actor_ref === actorRef,
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'discarded'
      row.discarded_at = row.discarded_at ?? new Date().toISOString()
      row.last_seen_at = new Date().toISOString()
      row.metadata = { ...(row.metadata as Row), ...(JSON.parse(metadataRaw) as Row) }
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.startsWith('update capture_artifacts set deleted_at')) {
      const [captureSessionId, companyId] = params as [string, string]
      let count = 0
      for (const artifact of this.captureArtifacts) {
        if (
          artifact.capture_session_id === captureSessionId &&
          artifact.company_id === companyId &&
          !artifact.deleted_at
        ) {
          artifact.deleted_at = new Date().toISOString()
          count++
        }
      }
      return { rows: [], rowCount: count }
    }
    if (normalized.startsWith('update capture_sessions set status = case')) {
      const [id, companyId, metadataRaw, actorRef] = params as [string, string, string, string]
      const row = this.captureSessions.find(
        (s) => s.id === id && s.company_id === companyId && s.consent_actor_ref === actorRef,
      )
      if (!row) return { rows: [], rowCount: 0 }
      if (row.status === 'open') {
        row.status = 'stopped'
        row.stopped_at = new Date().toISOString()
      }
      row.last_seen_at = new Date().toISOString()
      row.metadata = { ...(row.metadata as Row), ...(JSON.parse(metadataRaw) as Row) }
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('select id::text as id, slug, name') && normalized.includes('from companies')) {
      const [companyId] = params as [string]
      const row = this.companies.find((company) => company.id === companyId)
      return {
        rows: row
          ? [
              {
                id: row.id,
                slug: row.slug ?? 'co',
                name: row.name,
                created_at: row.created_at ?? '2026-05-31T12:00:00.000Z',
              },
            ]
          : [],
        rowCount: row ? 1 : 0,
      }
    }
    if (normalized.includes('from audit_events')) {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.includes('from mutation_outbox') && normalized.includes('count(*)::text')) {
      return { rows: [{ count: '0' }], rowCount: 1 }
    }
    if (normalized.includes('from sync_events') && normalized.includes('count(*)::text')) {
      return { rows: [{ count: '0' }], rowCount: 1 }
    }
    if (normalized.startsWith('insert into support_debug_packets')) {
      const row = {
        id: `support-${this.supportPackets.length + 1}`,
        company_id: params[0],
        actor_user_id: params[1],
        request_id: params[2],
        route: params[3],
        capture_session_id: params[4],
        build_sha: params[5],
        problem: params[6],
        client: JSON.parse(params[7] as string),
        server_context: JSON.parse(params[8] as string),
        expires_at: params[9],
        redaction_version: params[10],
        created_at: new Date().toISOString(),
      }
      this.supportPackets.push(row)
      return { rows: [{ id: row.id, created_at: row.created_at, expires_at: row.expires_at }], rowCount: 1 }
    }
    if (normalized.startsWith('insert into context_work_items')) {
      // params[2] = domain ($3) — added by migration 009; indices below shift +1.
      const row = {
        id: `work-item-${this.workItems.length + 1}`,
        company_id: params[0],
        support_packet_id: params[1],
        domain: params[2],
        title: params[3],
        summary: params[4],
        status: params[5],
        lane: params[6],
        severity: params[7],
        route: params[8],
        capture_session_id: params[9],
        entity_type: params[10],
        entity_id: params[11],
        assignee_user_id: params[12],
        created_by_user_id: params[13],
        metadata: JSON.parse(params[14] as string),
        reversibility_window_seconds: params[15],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        resolved_at: null,
        reversed_at: null,
        expires_at: null,
      }
      this.workItems.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.startsWith('insert into context_handoff_events')) {
      const row = {
        id: `handoff-${this.handoffEvents.length + 1}`,
        company_id: params[0],
        work_item_id: params[1],
        event_type: params[2],
        actor_kind: params[3],
        actor_user_id: params[4],
        actor_ref: params[5],
        source_system: params[6],
        payload: JSON.parse(params[7] as string),
        metadata: JSON.parse(params[8] as string),
        idempotency_key: params[9],
        causation_event_id: params[10],
        correlation_id: params[11],
        request_id: params[12],
        capture_session_id: params[13],
        sentry_trace: params[14],
        sentry_baggage: params[15],
        build_sha: params[16],
        redaction_version: params[17],
        occurred_at: new Date().toISOString(),
        recorded_at: new Date().toISOString(),
      }
      this.handoffEvents.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (normalized.includes('from context_work_items w') && normalized.includes('left join support_debug_packets')) {
      const [companyId, workItemId] = params as [string, string]
      const item = this.workItems.find((workItem) => workItem.company_id === companyId && workItem.id === workItemId)
      if (!item) return { rows: [], rowCount: 0 }
      const packet = this.supportPackets.find(
        (supportPacket) => supportPacket.company_id === companyId && supportPacket.id === item.support_packet_id,
      )
      return {
        rows: [
          {
            ...item,
            support_packet: packet
              ? {
                  id: packet.id,
                  route: packet.route,
                  problem: packet.problem,
                  request_id: packet.request_id,
                  capture_session_id: packet.capture_session_id,
                  build_sha: packet.build_sha,
                  created_at: packet.created_at,
                  expires_at: packet.expires_at,
                  redaction_version: packet.redaction_version,
                }
              : null,
          },
        ],
        rowCount: 1,
      }
    }
    if (normalized.includes('from context_work_items') && normalized.includes("metadata ->> 'source'")) {
      const [companyId, captureSessionId] = params as [string, string]
      const row = this.workItems.find(
        (workItem) =>
          workItem.company_id === companyId &&
          workItem.capture_session_id === captureSessionId &&
          (workItem.metadata as Row).source === 'capture_session_finalize',
      )
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from context_handoff_events') && normalized.includes('count(*)::text')) {
      const [companyId, workItemId] = params as [string, string]
      const count = this.handoffEvents.filter(
        (event) => event.company_id === companyId && event.work_item_id === workItemId,
      ).length
      return { rows: [{ count: String(count) }], rowCount: 1 }
    }
    if (normalized.includes('from context_handoff_events')) {
      const [companyId, workItemId] = params as [string, string]
      const rows = this.handoffEvents.filter(
        (event) => event.company_id === companyId && event.work_item_id === workItemId,
      )
      return { rows, rowCount: rows.length }
    }
    // Project meta read used by the inline lifecycle helper to construct
    // the notify_foreman_assignment outbox payload.
    if (/select name, customer_name\s+from projects/i.test(sql)) {
      const [companyId, projectId] = params as [string, string]
      const project = this.projects.find((p) => p.company_id === companyId && p.id === projectId)
      if (!project) return { rows: [], rowCount: 0 }
      return { rows: [{ name: project.name, customer_name: 'Test Customer' }], rowCount: 1 }
    }

    // ---- company_memberships (operator notification recipients) ----
    if (/from company_memberships/i.test(sql)) {
      const [companyId] = params as [string]
      const roleMatch = sql.match(/role in \(([^)]+)\)/i)
      const roles = roleMatch ? roleMatch[1]!.split(',').map((r) => r.trim().replace(/^'|'$/g, '')) : ['admin']
      const rows = this.memberships
        .filter((m) => m.company_id === companyId && roles.includes(m.role))
        .map((m) => ({ clerk_user_id: m.clerk_user_id }))
      return { rows, rowCount: rows.length }
    }

    // ---- notifications (operator first-view fan-out) ----
    if (/^\s*insert into notifications/i.test(sql)) {
      const [companyId, recipientClerkUserId, recipientEmail, kind, subject, bodyText, , payload] = params as [
        string,
        string | null,
        string | null,
        string,
        string,
        string,
        string | null,
        string,
      ]
      this.notifications.push({
        company_id: companyId,
        recipient_clerk_user_id: recipientClerkUserId,
        recipient_email: recipientEmail,
        kind,
        subject,
        body_text: bodyText,
        payload: JSON.parse(payload),
      })
      return { rows: [{ id: `notif-${this.notifications.length}` }], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }

  private serializeShare(row: EstimateShareRow): Row {
    return {
      ...row,
      // The route SELECTs use `host(signer_ip) as signer_ip`; mirror.
      signer_ip: row.signer_ip,
    }
  }
}

function makeAuthCtx(pool: FakePool, overrides: Partial<Parameters<typeof handleEstimateShareRoutes>[2]> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  return {
    responses,
    reads,
    ctx: {
      pool: pool as unknown as Parameters<typeof handleEstimateShareRoutes>[2]['pool'],
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role: 'admin' as const },
      currentUserId: 'u-1',
      requireRole: () => true,
      readBody: async () => {
        const body = reads.shift() ?? {}
        return body as Record<string, unknown>
      },
      sendJson: (status: number, body: unknown) => {
        responses.push({ status, body })
      },
      shareSecret: 'test-secret',
      portalBaseUrl: 'https://app.example.com',
      ...overrides,
    },
  }
}

function makePublicCtx(pool: FakePool, overrides: Partial<Parameters<typeof handlePublicEstimateShareRoutes>[2]> = {}) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  return {
    responses,
    reads,
    ctx: {
      pool: pool as unknown as Parameters<typeof handlePublicEstimateShareRoutes>[2]['pool'],
      shareSecret: 'test-secret',
      resolveClientIp: () => '127.0.0.1',
      readBody: async () => {
        const body = reads.shift() ?? {}
        return body as Record<string, unknown>
      },
      sendJson: (status: number, body: unknown) => {
        responses.push({ status, body })
      },
      ...overrides,
    },
  }
}

class MemoryStorage implements BlueprintStorage {
  backend = 'local-fs' as const
  bucket = null
  files = new Map<string, Buffer>()

  async put(key: string, contents: Buffer) {
    this.files.set(key, contents)
  }

  async putStream(key: string, body: Readable, _options?: PutStreamOptions) {
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    this.files.set(key, Buffer.concat(chunks))
  }

  async get(key: string) {
    const file = this.files.get(key)
    if (!file) throw new Error(`missing ${key}`)
    return file
  }

  async copy(sourceKey: string, destKey: string) {
    this.files.set(destKey, await this.get(sourceKey))
  }

  async deleteObject(key: string) {
    this.files.delete(key)
  }

  async getDownloadUrl(_key: string, _options?: DownloadUrlOptions) {
    return null
  }
}

function multipart(
  parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; body?: Buffer }>,
) {
  const boundary = '----portal-estimate-capture-test'
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if (part.body) {
      chunks.push(
        Buffer.from(
          `content-disposition: form-data; name="${part.name}"; filename="${part.filename ?? 'file.bin'}"\r\ncontent-type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      )
      chunks.push(part.body)
      chunks.push(Buffer.from('\r\n'))
    } else {
      chunks.push(Buffer.from(`content-disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ''}\r\n`))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { boundary, body: Buffer.concat(chunks) }
}

function req(method: string, body?: Buffer, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from(body ? [body] : []), { method, headers })
}

function seedProject(pool: FakePool, overrides: Partial<Row> = {}) {
  pool.companies.push({ id: 'co-1', name: 'Acme Co' })
  pool.projects.push({
    id: 'p-1',
    company_id: 'co-1',
    name: 'Riverbend',
    bid_total: 5000,
    lifecycle_state: 'estimating',
    lifecycle_state_version: 2,
    estimate_lines: [
      {
        service_item_code: 'SVC-1',
        quantity: 100,
        unit: 'sqft',
        rate: 25,
        amount: 2500,
        division_code: null,
      },
      {
        service_item_code: 'SVC-2',
        quantity: 50,
        unit: 'lf',
        rate: 50,
        amount: 2500,
        division_code: null,
      },
    ],
    ...overrides,
  })
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleEstimateShareRoutes — POST /api/projects/:id/estimate/share', () => {
  it('creates a share row, returns share_url, and dispatches lifecycle SEND when project is estimating', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'client@example.com', recipient_name: 'Client Smith' })

    const handled = await handleEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/p-1/estimate/share'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as { share_token: string; share_url: string; id: string }
    expect(body.share_token).toMatch(/\./)
    expect(body.share_url).toContain(`${PORTAL_ESTIMATES_PATH_PREFIX}`)

    expect(pool.shares).toHaveLength(1)
    const project = pool.projects[0]!
    expect(project.lifecycle_state).toBe('sent')
    expect(project.lifecycle_state_version).toBe(3)

    // Two SEND events: the project_lifecycle SEND (estimating → sent) on the
    // project, AND the estimate_share SEND (the row-creation seed) on the share
    // link. Disambiguate by entity_type.
    const lifecycleSend = pool.workflowEvents.find((e) => e.event_type === 'SEND' && e.entity_type === 'project')
    expect(lifecycleSend).toBeDefined()
    expect(lifecycleSend?.entity_id).toBe('p-1')

    const shareSend = pool.workflowEvents.find(
      (e) => e.event_type === 'SEND' && e.entity_type === 'estimate_share_link',
    )
    expect(shareSend).toBeDefined()
    expect(shareSend?.workflow_name).toBe('estimate_share')
    expect(shareSend?.state_version).toBe(0)
  })

  it('persists message + include_signed_link and enqueues a send_estimate_share outbox row', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({
      recipient_email: 'client@example.com',
      message: 'John — bid attached. Happy to walk through.',
      include_signed_link: false,
    })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(201)

    const row = pool.shares[0]!
    expect(row.status).toBe('sent')
    expect(row.state_version).toBe(1)
    expect(row.message).toBe('John — bid attached. Happy to walk through.')
    expect(row.include_signed_link).toBe(false)

    // The registered side-effect type is enqueued to the outbox.
    expect(pool.outbox).toHaveLength(1)
    const outboxParams = (pool.outbox[0] as { params: unknown[] }).params
    // mutation_outbox insert params:
    // [companyId, deviceId, actorUserId, entityType, entityId, mutationType, payload, idempotencyKey, ...]
    expect(outboxParams[5]).toBe('send_estimate_share')
    expect(outboxParams[7]).toBe(`estimate_share:send:${row.id}`)
  })

  it('defaults include_signed_link to true when omitted', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'client@example.com' })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(201)
    expect(pool.shares[0]?.include_signed_link).toBe(true)
    expect(pool.shares[0]?.message).toBeNull()
  })

  it('rejects when recipient_email is missing or malformed', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({})
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('rejects expires_in_days outside (0, 365]', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'a@b.co', expires_in_days: 999 })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 404 when the project does not exist', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', name: 'Acme Co' })
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'a@b.co' })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/missing/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(404)
  })

  it('does not transition the lifecycle when the project is past estimating', async () => {
    const pool = new FakePool()
    seedProject(pool, { lifecycle_state: 'sent', lifecycle_state_version: 3 })
    const { ctx, responses, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'client@example.com' })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    expect(responses[0]?.status).toBe(201)
    const project = pool.projects[0]!
    expect(project.lifecycle_state).toBe('sent')
    // No lifecycle SEND written this run because the helper short-circuited
    // (the project was already past 'estimating'). The estimate_share SEND
    // (the row-creation seed) is still recorded — it is unconditional.
    expect(pool.workflowEvents.find((e) => e.event_type === 'SEND' && e.entity_type === 'project')).toBeUndefined()
    expect(
      pool.workflowEvents.find((e) => e.event_type === 'SEND' && e.entity_type === 'estimate_share_link'),
    ).toBeDefined()
  })
})

describe('handleEstimateShareRoutes — GET /api/estimate-shares (company-wide timeline)', () => {
  it('returns an empty list when no shares exist', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses } = makeAuthCtx(pool)
    await handleEstimateShareRoutes({ method: 'GET' } as never, buildUrl('/api/estimate-shares'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({ shares: [] })
  })

  it('returns one row per project (latest share) with project + customer + bid_total + status', async () => {
    const pool = new FakePool()
    seedProject(pool, { id: 'p-1', name: 'Riverbend', customer_name: 'Smith Co' })
    seedProject(pool, { id: 'p-2', name: 'Oakridge', customer_name: 'Jones LLC', bid_total: 9000 })

    // Two shares on p-1 (latest wins), one share on p-2.
    const createOnProject = async (projectId: string, email: string) => {
      const { ctx, reads } = makeAuthCtx(pool)
      reads.push({ recipient_email: email })
      await handleEstimateShareRoutes(
        { method: 'POST' } as never,
        buildUrl(`/api/projects/${projectId}/estimate/share`),
        ctx,
      )
    }
    await createOnProject('p-1', 'old@example.com')
    await createOnProject('p-1', 'new@example.com')
    await createOnProject('p-2', 'oak@example.com')

    // Force a deterministic ordering — the SUTs sort by sent_at desc,
    // but the in-memory pool's `now()` resolution can collapse the two
    // p-1 shares into the same millisecond. Re-stamp them so the "new"
    // share has a strictly later sent_at than the "old" one.
    const p1All = pool.shares.filter((s) => s.project_id === 'p-1')
    const newer = p1All.find((s) => s.recipient_email === 'new@example.com')!
    const older = p1All.find((s) => s.recipient_email === 'old@example.com')!
    older.sent_at = new Date(Date.now() - 60_000).toISOString()
    newer.sent_at = new Date().toISOString()

    // Hand-roll the latest share on p-1 to have a viewed_at so we can
    // verify the timeline status surfaces 'viewed' (vs. 'sent').
    newer.viewed_at = new Date().toISOString()

    const { ctx, responses } = makeAuthCtx(pool)
    await handleEstimateShareRoutes({ method: 'GET' } as never, buildUrl('/api/estimate-shares'), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as {
      shares: Array<{
        project_id: string
        project_name: string
        customer_name: string
        bid_total: number
        recipient_email: string
        status: string
      }>
    }
    expect(body.shares).toHaveLength(2)
    const byProject = Object.fromEntries(body.shares.map((s) => [s.project_id, s]))
    expect(byProject.p1 ?? byProject['p-1']).toBeDefined()
    expect(byProject['p-1']?.recipient_email).toBe('new@example.com')
    expect(byProject['p-1']?.status).toBe('viewed')
    expect(byProject['p-1']?.project_name).toBe('Riverbend')
    expect(byProject['p-1']?.customer_name).toBe('Smith Co')
    expect(byProject['p-2']?.bid_total).toBe(9000)
    expect(byProject['p-2']?.status).toBe('sent')
  })

  it('surfaces accepted/declined/expired statuses correctly', async () => {
    const pool = new FakePool()
    seedProject(pool, { id: 'p-a', name: 'Alpha', customer_name: 'A' })
    seedProject(pool, { id: 'p-d', name: 'Delta', customer_name: 'D' })
    seedProject(pool, { id: 'p-x', name: 'Xpired', customer_name: 'X' })

    const create = async (projectId: string) => {
      const { ctx, reads } = makeAuthCtx(pool)
      reads.push({ recipient_email: 'c@example.com' })
      await handleEstimateShareRoutes(
        { method: 'POST' } as never,
        buildUrl(`/api/projects/${projectId}/estimate/share`),
        ctx,
      )
    }
    await create('p-a')
    await create('p-d')
    await create('p-x')

    pool.shares.find((s) => s.project_id === 'p-a')!.accepted_at = new Date().toISOString()
    pool.shares.find((s) => s.project_id === 'p-d')!.declined_at = new Date().toISOString()
    pool.shares.find((s) => s.project_id === 'p-x')!.expires_at = new Date(Date.now() - 1000).toISOString()

    const { ctx, responses } = makeAuthCtx(pool)
    await handleEstimateShareRoutes({ method: 'GET' } as never, buildUrl('/api/estimate-shares'), ctx)
    const body = responses[0]?.body as { shares: Array<{ project_id: string; status: string }> }
    const byProject = Object.fromEntries(body.shares.map((s) => [s.project_id, s.status]))
    expect(byProject['p-a']).toBe('accepted')
    expect(byProject['p-d']).toBe('declined')
    expect(byProject['p-x']).toBe('expired')
  })

  it('rejects callers without admin/office role', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx, responses } = makeAuthCtx(pool, { requireRole: () => false })
    await handleEstimateShareRoutes({ method: 'GET' } as never, buildUrl('/api/estimate-shares'), ctx)
    // requireRole returning false is the route's signal to abort — it's
    // the dispatcher's job to have already written a 403 in that case,
    // so we just assert the handler did not write a 200 success.
    const ok = responses.find((r) => r.status === 200)
    expect(ok).toBeUndefined()
  })
})

describe('handleEstimateShareRoutes — POST /api/estimate-shares/:id/revoke', () => {
  it('sets expires_at to now and returns the share', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx: createCtx, reads: createReads } = makeAuthCtx(pool)
    createReads.push({ recipient_email: 'a@b.co' })
    await handleEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/p-1/estimate/share'),
      createCtx,
    )
    const share = pool.shares[0]!
    const before = new Date(share.expires_at).getTime()

    const { ctx, responses } = makeAuthCtx(pool)
    await handleEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/estimate-shares/${share.id}/revoke`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    const after = new Date(pool.shares[0]!.expires_at).getTime()
    expect(after).toBeLessThanOrEqual(Date.now() + 5)
    expect(after).toBeLessThan(before)

    // Dispatched through the reducer: status + state_version advance and a
    // REVOKE workflow event is recorded on the share link.
    expect(pool.shares[0]?.status).toBe('revoked')
    expect(pool.shares[0]?.state_version).toBe(2)
    expect(pool.shares[0]?.revoked_at).not.toBeNull()
    const revokeEvent = pool.workflowEvents.find(
      (e) => e.event_type === 'REVOKE' && e.entity_type === 'estimate_share_link',
    )
    expect(revokeEvent).toBeDefined()
    expect(revokeEvent?.workflow_name).toBe('estimate_share')
    expect(revokeEvent?.state_version).toBe(1)
  })

  it('returns 409 when revoking an already-terminal (accepted) share', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { ctx: createCtx, reads: createReads } = makeAuthCtx(pool)
    createReads.push({ recipient_email: 'a@b.co' })
    await handleEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/projects/p-1/estimate/share'),
      createCtx,
    )
    const share = pool.shares[0]!
    // Simulate a prior accept: terminal state the reducer must refuse REVOKE from.
    share.status = 'accepted'
    share.accepted_at = new Date().toISOString()

    const { ctx, responses } = makeAuthCtx(pool)
    await handleEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/estimate-shares/${share.id}/revoke`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
  })
})

describe('handlePublicEstimateShareRoutes — portal flows', () => {
  async function seedShare(pool: FakePool): Promise<{ token: string; id: string }> {
    seedProject(pool)
    const { ctx, reads } = makeAuthCtx(pool)
    reads.push({ recipient_email: 'client@example.com', recipient_name: 'Client' })
    await handleEstimateShareRoutes({ method: 'POST' } as never, buildUrl('/api/projects/p-1/estimate/share'), ctx)
    const row = pool.shares[0]!
    return { token: row.share_token, id: row.id }
  }

  it('GET /api/portal/estimates/:token returns the snapshot + bumps view_count on first view', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as { status: string; estimate: { lines: unknown[] }; project_name: string }
    expect(body.status).toBe('pending')
    expect(body.estimate.lines).toHaveLength(2)
    expect(body.project_name).toBe('Riverbend')
    expect(pool.shares[0]?.view_count).toBe(1)
    expect(pool.shares[0]?.viewed_at).not.toBeNull()
  })

  it('GET first view enqueues an estimate_share_viewed notification for each admin/office member', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.memberships.push(
      { company_id: 'co-1', clerk_user_id: 'user_admin', role: 'admin' },
      { company_id: 'co-1', clerk_user_id: 'user_office', role: 'office' },
      // Foremen should NOT receive this sales-loop notification — they
      // own the field loop, not the funnel.
      { company_id: 'co-1', clerk_user_id: 'user_foreman', role: 'foreman' },
    )
    // Stamp a customer_name on the project so the body uses the project's
    // customer when the share row doesn't carry a recipient_name.
    pool.projects[0]!.customer_name = 'Smith Co'
    // Clear the seeded share's recipient_name so the body falls back to
    // customer_name (exercises the precedence chain).
    pool.shares[0]!.recipient_name = null

    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(200)

    expect(pool.notifications).toHaveLength(2)
    const adminRow = pool.notifications.find((n) => n.recipient_clerk_user_id === 'user_admin')
    const officeRow = pool.notifications.find((n) => n.recipient_clerk_user_id === 'user_office')
    expect(adminRow).toBeDefined()
    expect(officeRow).toBeDefined()
    expect(pool.notifications.find((n) => n.recipient_clerk_user_id === 'user_foreman')).toBeUndefined()

    expect(adminRow?.kind).toBe('estimate_share_viewed')
    expect(adminRow?.subject).toBe('Customer viewed estimate')
    expect(adminRow?.body_text).toBe('Smith Co opened the estimate for Riverbend')
    expect(adminRow?.payload).toMatchObject({
      project_id: 'p-1',
      project_name: 'Riverbend',
      customer_name: 'Smith Co',
      link_target: '/projects/p-1?tab=estimate',
    })
  })

  it('GET second view does NOT re-enqueue the notification', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'user_admin', role: 'admin' })

    // First hit — emits.
    const first = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/portal/estimates/${token}`),
      first.ctx,
    )
    expect(pool.notifications).toHaveLength(1)
    expect(pool.shares[0]?.view_count).toBe(1)

    // Second hit — viewed_at is already set, so prev_viewed_at is non-null
    // and the fan-out is skipped. view_count keeps incrementing so the
    // operator timeline still reflects engagement.
    const second = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/portal/estimates/${token}`),
      second.ctx,
    )
    expect(second.responses[0]?.status).toBe(200)
    expect(pool.notifications).toHaveLength(1)
    expect(pool.shares[0]?.view_count).toBe(2)
  })

  it('GET first view enqueues a single broadcast row when no admin/office members exist', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    // No memberships seeded — the company has nobody to ping yet.

    const { ctx } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)

    expect(pool.notifications).toHaveLength(1)
    expect(pool.notifications[0]?.recipient_clerk_user_id).toBeNull()
    expect(pool.notifications[0]?.kind).toBe('estimate_share_viewed')
  })

  it('GET returns 401 for an invalid (HMAC mismatch) token', async () => {
    const pool = new FakePool()
    await seedShare(pool)
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/abc.def`), ctx)
    expect(responses[0]?.status).toBe(401)
  })

  it('GET returns 410 for an expired share', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.shares[0]!.expires_at = new Date(Date.now() - 1000).toISOString()
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(410)
  })

  // ── Portal-link revocation gate (migration 011) ──────────────────────────
  it('GET returns 410 for a REVOKED share (revoked_at set) and does NOT expose the estimate', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    // Revoke but keep it un-expired in the future — the revoke gate must fire
    // BEFORE the expiry gate so a still-fresh-but-revoked link is dead.
    pool.shares[0]!.revoked_at = new Date().toISOString()
    pool.shares[0]!.expires_at = new Date(Date.now() + 86_400_000).toISOString()
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(410)
    expect((responses[0]?.body as { error: string }).error).toMatch(/revoked/)
    // No data leaked and no view bump on a revoked link.
    expect(pool.shares[0]?.view_count).toBe(0)
  })

  it('GET returns 410 when the workflow status is revoked even if revoked_at is null', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.shares[0]!.status = 'revoked'
    pool.shares[0]!.revoked_at = null
    pool.shares[0]!.expires_at = new Date(Date.now() + 86_400_000).toISOString()
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(410)
    expect((responses[0]?.body as { error: string }).error).toMatch(/revoked/)
  })

  it('POST /accept returns 410 for a revoked share (cannot sign a killed link)', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.shares[0]!.revoked_at = new Date().toISOString()
    pool.shares[0]!.expires_at = new Date(Date.now() + 86_400_000).toISOString()
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ signer_name: 'Client', signature_data_url: 'data:image/png;base64,AAAA' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      ctx,
    )
    expect(responses[0]?.status).toBe(410)
    expect(pool.shares[0]?.accepted_at).toBeNull()
  })

  it('POST /decline returns 410 for a revoked share', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.shares[0]!.revoked_at = new Date().toISOString()
    pool.shares[0]!.expires_at = new Date(Date.now() + 86_400_000).toISOString()
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ decline_reason: 'changed my mind' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/decline`),
      ctx,
    )
    expect(responses[0]?.status).toBe(410)
    expect(pool.shares[0]?.declined_at).toBeNull()
  })

  // ── Access audit (migration 011) ─────────────────────────────────────────
  it('GET bumps access_count + stamps last_accessed_at on every hit (not just first view)', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)

    const first = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/portal/estimates/${token}`),
      first.ctx,
    )
    expect(first.responses[0]?.status).toBe(200)
    expect(pool.shares[0]?.access_count).toBe(1)
    expect(pool.shares[0]?.last_accessed_at).not.toBeNull()

    const second = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes(
      { method: 'GET' } as never,
      buildUrl(`/api/portal/estimates/${token}`),
      second.ctx,
    )
    // access_count keeps climbing on repeat hits — the leaked-link signal.
    expect(pool.shares[0]?.access_count).toBe(2)
  })

  it('POST /accept bumps the access audit in the same tx as the signature', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ signer_name: 'Client', signature_data_url: 'data:image/png;base64,AAAA' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.shares[0]?.accepted_at).not.toBeNull()
    expect(pool.shares[0]?.access_count).toBe(1)
    expect(pool.shares[0]?.last_accessed_at).not.toBeNull()
  })

  it('POST /capture-sessions starts a token-bound portal_guest capture session', async () => {
    const pool = new FakePool()
    const { token, id: shareId } = await seedShare(pool)
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/estimates/share-token',
      metadata: { trigger: 'record_feedback' },
    })

    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions`),
      ctx,
    )

    expect(responses[0]?.status).toBe(200)
    expect(pool.captureSessions).toHaveLength(1)
    expect(pool.captureSessions[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000123',
      company_id: 'co-1',
      actor_user_id: null,
      mode: 'feedback',
      consent_actor_kind: 'portal_guest',
      consent_actor_ref: shareId,
      consent_authority: 'signed_estimate_share_token',
      metadata: {
        trigger: 'record_feedback',
        portal_surface: 'estimate_portal',
        estimate_share_link_id: shareId,
        project_id: 'p-1',
      },
    })
  })

  it('POST /capture-sessions/:id/events appends low-friction portal events for that share link only', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const start = makePublicCtx(pool)
    start.reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'trace',
      route_path: '/portal/estimates/share-token',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions`),
      start.ctx,
    )

    const events = makePublicCtx(pool)
    events.reads.push({
      events: [
        {
          client_event_id: 'portal-1',
          seq: 0,
          event_type: 'portal.view',
          event_class: 'navigation',
          route_path: '/portal/estimates/share-token?secret=query',
          payload: { state: 'loaded' },
        },
      ],
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/events`),
      events.ctx,
    )

    expect(events.responses[0]?.status).toBe(202)
    expect(events.responses[0]?.body).toEqual({ accepted: 1 })
    expect(pool.captureEvents).toHaveLength(1)
    expect(pool.captureEvents[0]).toMatchObject({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      event_type: 'portal.view',
      event_class: 'navigation',
      payload: { state: 'loaded' },
    })
  })

  it('POST /capture-sessions/:id/artifacts/upload stores estimate portal artifacts with inherited retention', async () => {
    const pool = new FakePool()
    const { token, id: shareId } = await seedShare(pool)
    const start = makePublicCtx(pool)
    start.reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/estimates/share-token',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions`),
      start.ctx,
    )

    const storage = new MemoryStorage()
    const upload = makePublicCtx(pool, { storage, maxArtifactBytes: 1024 * 1024 })
    const payload = Buffer.from('customer said the estimate total was wrong')
    const { boundary, body } = multipart([
      { name: 'kind', value: 'audio' },
      { name: 'duration_ms', value: '1800' },
      { name: 'metadata', value: JSON.stringify({ source: 'portal_mic' }) },
      { name: 'file', filename: 'feedback.webm', contentType: 'audio/webm', body: payload },
    ])
    await handlePublicEstimateShareRoutes(
      req('POST', body, { 'content-type': `multipart/form-data; boundary=${boundary}` }) as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload`),
      upload.ctx,
    )

    expect(upload.responses[0]).toMatchObject({
      status: 201,
      body: { artifact: { kind: 'audio', content_type: 'audio/webm', byte_size: payload.length } },
    })
    expect(pool.captureArtifacts[0]).toMatchObject({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      kind: 'audio',
      content_type: 'audio/webm',
      duration_ms: 1800,
      pii_level: 'private',
      retention_expires_at: pool.captureSessions[0]?.retention_expires_at,
      metadata: {
        source: 'portal_mic',
        upload_source: 'portal_capture_artifact_upload',
        portal_surface: 'estimate_portal',
        estimate_share_link_id: shareId,
        project_id: 'p-1',
      },
    })
    const storageKey = String(pool.captureArtifacts[0]?.storage_key ?? '')
    expect(storageKey).toMatch(
      /^co-1\/capture-sessions\/00000000-0000-4000-8000-000000000123\/[0-9a-f-]+-feedback\.webm$/,
    )
    await expect(storage.get(storageKey)).resolves.toEqual(payload)
  })

  it('POST /capture-sessions/:id/finalize creates one estimate portal triage work item', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const start = makePublicCtx(pool)
    start.reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/estimates/share-token',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions`),
      start.ctx,
    )

    const events = makePublicCtx(pool)
    events.reads.push({
      events: [{ client_event_id: 'estimate-1', event_type: 'portal.estimate.total_unclear' }],
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/events`),
      events.ctx,
    )

    const finalize = makePublicCtx(pool, { tier: 'test', buildSha: 'build-test' })
    finalize.reads.push({
      title: 'Estimate total was confusing',
      summary: 'The portal user could not tell why the estimate total changed.',
      severity: 'normal',
      lane: 'triage',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/finalize`),
      finalize.ctx,
    )

    expect(finalize.responses[0]).toMatchObject({
      status: 201,
      body: {
        work_item: {
          title: 'Estimate total was confusing',
          lane: 'triage',
          severity: 'normal',
          capture_session_id: '00000000-0000-4000-8000-000000000123',
        },
        support_packet: { id: 'support-1' },
        event: {
          event_type: 'work_item.created',
          actor_kind: 'external',
          capture_session_id: '00000000-0000-4000-8000-000000000123',
        },
      },
    })
    expect(pool.supportPackets[0]).toMatchObject({
      actor_user_id: 'portal_guest:signed_estimate_share_token:share-1',
      capture_session_id: '00000000-0000-4000-8000-000000000123',
    })
    expect(pool.workItems[0]).toMatchObject({
      created_by_user_id: 'portal_guest:signed_estimate_share_token:share-1',
      metadata: {
        source: 'capture_session_finalize',
        portal_surface: 'estimate_portal',
        event_count: 1,
      },
    })
    expect(pool.captureSessions[0]).toMatchObject({
      status: 'stopped',
      metadata: {
        finalized_by: 'portal_guest',
        finalized_support_packet_id: 'support-1',
        finalized_work_item_id: 'work-item-1',
      },
    })
  })

  it('POST /capture-sessions/:id/discard tombstones estimate portal artifacts before finalization', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const start = makePublicCtx(pool)
    start.reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/estimates/share-token',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions`),
      start.ctx,
    )

    const storage = new MemoryStorage()
    const upload = makePublicCtx(pool, { storage, maxArtifactBytes: 1024 * 1024 })
    const payload = Buffer.from('discard this estimate audio')
    const { boundary, body } = multipart([
      { name: 'kind', value: 'audio' },
      { name: 'file', filename: 'feedback.webm', contentType: 'audio/webm', body: payload },
    ])
    await handlePublicEstimateShareRoutes(
      req('POST', body, { 'content-type': `multipart/form-data; boundary=${boundary}` }) as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload`),
      upload.ctx,
    )
    const key = String(pool.captureArtifacts[0]?.storage_key ?? '')
    await expect(storage.get(key)).resolves.toEqual(payload)

    const discard = makePublicCtx(pool, { storage })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/discard`),
      discard.ctx,
    )

    expect(discard.responses[0]).toMatchObject({
      status: 200,
      body: {
        capture_session: { status: 'discarded' },
        deleted_artifact_objects: 1,
        artifact_object_delete_errors: 0,
      },
    })
    expect(pool.captureSessions[0]).toMatchObject({
      status: 'discarded',
      metadata: {
        discarded_by: 'portal_guest',
        portal_surface: 'estimate_portal',
      },
    })
    expect(pool.captureArtifacts[0]?.deleted_at).toBeTruthy()
    await expect(storage.get(key)).rejects.toThrow(`missing ${key}`)
  })

  it('POST /accept marks accepted_at and dispatches lifecycle ACCEPT (sent → accepted)', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    // Sanity: SEND already moved the project to 'sent' during share create.
    expect(pool.projects[0]?.lifecycle_state).toBe('sent')

    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({
      signer_name: 'Client Smith',
      signature_data_url: 'data:image/png;base64,iVBORw0KGgo=',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.shares[0]?.accepted_at).not.toBeNull()
    expect(pool.shares[0]?.signer_name).toBe('Client Smith')
    expect(pool.projects[0]?.lifecycle_state).toBe('accepted')
    const accept = pool.workflowEvents.find((e) => e.event_type === 'ACCEPT')
    expect(accept).toBeDefined()
  })

  it('POST /accept is idempotent — a second accept returns the existing accepted_at', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const first = makePublicCtx(pool)
    first.reads.push({
      signer_name: 'Client Smith',
      signature_data_url: 'data:image/png;base64,iVBORw0KGgo=',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      first.ctx,
    )
    const acceptedAt = pool.shares[0]!.accepted_at

    const second = makePublicCtx(pool)
    second.reads.push({
      signer_name: 'Client Smith',
      signature_data_url: 'data:image/png;base64,iVBORw0KGgo=',
    })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      second.ctx,
    )
    expect(second.responses[0]?.status).toBe(200)
    const body = second.responses[0]?.body as { idempotent: boolean; accepted_at: string }
    expect(body.idempotent).toBe(true)
    expect(body.accepted_at).toBe(acceptedAt)
  })

  it('POST /accept rejects a malformed signature data URL', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ signer_name: 'X', signature_data_url: 'not-a-data-url' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/accept`),
      ctx,
    )
    expect(responses[0]?.status).toBe(400)
  })

  it('POST /decline marks declined_at and dispatches lifecycle DECLINE', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ decline_reason: 'too expensive' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/decline`),
      ctx,
    )
    expect(responses[0]?.status).toBe(200)
    expect(pool.shares[0]?.declined_at).not.toBeNull()
    expect(pool.shares[0]?.decline_reason).toBe('too expensive')
    expect(pool.projects[0]?.lifecycle_state).toBe('declined')
  })

  it('POST /decline returns 409 when the share has already been accepted', async () => {
    const pool = new FakePool()
    const { token } = await seedShare(pool)
    pool.shares[0]!.accepted_at = new Date().toISOString()
    const { ctx, responses, reads } = makePublicCtx(pool)
    reads.push({ decline_reason: 'wait, no' })
    await handlePublicEstimateShareRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/estimates/${token}/decline`),
      ctx,
    )
    expect(responses[0]?.status).toBe(409)
  })

  it('returns false for non-portal paths so the public dispatcher keeps walking', async () => {
    const pool = new FakePool()
    const { ctx } = makePublicCtx(pool)
    const handled = await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl('/api/health'), ctx)
    expect(handled).toBe(false)
  })

  it('refuses an unforgeable token: a freshly-generated token under a different secret is 401', async () => {
    const pool = new FakePool()
    seedProject(pool)
    const { token } = generateShareToken('a-different-secret')
    const { ctx, responses } = makePublicCtx(pool)
    await handlePublicEstimateShareRoutes({ method: 'GET' } as never, buildUrl(`/api/portal/estimates/${token}`), ctx)
    expect(responses[0]?.status).toBe(401)
  })
})
