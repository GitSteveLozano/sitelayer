/**
 * QBO route handler — OAuth round-trip, connection CRUD, full sync,
 * material-bill push, estimate push. Supporting modules:
 *
 *   - ../qbo-http.ts                    HTTP retry + Sentry spans
 *   - ../qbo-oauth-state.ts             signed state token for callback
 *   - ../qbo-integration-connection.ts  connection row CRUD
 *   - ../qbo-integration-mapping.ts     mapping CRUD + backfill helpers
 *   - ../qbo-sync-run.ts                qbo_sync_runs workflow events
 */
import { Sentry, captureWithEntityContext } from '../instrument.js'
import { randomUUID } from 'node:crypto'
import type http from 'node:http'
import type { Pool } from 'pg'
import { createLogger } from '@sitelayer/logger'
import type { ActiveCompany } from '../auth-types.js'
import { parseExpectedVersion } from '../http-utils.js'
import { recordMutationLedger, recordSyncEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { QboParseError, parseQboClass, parseQboEstimateCreateResponse, parseQboItem } from '../qbo-parse.js'
import { qboGet, qboPost } from '../qbo-http.js'
import { decodeQboState, encodeQboState, type QboOAuthState } from '../qbo-oauth-state.js'
import {
  getIntegrationConnection,
  getIntegrationConnectionWithSecrets,
  upsertIntegrationConnection,
} from '../qbo-integration-connection.js'
import {
  backfillCustomerMapping,
  backfillDivisionMapping,
  backfillProjectMapping,
  backfillServiceItemMapping,
  upsertIntegrationMapping,
} from '../qbo-integration-mapping.js'
import { completeQboSyncRunFailure, completeQboSyncRunSuccess, startQboSyncRun } from '../qbo-sync-run.js'
import { getSyncStatus } from './sync.js'

// Re-exports so existing consumers (server.ts, dispatch.ts) keep working.
// The implementations live in the sibling modules above.
export {
  backfillCustomerMapping,
  backfillDivisionMapping,
  backfillProjectMapping,
  backfillServiceItemMapping,
  listIntegrationMappings,
  upsertIntegrationMapping,
  type IntegrationMappingRow,
} from '../qbo-integration-mapping.js'
export { decodeQboState, encodeQboState, type QboOAuthState } from '../qbo-oauth-state.js'
export {
  getIntegrationConnection,
  getIntegrationConnectionWithSecrets,
  upsertIntegrationConnection,
} from '../qbo-integration-connection.js'

const logger = createLogger('api:qbo')

export type QboConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
  successRedirectUri: string
  stateSecret: string
  baseUrl: string
}

export type QboRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  sendRedirect: (location: string) => void
  qboConfig: QboConfig
}

