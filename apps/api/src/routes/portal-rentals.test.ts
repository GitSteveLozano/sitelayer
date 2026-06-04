import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { generateShareToken } from '../estimate-share-token.js'
import type { BlueprintStorage, DownloadUrlOptions, PutStreamOptions } from '../storage.js'
import { handlePortalRentalRoutes } from './portal-rentals.js'

type Row = Record<string, unknown>

const ORIGINAL_ESTIMATE_SHARE_SECRET = process.env.ESTIMATE_SHARE_SECRET

class FakePool {
  rentalLinks: Row[] = []
  companies: Row[] = []
  captureSessions: Row[] = []
  captureEvents: Row[] = []
  captureArtifacts: Row[] = []
  supportPackets: Row[] = []
  workItems: Row[] = []
  handoffEvents: Row[] = []

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
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    const normalized = sqlRaw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (
      normalized.startsWith('begin') ||
      normalized.startsWith('commit') ||
      normalized.startsWith('rollback') ||
      normalized.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (/from rental_share_links where share_token = \$1/i.test(sql)) {
      const [token] = params as [string]
      const row = this.rentalLinks.find((link) => link.share_token === token)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('select id::text as id, slug, name') && normalized.includes('from companies')) {
      const [companyId] = params as [string]
      const row = this.companies.find((company) => company.id === companyId)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
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

    if (normalized.startsWith('select * from capture_sessions')) {
      const [companyId, id, actorRef] = params as [string, string, string]
      const row = this.captureSessions.find(
        (session) =>
          session.company_id === companyId &&
          session.id === id &&
          session.consent_actor_kind === 'portal_guest' &&
          session.consent_actor_ref === actorRef,
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
        (session) => session.id === id && session.company_id === companyId && session.consent_actor_ref === actorRef,
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

    if (/^\s*insert into capture_session_events/i.test(sql)) {
      const [
        companyId,
        captureSessionId,
        seq,
        clientEventId,
        eventType,
        eventClass,
        routePath,
        ,
        ,
        ,
        requestId,
        payload,
      ] = params as [
        string,
        string,
        number,
        string | null,
        string,
        string,
        string | null,
        unknown,
        unknown,
        unknown,
        string | null,
        string,
      ]
      const row = {
        id: `capture-event-${this.captureEvents.length + 1}`,
        company_id: companyId,
        capture_session_id: captureSessionId,
        seq,
        client_event_id: clientEventId,
        event_type: eventType,
        event_class: eventClass,
        route_path: routePath,
        request_id: requestId,
        payload: JSON.parse(payload),
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
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    if (normalized.includes('from capture_artifacts') && normalized.includes('private_artifact_count')) {
      const [companyId, captureSessionId] = params as [string, string]
      const rows = this.captureArtifacts.filter(
        (artifact) => artifact.company_id === companyId && artifact.capture_session_id === captureSessionId,
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
        .filter((artifact) => artifact.company_id === companyId && artifact.capture_session_id === captureSessionId)
        .map(({ storage_key: _storageKey, uri: _uri, ...row }) => row)
      return { rows, rowCount: rows.length }
    }

    if (/update capture_sessions\s+set last_seen_at = now\(\)/i.test(sql)) {
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith("update capture_sessions set status = 'discarded'")) {
      const [id, companyId, actorRef, metadataRaw] = params as [string, string, string, string]
      const row = this.captureSessions.find(
        (session) => session.id === id && session.company_id === companyId && session.consent_actor_ref === actorRef,
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
        (session) => session.id === id && session.company_id === companyId && session.consent_actor_ref === actorRef,
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
      const row = {
        id: `work-item-${this.workItems.length + 1}`,
        company_id: params[0],
        support_packet_id: params[1],
        title: params[2],
        summary: params[3],
        status: params[4],
        lane: params[5],
        severity: params[6],
        route: params[7],
        capture_session_id: params[8],
        entity_type: params[9],
        entity_id: params[10],
        assignee_user_id: params[11],
        created_by_user_id: params[12],
        metadata: JSON.parse(params[13] as string),
        reversibility_window_seconds: params[14],
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

    throw new Error(`unexpected SQL in rental fake pool: ${sql.slice(0, 200)}`)
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

function makeCtx(pool: FakePool, storage = new MemoryStorage()) {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const reads: Record<string, unknown>[] = []
  return {
    responses,
    reads,
    ctx: {
      pool: pool as unknown as Pool,
      sendJson: (status: number, body: unknown) => {
        responses.push({ status, body })
      },
      readBody: async () => {
        return reads.shift() ?? {}
      },
      storage,
      maxArtifactBytes: 1024 * 1024,
      tier: 'test',
      buildSha: 'build-test',
    },
    storage,
  }
}

function multipart(
  parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; body?: Buffer }>,
) {
  const boundary = '----portal-rental-capture-test'
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

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handlePortalRentalRoutes — capture sessions', () => {
  beforeEach(() => {
    process.env.ESTIMATE_SHARE_SECRET = 'test-secret'
  })

  afterEach(() => {
    if (ORIGINAL_ESTIMATE_SHARE_SECRET === undefined) delete process.env.ESTIMATE_SHARE_SECRET
    else process.env.ESTIMATE_SHARE_SECRET = ORIGINAL_ESTIMATE_SHARE_SECRET
  })

  function seedLink(pool: FakePool): string {
    const { token } = generateShareToken('test-secret')
    pool.companies.push({
      id: 'co-1',
      slug: 'co',
      name: 'Co',
      created_at: '2026-05-31T12:00:00.000Z',
    })
    pool.rentalLinks.push({
      id: 'rental-share-1',
      company_id: 'co-1',
      customer_id: 'cust-1',
      share_token: token,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    return token
  }

  it('starts and appends events to a signed rental portal capture session', async () => {
    const pool = new FakePool()
    const token = seedLink(pool)
    const start = makeCtx(pool)
    start.reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'trace',
      route_path: '/portal/rentals/share-token',
    })

    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions`),
      start.ctx,
    )

    expect(start.responses[0]?.status).toBe(200)
    expect(pool.captureSessions[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000123',
      company_id: 'co-1',
      consent_actor_kind: 'portal_guest',
      consent_actor_ref: 'rental-share-1',
      consent_authority: 'signed_rental_share_token',
      metadata: {
        portal_surface: 'rental_portal',
        rental_share_link_id: 'rental-share-1',
        customer_id: 'cust-1',
      },
    })

    const events = makeCtx(pool)
    events.reads.push({
      events: [{ client_event_id: 'rent-1', event_type: 'portal.cart.added', payload: { item_id: 'item-1' } }],
    })
    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/events`),
      events.ctx,
    )

    expect(events.responses[0]?.status).toBe(202)
    expect(pool.captureEvents[0]).toMatchObject({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      event_type: 'portal.cart.added',
      payload: { item_id: 'item-1' },
    })
  })

  it('uploads artifacts to a signed rental portal capture session with inherited retention', async () => {
    const pool = new FakePool()
    const token = seedLink(pool)
    const start = makeCtx(pool)
    start.reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/rentals/share-token',
    })
    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions`),
      start.ctx,
    )

    const upload = makeCtx(pool)
    const payload = Buffer.from('customer said the rental quantity was wrong')
    const { boundary, body } = multipart([
      { name: 'kind', value: 'audio' },
      { name: 'duration_ms', value: '2200' },
      { name: 'pii_level', value: 'private' },
      { name: 'metadata', value: JSON.stringify({ source: 'portal_mic' }) },
      { name: 'file', filename: 'feedback.webm', contentType: 'audio/webm', body: payload },
    ])
    await handlePortalRentalRoutes(
      req('POST', body, { 'content-type': `multipart/form-data; boundary=${boundary}` }) as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload`),
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
      duration_ms: 2200,
      pii_level: 'private',
      retention_expires_at: pool.captureSessions[0]?.retention_expires_at,
      metadata: {
        source: 'portal_mic',
        upload_source: 'portal_capture_artifact_upload',
        portal_surface: 'rental_portal',
        rental_share_link_id: 'rental-share-1',
        customer_id: 'cust-1',
      },
    })
    const storageKey = String(pool.captureArtifacts[0]?.storage_key ?? '')
    expect(storageKey).toMatch(
      /^co-1\/capture-sessions\/00000000-0000-4000-8000-000000000123\/[0-9a-f-]+-feedback\.webm$/,
    )
    await expect(upload.storage.get(storageKey)).resolves.toEqual(payload)
  })

  it('finalizes a signed rental portal capture session into a triage work item', async () => {
    const pool = new FakePool()
    const token = seedLink(pool)
    const start = makeCtx(pool)
    start.reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/rentals/share-token',
    })
    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions`),
      start.ctx,
    )

    const events = makeCtx(pool)
    events.reads.push({
      events: [{ client_event_id: 'rent-1', event_type: 'portal.quantity.confusing', payload: { item_id: 'item-1' } }],
    })
    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/events`),
      events.ctx,
    )

    const finalize = makeCtx(pool)
    finalize.reads.push({
      title: 'Rental quantity was confusing',
      summary: 'The portal user could not tell how quantity maps to billing.',
      severity: 'high',
      lane: 'triage',
    })
    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/finalize`),
      finalize.ctx,
    )

    expect(finalize.responses[0]).toMatchObject({
      status: 201,
      body: {
        work_item: {
          title: 'Rental quantity was confusing',
          lane: 'triage',
          severity: 'high',
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
    expect(pool.supportPackets).toHaveLength(1)
    expect(pool.supportPackets[0]).toMatchObject({
      actor_user_id: 'portal_guest:signed_rental_share_token:rental-share-1',
      capture_session_id: '00000000-0000-4000-8000-000000000123',
    })
    expect(pool.workItems).toHaveLength(1)
    expect(pool.workItems[0]).toMatchObject({
      lane: 'triage',
      created_by_user_id: 'portal_guest:signed_rental_share_token:rental-share-1',
      metadata: {
        source: 'capture_session_finalize',
        portal_surface: 'rental_portal',
        event_count: 1,
      },
    })
    expect(pool.handoffEvents[0]).toMatchObject({
      actor_kind: 'external',
      actor_ref: 'portal_guest:signed_rental_share_token:rental-share-1',
    })
    expect(pool.captureSessions[0]).toMatchObject({
      status: 'stopped',
      metadata: {
        finalized_by: 'portal_guest',
        finalized_support_packet_id: 'support-1',
        finalized_work_item_id: 'work-item-1',
      },
    })

    const replay = makeCtx(pool)
    replay.reads.push({})
    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/finalize`),
      replay.ctx,
    )
    expect(replay.responses[0]).toMatchObject({
      status: 200,
      body: {
        idempotent_replay: true,
        work_item: { id: 'work-item-1' },
      },
    })
    expect(pool.supportPackets).toHaveLength(1)
    expect(pool.workItems).toHaveLength(1)
    expect(pool.handoffEvents).toHaveLength(1)
  })

  it('discards a signed rental portal capture session and tombstones stored artifacts', async () => {
    const pool = new FakePool()
    const token = seedLink(pool)
    const start = makeCtx(pool)
    start.reads.push({
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/rentals/share-token',
    })
    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions`),
      start.ctx,
    )

    const upload = makeCtx(pool)
    const payload = Buffer.from('discard this portal audio')
    const { boundary, body } = multipart([
      { name: 'kind', value: 'audio' },
      { name: 'file', filename: 'feedback.webm', contentType: 'audio/webm', body: payload },
    ])
    await handlePortalRentalRoutes(
      req('POST', body, { 'content-type': `multipart/form-data; boundary=${boundary}` }) as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload`),
      upload.ctx,
    )
    const key = String(pool.captureArtifacts[0]?.storage_key ?? '')
    await expect(upload.storage.get(key)).resolves.toEqual(payload)

    const discard = makeCtx(pool, upload.storage)
    discard.reads.push({
      metadata: {
        capture_failure: {
          event_type: 'recording_start_failed',
          failed_at: '2026-06-04T12:00:00.000Z',
          error_name: 'NotAllowedError',
          message: 'Screen share permission denied',
        },
      },
    })
    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl(`/api/portal/rentals/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/discard`),
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
        portal_surface: 'rental_portal',
        capture_failure: {
          event_type: 'recording_start_failed',
          failed_at: '2026-06-04T12:00:00.000Z',
          error_name: 'NotAllowedError',
          message: 'Screen share permission denied',
        },
      },
    })
    expect(pool.captureEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'recording_start_failed',
          event_class: 'lifecycle',
          route_path: '/portal/rentals/share-token',
          payload: expect.objectContaining({
            event_type: 'recording_start_failed',
            error_name: 'NotAllowedError',
            message: 'Screen share permission denied',
            portal_surface: 'rental_portal',
            portal_authority: 'signed_rental_share_token',
            discard_status: 'succeeded',
          }),
        }),
        expect.objectContaining({
          event_type: 'session.discarded',
          event_class: 'lifecycle',
        }),
      ]),
    )
    expect(pool.captureArtifacts[0]?.deleted_at).toBeTruthy()
    await expect(upload.storage.get(key)).rejects.toThrow(`missing ${key}`)
  })

  it('rejects capture start for an unsigned rental portal token', async () => {
    const pool = new FakePool()
    const { ctx, responses, reads } = makeCtx(pool)
    reads.push({ capture_session_id: '00000000-0000-4000-8000-000000000123' })

    await handlePortalRentalRoutes(
      { method: 'POST' } as never,
      buildUrl('/api/portal/rentals/not.signed/capture-sessions'),
      ctx,
    )

    expect(responses[0]?.status).toBe(401)
    expect(pool.captureSessions).toHaveLength(0)
  })
})
