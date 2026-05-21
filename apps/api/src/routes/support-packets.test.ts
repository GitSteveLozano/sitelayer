import { describe, expect, it } from 'vitest'
import type http from 'node:http'
import type { Pool } from 'pg'
import type pino from 'pino'
import type { ActiveCompany } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { attachMutationTx } from '../mutation-tx.js'
import {
  collectEntityRefs,
  collectRequestIds,
  handleSupportPacketRoutes,
  sanitizeSupportJson,
  type JsonRecord,
  type SupportPacketRouteCtx,
  type SupportPacketRow,
} from './support-packets.js'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

type SupportPacketAccessLog = {
  id: string
  support_packet_id: string
  actor_user_id: string
  access_type: string
  route: string | null
  request_id: string | null
  created_at: string
  metadata: JsonRecord
}

class FakeSupportPacketPool {
  accessLog: SupportPacketAccessLog[] = []
  supportPacket: SupportPacketRow = {
    id: '00000000-0000-4000-8000-000000000101',
    company_id: COMPANY_ID,
    actor_user_id: 'creator-1',
    request_id: 'request-1',
    route: '/projects/p/estimate',
    build_sha: 'test-build',
    problem: 'Estimate failed',
    client: {},
    server_context: { request_ids: ['request-1'], trace_ids: ['trace-1'] },
    created_at: '2026-05-21T12:00:00.000Z',
    expires_at: '2026-05-22T12:00:00.000Z',
    redaction_version: 'support-packet-v1',
  }

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  private async dispatch(sqlRaw: string, params: unknown[] = []) {
    const normalized = sqlRaw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (
      normalized.startsWith('begin') ||
      normalized.startsWith('commit') ||
      normalized.startsWith('rollback') ||
      normalized.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.includes('from support_debug_packets') && normalized.includes('limit 1')) {
      const [id, companyId] = params as [string, string]
      const row = id === this.supportPacket.id && companyId === COMPANY_ID ? this.supportPacket : null
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('insert into support_packet_access_log')) {
      const row: SupportPacketAccessLog = {
        id: `access-${this.accessLog.length + 1}`,
        support_packet_id: params[1] as string,
        actor_user_id: params[2] as string,
        access_type: params[3] as string,
        route: (params[4] as string | null) ?? null,
        request_id: (params[5] as string | null) ?? null,
        created_at: '2026-05-21T12:01:00.000Z',
        metadata: JSON.parse(params[6] as string) as JsonRecord,
      }
      this.accessLog.push(row)
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('from support_packet_access_log')) {
      const [, supportPacketId] = params as [string, string, number]
      const rows = this.accessLog.filter((row) => row.support_packet_id === supportPacketId)
      return { rows, rowCount: rows.length }
    }
    throw new Error(`unexpected SQL: ${normalized.slice(0, 240)}`)
  }
}

function buildReq(method = 'GET'): http.IncomingMessage {
  return { method, headers: {} } as http.IncomingMessage
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function makeCtx(pool: FakeSupportPacketPool): {
  ctx: SupportPacketRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  const company: ActiveCompany = { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role: 'admin' }
  const identity: Identity = { userId: 'admin-1', source: 'default' }
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      company,
      identity,
      tier: 'local',
      buildSha: 'test-build',
      requireRole: (allowed) => {
        const ok = allowed.includes('admin')
        if (!ok) responses.push({ status: 403, body: { error: 'forbidden' } })
        return ok
      },
      readBody: async () => ({}),
      sendJson: (status, body) => responses.push({ status, body }),
    },
  }
}

describe('support packet sanitization', () => {
  it('redacts obvious secrets and contact details', () => {
    expect(
      sanitizeSupportJson({
        authorization: 'Bearer abc',
        nested: {
          email: 'person@example.com',
          phone: '204-555-1212',
        },
      }),
    ).toEqual({
      authorization: '[redacted]',
      nested: {
        email: '[email]',
        phone: '[phone]',
      },
    })
  })

  it('collects client and server request ids', () => {
    expect(
      collectRequestIds(
        {
          requests: [{ request_id: 'web-one', response_request_id: 'api-one' }, { requestId: 'web-two' }],
        },
        'api-current',
      ),
    ).toEqual(['api-current', 'web-one', 'api-one', 'web-two'])
  })

  it('collects entity refs from Probe path payloads', () => {
    expect(
      collectEntityRefs({
        path: {
          route: '/financial/estimate-pushes/11111111-1111-4111-8111-111111111111',
          entity_type: 'estimate_push',
          entity_id: '11111111-1111-4111-8111-111111111111',
        },
      }),
    ).toEqual([
      {
        entity_type: 'estimate_push',
        entity_id: '11111111-1111-4111-8111-111111111111',
      },
    ])
  })

  it('records support packet prompt reads in the access log', async () => {
    const pool = new FakeSupportPacketPool()
    const read = makeCtx(pool)

    await handleSupportPacketRoutes(
      buildReq('GET'),
      buildUrl(`/api/support-packets/${pool.supportPacket.id}`),
      read.ctx,
    )

    expect(read.responses[0]?.status).toBe(200)
    expect(pool.accessLog).toMatchObject([
      {
        support_packet_id: pool.supportPacket.id,
        actor_user_id: 'admin-1',
        access_type: 'agent_prompt',
      },
    ])
    const listed = makeCtx(pool)
    await handleSupportPacketRoutes(
      buildReq('GET'),
      buildUrl(`/api/support-packets/${pool.supportPacket.id}/access-log`),
      listed.ctx,
    )
    expect(listed.responses[0]?.status).toBe(200)
    expect(listed.responses[0]?.body).toMatchObject({
      access_log: [
        {
          support_packet_id: pool.supportPacket.id,
          access_type: 'agent_prompt',
        },
      ],
    })
  })
})