export async function handleQboRoutes(req: http.IncomingMessage, url: URL, ctx: QboRouteCtx): Promise<boolean> {
  const { pool, company, currentUserId, requireRole, readBody, sendJson, qboConfig } = ctx
  const { clientId, clientSecret, redirectUri, successRedirectUri, stateSecret, baseUrl } = qboConfig

  // GET /api/integrations/qbo/auth — generate OAuth authorization URL
  if (req.method === 'GET' && url.pathname === '/api/integrations/qbo/auth') {
    const state = encodeQboState(
      {
        companyId: company.id,
        userId: currentUserId,
        exp: Date.now() + 10 * 60 * 1000,
        nonce: randomUUID(),
      },
      stateSecret,
    )
    const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=com.intuit.quickbooks.accounting&state=${encodeURIComponent(state)}`
    sendJson(200, { authUrl })
    return true
  }

  // GET /api/integrations/qbo/callback — OAuth token exchange
  if (req.method === 'GET' && url.pathname === '/api/integrations/qbo/callback') {
    const code = url.searchParams.get('code')
    const realmId = url.searchParams.get('realmId')
    const state = url.searchParams.get('state')
    if (!code || !realmId || !state) {
      sendJson(400, { error: 'missing code, realmId, or state' })
      return true
    }
    let stateData: QboOAuthState
    try {
      stateData = decodeQboState(state, stateSecret)
    } catch (error) {
      const status = error instanceof Error && 'status' in error ? (error as { status: number }).status : 400
      sendJson(status, { error: error instanceof Error ? error.message : 'invalid state' })
      return true
    }
    const stateMembership = await pool.query(
      'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
      [stateData.companyId, stateData.userId],
    )
    if (!stateMembership.rows.length) {
      sendJson(403, { error: 'state user is not a member of this company' })
      return true
    }
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
    const tokenResponse = await Sentry.startSpan(
      {
        name: 'qbo.request',
        op: 'http.client',
        attributes: {
          'http.url': tokenUrl,
          'http.method': 'POST',
          'qbo.attempt': 0,
          'qbo.kind': 'oauth_token_exchange',
        },
      },
      async (span) => {
        const r = await fetch(tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${auth}`,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
          }).toString(),
        })
        span?.setAttribute('http.status_code', r.status)
        if (!r.ok) span?.setStatus({ code: 2, message: `qbo_${r.status}` })
        return r
      },
    )
    if (!tokenResponse.ok) {
      sendJson(400, { error: 'token exchange failed' })
      return true
    }
    const tokenData = (await tokenResponse.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }
    const connection = await withMutationTx(async (client) => {
      const row = await upsertIntegrationConnection(
        pool,
        stateData.companyId,
        'qbo',
        {
          provider_account_id: realmId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          status: 'connected',
        },
        client,
      )
      // Persist access-token expiry so the worker push paths can refresh
      // proactively. Intuit returns expires_in in seconds; we store the
      // absolute deadline. Done as a separate UPDATE because
      // upsertIntegrationConnection's signature is intentionally narrow.
      const expiresInSec = Number(tokenData.expires_in)
      if (Number.isFinite(expiresInSec) && expiresInSec > 0) {
        await client.query(
          `update integration_connections
             set access_token_expires_at = now() + ($2::int * interval '1 second')
           where id = $1`,
          [row.id, Math.floor(expiresInSec)],
        )
      }
      await recordSyncEvent(
        stateData.companyId,
        'integration_connection',
        row.id,
        { action: 'oauth_connect', provider: 'qbo' },
        null,
        { executor: client },
      )
      return row
    })
    if (successRedirectUri) {
      ctx.sendRedirect(successRedirectUri)
      return true
    }
    sendJson(200, { connection, success: true })
    return true
  }

  // GET /api/integrations/qbo — connection status
  if (req.method === 'GET' && url.pathname === '/api/integrations/qbo') {
    const connection = await getIntegrationConnection(pool, company.id, 'qbo')
    sendJson(200, {
      connection,
      status: await getSyncStatus(pool, company.id),
    })
    return true
  }

  // POST /api/integrations/qbo — update connection
  if (req.method === 'POST' && url.pathname === '/api/integrations/qbo') {
    if (!requireRole(['admin', 'office'])) return true
    const body = await readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const currentConnection = await getIntegrationConnection(pool, company.id, 'qbo')
    if (currentConnection && expectedVersion !== null && Number(currentConnection.version) !== expectedVersion) {
      sendJson(409, { error: 'version conflict', current_version: Number(currentConnection.version) })
      return true
    }
    const connection = await withMutationTx(async (client) => {
      const row = await upsertIntegrationConnection(
        pool,
        company.id,
        'qbo',
        {
          provider_account_id: (body.provider_account_id as string | null | undefined) ?? null,
          access_token: (body.access_token as string | null | undefined) ?? null,
          refresh_token: (body.refresh_token as string | null | undefined) ?? null,
          webhook_secret: (body.webhook_secret as string | null | undefined) ?? null,
          sync_cursor: (body.sync_cursor as string | null | undefined) ?? null,
          status: (body.status as string | undefined) ?? 'connected',
        },
        client,
      )
      await recordMutationLedger(client, {
        companyId: company.id,
        entityType: 'integration_connection',
        entityId: row.id,
        action: 'upsert',
        row,
        syncPayload: {
          action: currentConnection ? 'upsert' : 'create',
          provider: 'qbo',
          connection: row,
        },
        idempotencyKey: `integration_connection:qbo:${row.id}`,
      })
      return row
    })
    sendJson(200, { connection })
    return true
  }

  // POST /api/integrations/qbo/sync — full sync (simulated or live).
  //
  // Wraps the sync attempt in a qbo_sync_run workflow row. The route
  // dispatches START_SYNC → SYNC_SUCCEEDED|SYNC_FAILED through the
  // packages/workflows reducer; integration_connections.status stays a
  // derived cache for backwards-compat (connected/syncing/error). The
  // reducer is the authoritative state machine; workflow_event_log is
  // the audit trail.
  if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/sync') {
    if (!requireRole(['admin', 'office'])) return true
    // Ensure a connection row exists so the qbo_sync_run FK resolves;
    // the upsert here historically supported the no-credentials
    // simulated path by creating a placeholder row.
    const connectionPre = await upsertIntegrationConnection(pool, company.id, 'qbo', { status: 'syncing' })
    const connection = await getIntegrationConnectionWithSecrets(pool, company.id, 'qbo')
    const connectionId: string = (connectionPre as { id?: string }).id ?? connection?.id ?? ''
    // Open a tx to create the workflow row + dispatch START_SYNC.
    const initialRun = await withMutationTx(async (client) => {
      return await startQboSyncRun(client, {
        companyId: company.id,
        integrationConnectionId: connectionId,
        triggeredBy: currentUserId,
      })
    })
    const qboSyncRunId = initialRun.run.id
    try {
      if (!connection?.access_token) {
        const [customersResult, serviceItemsResult, divisionsResult] = await withCompanyClient(
          company.id,
          async (client) =>
            Promise.all([
              client.query(
                'select id, external_id, name from customers where company_id = $1 and deleted_at is null and external_id is not null',
                [company.id],
              ),
              client.query(
                "select code, name, source from service_items where company_id = $1 and deleted_at is null and (source = 'qbo' or code like 'qbo-%')",
                [company.id],
              ),
              client.query('select code, name from divisions where company_id = $1 order by sort_order asc', [
                company.id,
              ]),
            ]),
        )
        const qboSnapshot = {
          syncedCustomers: customersResult.rowCount,
          syncedItems: serviceItemsResult.rowCount,
          syncedDivisions: divisionsResult.rowCount,
          simulated: true,
        }
        await withMutationTx(async (client) => {
          for (const row of customersResult.rows) {
            const customer = row as { id: string; external_id: string; name: string }
            await backfillCustomerMapping(pool, company.id, customer, client)
          }
          for (const row of serviceItemsResult.rows) {
            const serviceItem = row as { code: string; name: string; source?: string | null }
            await backfillServiceItemMapping(
              pool,
              company.id,
              serviceItem,
              serviceItem.code.startsWith('qbo-') ? serviceItem.code.slice(4) : null,
              client,
            )
          }
          for (const row of divisionsResult.rows) {
            const division = row as { code: string; name: string }
            await backfillDivisionMapping(pool, company.id, division, division.code, client)
          }
        })
        const refreshed = await withMutationTx(async (client) => {
          const result = await client.query(
            `
update integration_connections
set sync_cursor = $2, last_synced_at = now(), status = 'connected', version = version + 1
where company_id = $1 and provider = 'qbo'
returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
`,
            [company.id, new Date().toISOString()],
          )
          const row = result.rows[0]
          const resolvedConnectionId = connection?.id ?? row.id
          // Dispatch SYNC_SUCCEEDED in the same tx as the connection
          // status flip so workflow_event_log + integration_connections
          // can never disagree.
          await completeQboSyncRunSuccess(client, {
            companyId: company.id,
            runId: qboSyncRunId,
            snapshot: qboSnapshot as Record<string, unknown>,
            triggeredBy: currentUserId,
          })
          await recordMutationLedger(client, {
            companyId: company.id,
            entityType: 'integration_connection',
            entityId: resolvedConnectionId,
            action: 'sync',
            syncPayload: {
              action: 'sync',
              provider: 'qbo',
              snapshot: qboSnapshot,
              simulated: true,
              qbo_sync_run_id: qboSyncRunId,
            },
            outboxPayload: qboSnapshot,
            idempotencyKey: `integration_connection:qbo:sync:${resolvedConnectionId}:${qboSyncRunId}`,
          })
          return row
        })
        sendJson(200, {
          connection: refreshed,
          snapshot: qboSnapshot,
          qbo_sync_run_id: qboSyncRunId,
        })
        return true
      }
      const realmId = connection.provider_account_id ?? ''
      const accessToken = connection.access_token ?? ''

      type QboCustomer = { Id?: string; DisplayName?: string; id?: string; displayName?: string }
      let qboCustomers: QboCustomer[] = []
      try {
        const customerResponse = await qboGet<{ QueryResponse?: { Customer?: QboCustomer[] } }>(
          baseUrl,
          `/query?query=${encodeURIComponent('SELECT * FROM Customer')}`,
          realmId,
          accessToken,
        )
        qboCustomers = customerResponse.QueryResponse?.Customer ?? []
      } catch (e) {
        logger.error({ err: e, scope: 'qbo_customers' }, 'Failed to sync customers from QBO')
        captureWithEntityContext(e, {
          scope: 'qbo_customers',
          entity_type: 'customer',
          company_id: company.id,
        })
      }

      const customerExternalIds: string[] = []
      const customerNames: string[] = []
      for (const qboCustomer of qboCustomers) {
        const externalId = String(qboCustomer.Id ?? qboCustomer.id ?? '')
        if (!externalId) continue
        const name = qboCustomer.DisplayName ?? qboCustomer.displayName ?? externalId
        customerExternalIds.push(externalId)
        customerNames.push(name)
      }
      const syncedCustomers: string[] = []
      if (customerExternalIds.length > 0) {
        await withMutationTx(async (client) => {
          const upserted = await client.query<{
            id: string
            external_id: string
            name: string
          }>(
            `
insert into customers (company_id, external_id, name, source)
select $1::uuid, t.external_id, t.name, 'qbo'
from unnest($2::text[], $3::text[]) as t(external_id, name)
on conflict (company_id, external_id) do update set name = excluded.name, updated_at = now()
returning id, external_id, name
`,
            [company.id, customerExternalIds, customerNames],
          )
          const localRefs: string[] = []
          const externalIds: string[] = []
          const labels: string[] = []
          for (const row of upserted.rows) {
            localRefs.push(row.id)
            externalIds.push(row.external_id)
            labels.push(row.name)
            syncedCustomers.push(row.external_id)
          }
          await client.query(
            `
insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
select $1::uuid, 'qbo', 'customer', local_ref, external_id, label, 'active', 'synced from qbo customer import'
from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
on conflict (company_id, provider, entity_type, local_ref)
do update set
  external_id = excluded.external_id,
  label = excluded.label,
  status = excluded.status,
  notes = excluded.notes,
  version = integration_mappings.version + 1,
  updated_at = now(),
  deleted_at = null
`,
            [company.id, localRefs, externalIds, labels],
          )
        })
      }

      let qboItemsRaw: unknown[] = []
      try {
        const itemResponse = await qboGet<{ QueryResponse?: { Item?: unknown[] } }>(
          baseUrl,
          `/query?query=${encodeURIComponent("SELECT * FROM Item WHERE Type IN ('Service', 'Inventory')")}`,
          realmId,
          accessToken,
        )
        qboItemsRaw = itemResponse.QueryResponse?.Item ?? []
      } catch (e) {
        logger.error({ err: e, scope: 'qbo_items' }, 'Failed to sync items from QBO')
        captureWithEntityContext(e, {
          scope: 'qbo_items',
          entity_type: 'service_item',
          company_id: company.id,
        })
      }

      const itemCodes: string[] = []
      const itemNames: string[] = []
      const itemPrices: string[] = []
      const itemExternalIds: string[] = []
      for (const rawItem of qboItemsRaw) {
        let qboItem
        try {
          qboItem = parseQboItem(rawItem)
        } catch (e) {
          if (e instanceof QboParseError) {
            logger.error({ err: e, scope: 'qbo_items_parse' }, 'QBO item parse failed')
            captureWithEntityContext(e, {
              scope: 'qbo_items_parse',
              entity_type: 'service_item',
              company_id: company.id,
            })
            await recordSyncEvent(
              company.id,
              'service_item',
              'unknown',
              { action: 'parse_failed', provider: 'qbo', raw: e.raw },
              connection.id,
              { status: 'failed', error: e.message },
            )
            continue
          }
          throw e
        }
        itemCodes.push(`qbo-${qboItem.id}`)
        itemNames.push(qboItem.name)
        itemPrices.push(String(qboItem.unitPrice ?? 0))
        itemExternalIds.push(qboItem.id)
      }
      const syncedItems: string[] = []
      if (itemCodes.length > 0) {
        await withMutationTx(async (client) => {
          const upserted = await client.query<{ code: string; name: string }>(
            `
insert into service_items (company_id, code, name, default_rate, category, unit, source)
select $1::uuid, t.code, t.name, t.price::numeric, 'accounting', 'ea', 'qbo'
from unnest($2::text[], $3::text[], $4::text[]) as t(code, name, price)
on conflict (company_id, code) do update set
  name = excluded.name,
  default_rate = excluded.default_rate,
  source = 'qbo',
  updated_at = now()
returning code, name
`,
            [company.id, itemCodes, itemNames, itemPrices],
          )
          for (const row of upserted.rows) {
            syncedItems.push(row.code)
          }
          await client.query(
            `
insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
select $1::uuid, 'qbo', 'service_item', t.local_ref, t.external_id, t.label, 'active', 'backfilled from qbo service_item import'
from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
on conflict (company_id, provider, entity_type, local_ref)
do update set
  external_id = excluded.external_id,
  label = excluded.label,
  status = excluded.status,
  notes = excluded.notes,
  version = integration_mappings.version + 1,
  updated_at = now(),
  deleted_at = null
`,
            [company.id, itemCodes, itemExternalIds, itemNames],
          )
        })
      }

      let qboClassesRaw: unknown[] = []
      try {
        const classResponse = await qboGet<{ QueryResponse?: { Class?: unknown[] } }>(
          baseUrl,
          `/query?query=${encodeURIComponent('SELECT * FROM Class')}`,
          realmId,
          accessToken,
        )
        qboClassesRaw = classResponse.QueryResponse?.Class ?? []
      } catch (e) {
        logger.error({ err: e, scope: 'qbo_classes' }, 'Failed to sync classes from QBO')
        captureWithEntityContext(e, {
          scope: 'qbo_classes',
          entity_type: 'division',
          company_id: company.id,
        })
      }

      const divisionsResult = await withCompanyClient(company.id, (client) =>
        client.query('select code, name from divisions where company_id = $1 order by sort_order asc', [company.id]),
      )
      const divisionLocalRefs: string[] = []
      const divisionExternalIds: string[] = []
      const divisionLabels: string[] = []
      const syncedDivisions: string[] = []
      for (const rawClass of qboClassesRaw) {
        let qboClass
        try {
          qboClass = parseQboClass(rawClass)
        } catch (e) {
          if (e instanceof QboParseError) {
            logger.error({ err: e, scope: 'qbo_classes_parse' }, 'QBO class parse failed')
            captureWithEntityContext(e, {
              scope: 'qbo_classes_parse',
              entity_type: 'division',
              company_id: company.id,
            })
            await recordSyncEvent(
              company.id,
              'division',
              'unknown',
              { action: 'parse_failed', provider: 'qbo', raw: e.raw },
              connection.id,
              { status: 'failed', error: e.message },
            )
            continue
          }
          throw e
        }
        const division = divisionsResult.rows.find(
          (row) =>
            row.name.toLowerCase() === qboClass.name.toLowerCase() ||
            row.code.toLowerCase() === qboClass.name.toLowerCase(),
        )
        if (!division) continue
        divisionLocalRefs.push(division.code)
        divisionExternalIds.push(qboClass.id)
        divisionLabels.push(division.name)
        syncedDivisions.push(division.code)
      }
      if (divisionLocalRefs.length > 0) {
        await withMutationTx(async (client) => {
          await client.query(
            `
insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
select $1::uuid, 'qbo', 'division', t.local_ref, t.external_id, t.label, 'active', 'backfilled from qbo class sync'
from unnest($2::text[], $3::text[], $4::text[]) as t(local_ref, external_id, label)
on conflict (company_id, provider, entity_type, local_ref)
do update set
  external_id = excluded.external_id,
  label = excluded.label,
  status = excluded.status,
  notes = excluded.notes,
  version = integration_mappings.version + 1,
  updated_at = now(),
  deleted_at = null
`,
            [company.id, divisionLocalRefs, divisionExternalIds, divisionLabels],
          )
        })
      }

      // Pull TimeActivity + Bill from QBO. We log counts + a sync_events
      // breadcrumb but do NOT auto-write to labor_entries / material_bills
      // — those mappings need explicit business rules (which TimeActivity
      // employee maps to which sitelayer worker, which Bill goes to which
      // project) that the office hasn't formalized yet. The pull is
      // useful in itself: it surfaces counts so the office knows what's
      // sitting in QBO and can decide how to ingest later.
      let pulledTimeActivities = 0
      try {
        const timeResponse = await qboGet<{ QueryResponse?: { TimeActivity?: unknown[] } }>(
          baseUrl,
          `/query?query=${encodeURIComponent('SELECT * FROM TimeActivity')}`,
          realmId,
          accessToken,
        )
        const rows = timeResponse.QueryResponse?.TimeActivity ?? []
        pulledTimeActivities = rows.length
        if (rows.length > 0) {
          await recordSyncEvent(
            company.id,
            'qbo_time_activity',
            'pull',
            { action: 'pull', count: rows.length, source: 'qbo' },
            connection.id,
          )
        }
      } catch (e) {
        logger.error({ err: e, scope: 'qbo_time_activities' }, 'Failed to pull time activities from QBO')
        captureWithEntityContext(e, {
          scope: 'qbo_time_activities',
          entity_type: 'qbo_time_activity',
          company_id: company.id,
        })
      }

      let pulledBills = 0
      try {
        const billResponse = await qboGet<{ QueryResponse?: { Bill?: unknown[] } }>(
          baseUrl,
          `/query?query=${encodeURIComponent('SELECT * FROM Bill')}`,
          realmId,
          accessToken,
        )
        const rows = billResponse.QueryResponse?.Bill ?? []
        pulledBills = rows.length
        if (rows.length > 0) {
          await recordSyncEvent(
            company.id,
            'qbo_bill',
            'pull',
            { action: 'pull', count: rows.length, source: 'qbo' },
            connection.id,
          )
        }
      } catch (e) {
        logger.error({ err: e, scope: 'qbo_bills' }, 'Failed to pull bills from QBO')
        captureWithEntityContext(e, {
          scope: 'qbo_bills',
          entity_type: 'qbo_bill',
          company_id: company.id,
        })
      }

      const qboSnapshot = {
        syncedCustomers: syncedCustomers.length,
        syncedItems: syncedItems.length,
        syncedDivisions: syncedDivisions.length,
        pulledTimeActivities,
        pulledBills,
      }

      const refreshed = await withMutationTx(async (client) => {
        const result = await client.query(
          `
update integration_connections
set sync_cursor = $2, last_synced_at = now(), status = 'connected', version = version + 1
where company_id = $1 and provider = 'qbo'
returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
`,
          [company.id, new Date().toISOString()],
        )
        // Dispatch SYNC_SUCCEEDED in the same tx as the integration
        // connection status flip.
        await completeQboSyncRunSuccess(client, {
          companyId: company.id,
          runId: qboSyncRunId,
          snapshot: qboSnapshot as Record<string, unknown>,
          triggeredBy: currentUserId,
        })
        await recordMutationLedger(client, {
          companyId: company.id,
          entityType: 'integration_connection',
          entityId: connection.id,
          action: 'sync',
          syncPayload: {
            action: 'sync',
            provider: 'qbo',
            snapshot: qboSnapshot,
            qbo_sync_run_id: qboSyncRunId,
          },
          outboxPayload: qboSnapshot,
          idempotencyKey: `integration_connection:qbo:sync:${connection.id}:${qboSyncRunId}`,
        })
        return result.rows[0] ?? connection
      })

      sendJson(200, {
        connection: refreshed,
        snapshot: qboSnapshot,
        qbo_sync_run_id: qboSyncRunId,
      })
    } catch (error) {
      logger.error({ err: error, scope: 'qbo_sync' }, 'QBO sync error')
      captureWithEntityContext(error, {
        scope: 'qbo_sync',
        entity_type: 'integration_connection',
        company_id: company.id,
      })
      // Dispatch SYNC_FAILED + flip integration_connections.status='error'
      // in the same tx so the workflow row and the cached status flag
      // can never disagree.
      try {
        await withMutationTx(async (client) => {
          await completeQboSyncRunFailure(client, {
            companyId: company.id,
            runId: qboSyncRunId,
            error: error instanceof Error ? error.message : String(error),
            triggeredBy: currentUserId,
          })
          await client.query(
            `update integration_connections
               set status = 'error', version = version + 1
             where company_id = $1 and provider = 'qbo'`,
            [company.id],
          )
        })
      } catch (innerErr) {
        // Best-effort: don't mask the original sync error.
        logger.error({ err: innerErr, scope: 'qbo_sync_failure_record' }, 'failed to record qbo_sync_run failure')
      }
      sendJson(500, { error: 'sync failed', qbo_sync_run_id: qboSyncRunId })
    }
    return true
  }

  // POST /api/integrations/qbo/sync/material-bills — push unsynced material_bills to QBO
  if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/sync/material-bills') {
    if (!requireRole(['admin', 'office'])) return true
    const connection = await getIntegrationConnectionWithSecrets(pool, company.id, 'qbo')
    if (!connection?.access_token || !connection.provider_account_id) {
      sendJson(400, { error: 'QBO connection missing or not authorized' })
      return true
    }
    const realmId = connection.provider_account_id as string
    const accessToken = connection.access_token as string

    const [accountMappingResult, unsynced] = await withCompanyClient(company.id, async (client) =>
      Promise.all([
        client.query<{ external_id: string }>(
          `select external_id from integration_mappings
       where company_id = $1 and provider = 'qbo'
         and entity_type = 'qbo_account' and local_ref = 'materials'
         and deleted_at is null
       limit 1`,
          [company.id],
        ),
        client.query<{
          id: string
          vendor_name: string
          amount: string | number
          description: string | null
          occurred_on: string | null
        }>(
          `select mb.id, mb.vendor_name, mb.amount, mb.description, mb.occurred_on
       from material_bills mb
       where mb.company_id = $1 and mb.deleted_at is null
         and not exists (
           select 1 from integration_mappings im
           where im.company_id = mb.company_id and im.provider = 'qbo'
             and im.entity_type = 'material_bill' and im.local_ref = mb.id::text
             and im.deleted_at is null
         )`,
          [company.id],
        ),
      ]),
    )
    const materialsAccountId = accountMappingResult.rows[0]?.external_id ?? null

    const errors: Array<{ bill_id: string; error: string }> = []
    let synced = 0
    const vendorCache = new Map<string, string>()

    for (const bill of unsynced.rows) {
      if (!materialsAccountId) {
        errors.push({
          bill_id: bill.id,
          error: 'no Materials account mapped — set via /api/integrations/qbo/mappings',
        })
        continue
      }
      try {
        const displayName = bill.vendor_name.trim()
        if (!displayName) {
          errors.push({ bill_id: bill.id, error: 'vendor_name is empty' })
          continue
        }
        let vendorId = vendorCache.get(displayName) ?? null
        if (!vendorId) {
          const mappedVendor = await withCompanyClient(company.id, (client) =>
            client.query<{ external_id: string }>(
              `select external_id from integration_mappings
             where company_id = $1 and provider = 'qbo'
               and entity_type = 'qbo_vendor' and local_ref = $2
               and deleted_at is null
             limit 1`,
              [company.id, displayName],
            ),
          )
          vendorId = mappedVendor.rows[0]?.external_id ?? null
        }
        if (!vendorId) {
          // QBO vendor query is quoted via single-quotes; escape any embedded
          // quotes to avoid breaking the V2 query grammar.
          const escaped = displayName.replace(/'/g, "\\'")
          const vendorSearch = await qboGet<{ QueryResponse?: { Vendor?: Array<{ Id?: string }> } }>(
            baseUrl,
            `/query?query=${encodeURIComponent(`select * from Vendor where DisplayName = '${escaped}'`)}`,
            realmId,
            accessToken,
          )
          vendorId = vendorSearch.QueryResponse?.Vendor?.[0]?.Id ?? null
          if (!vendorId) {
            const created = await qboPost<{ Vendor?: { Id?: string } }>(baseUrl, `/vendor`, realmId, accessToken, {
              DisplayName: displayName,
            })
            vendorId = created.Vendor?.Id ?? null
          }
          if (!vendorId) {
            errors.push({ bill_id: bill.id, error: 'failed to resolve or create QBO vendor' })
            continue
          }
          vendorCache.set(displayName, vendorId)
          await upsertIntegrationMapping(pool, company.id, 'qbo', {
            entity_type: 'qbo_vendor',
            local_ref: displayName,
            external_id: vendorId,
            label: displayName,
            status: 'active',
            notes: 'resolved via material-bill push',
          })
        }

        const amount = Number(bill.amount) || 0
        const billPayload = {
          VendorRef: { value: vendorId },
          TxnDate: bill.occurred_on ?? undefined,
          Line: [
            {
              Amount: amount,
              DetailType: 'AccountBasedExpenseLineDetail',
              Description: bill.description ?? undefined,
              AccountBasedExpenseLineDetail: {
                AccountRef: { value: materialsAccountId },
              },
            },
          ],
        }
        const response = await qboPost<{ Bill?: { Id?: string } }>(baseUrl, `/bill`, realmId, accessToken, billPayload)
        const qboBillId = response.Bill?.Id ?? null
        if (!qboBillId) {
          errors.push({ bill_id: bill.id, error: 'QBO did not return a Bill.Id' })
          continue
        }
        // Pair the mapping upsert with the success ledger row so we never end
        // up with a material_bill:push sync_event for a bill with no mapping.
        await withMutationTx(async (client) => {
          await upsertIntegrationMapping(
            pool,
            company.id,
            'qbo',
            {
              entity_type: 'material_bill',
              local_ref: bill.id,
              external_id: qboBillId,
              label: `${displayName} ${amount}`,
              status: 'active',
              notes: 'pushed via /sync/material-bills',
            },
            client,
          )
          await recordSyncEvent(
            company.id,
            'material_bill',
            bill.id,
            { action: 'push', provider: 'qbo', external_id: qboBillId },
            null,
            { executor: client },
          )
        })
        synced += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error'
        logger.error({ err, scope: 'qbo_material_bill_push', bill_id: bill.id }, 'material bill push failed')
        captureWithEntityContext(err, {
          scope: 'qbo_material_bill_push',
          entity_type: 'material_bill',
          entity_id: bill.id,
          company_id: company.id,
        })
        errors.push({ bill_id: bill.id, error: message })
      }
    }
    sendJson(200, { synced, errors, total_candidates: unsynced.rowCount ?? 0 })
    return true
  }

  // POST /api/projects/:id/estimate/push-qbo — push estimate to QBO
  const pushQboMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/estimate\/push-qbo$/)
  if (req.method === 'POST' && pushQboMatch) {
    if (!requireRole(['admin', 'office'])) return true
    const projectId = pushQboMatch[1]!
    const connection = await getIntegrationConnectionWithSecrets(pool, company.id, 'qbo')

    const projectResult = await withCompanyClient(company.id, (client) =>
      client.query('select id, name, customer_name, bid_total from projects where company_id = $1 and id = $2', [
        company.id,
        projectId,
      ]),
    )
    if (!projectResult.rows[0]) {
      sendJson(404, { error: 'project not found' })
      return true
    }

    const project = projectResult.rows[0]
    try {
      if (!connection?.access_token) {
        const simulatedExternalId = `SIM-EST-${project.id.slice(0, 8)}`
        const payload = {
          simulated: true,
          estimateId: simulatedExternalId,
          projectId: project.id,
          projectName: project.name,
          amount: project.bid_total,
        }
        await withMutationTx(async (client) => {
          await backfillProjectMapping(pool, company.id, project, simulatedExternalId, client)
          await recordMutationLedger(client, {
            companyId: company.id,
            entityType: 'project',
            entityId: project.id,
            action: 'push-qbo',
            syncPayload: { action: 'push_qbo', payload, simulated: true },
            outboxPayload: payload,
          })
        })
        sendJson(200, payload)
        return true
      }
      const estimatePayload = {
        DocNumber: `EST-${project.id.slice(0, 8)}`,
        CustomerRef: { value: connection.provider_account_id },
        Line: [
          {
            Amount: Number(project.bid_total),
            Description: project.name,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: {
              Qty: 1,
              UnitPrice: Number(project.bid_total),
            },
          },
        ],
      }

      const result = await qboPost(
        baseUrl,
        '/estimate',
        connection.provider_account_id ?? '',
        connection.access_token ?? '',
        estimatePayload,
      )

      let qboEstimateId = ''
      try {
        qboEstimateId = parseQboEstimateCreateResponse(result).id
      } catch (e) {
        if (e instanceof QboParseError) {
          logger.error({ err: e, scope: 'qbo_push_estimate_parse' }, 'QBO estimate response parse failed')
          captureWithEntityContext(e, {
            scope: 'qbo_push_estimate_parse',
            entity_type: 'project',
            entity_id: projectId,
            company_id: company.id,
            workflow_name: 'estimate_push',
          })
          await recordSyncEvent(
            company.id,
            'project',
            projectId,
            { action: 'push_qbo', provider: 'qbo', raw: e.raw },
            connection.id ?? null,
            { status: 'failed', error: e.message },
          )
          sendJson(502, { error: 'qbo returned malformed estimate response' })
          return true
        }
        throw e
      }
      await withMutationTx(async (client) => {
        if (qboEstimateId) {
          await backfillProjectMapping(pool, company.id, project, qboEstimateId, client)
        }
        await recordSyncEvent(company.id, 'project', projectId, { action: 'push_qbo', result }, null, {
          executor: client,
        })
      })
      sendJson(200, { success: true, result })
    } catch (error) {
      logger.error({ err: error, scope: 'qbo_push_estimate' }, 'Failed to push estimate to QBO')
      captureWithEntityContext(error, {
        scope: 'qbo_push_estimate',
        entity_type: 'project',
        entity_id: projectId,
        company_id: company.id,
        workflow_name: 'estimate_push',
      })
      sendJson(500, { error: 'failed to push estimate to qbo' })
    }
    return true
  }

  return false
}
