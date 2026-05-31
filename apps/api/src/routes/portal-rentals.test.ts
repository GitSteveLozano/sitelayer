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
  captureSessions: Row[] = []
  captureEvents: Row[] = []
  captureArtifacts: Row[] = []

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
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (/from rental_share_links where share_token = \$1/i.test(sql)) {
      const [token] = params as [string]
      const row = this.rentalLinks.find((link) => link.share_token === token)
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

    if (/select id, status(?:, retention_expires_at)?\s+from capture_sessions/i.test(sql)) {
      const [id, companyId, actorRef] = params as [string, string, string]
      const row = this.captureSessions.find(
        (session) =>
          session.id === id && session.company_id === companyId && session.consent_actor_ref === actorRef,
      )
      return {
        rows: row ? [{ id: row.id, status: row.status, retention_expires_at: row.retention_expires_at }] : [],
        rowCount: row ? 1 : 0,
      }
    }

    if (/^\s*insert into capture_session_events/i.test(sql)) {
      const [companyId, captureSessionId, seq, clientEventId, eventType, eventClass, routePath, , , , requestId, payload] =
        params as [string, string, number, string | null, string, string, string | null, unknown, unknown, unknown, string | null, string]
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
      }
      this.captureArtifacts.push(row)
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    if (/update capture_sessions\s+set last_seen_at = now\(\)/i.test(sql)) {
      return { rows: [], rowCount: 1 }
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
	    },
	    storage,
	  }
	}

function multipart(parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; body?: Buffer }>) {
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
	      buildUrl(
	        `/api/portal/rentals/${token}/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/upload`,
	      ),
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
