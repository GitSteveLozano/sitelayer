import { Sentry } from '../instrument.js'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'
import type { Pool } from 'pg'
import { createLogger } from '@sitelayer/logger'
import type { ActiveCompany } from '../auth-types.js'
import { HttpError, parseExpectedVersion } from '../http-utils.js'
import { recordMutationLedger, recordSyncEvent, withMutationTx, type LedgerExecutor } from '../mutation-tx.js'
import { QboParseError, parseQboClass, parseQboEstimateCreateResponse, parseQboItem } from '../qbo-parse.js'
import { getSyncStatus } from './sync.js'

const logger = createLogger('api:qbo')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntegrationMappingRow = {
  id: string
  provider: string
  entity_type: string
  local_ref: string
  external_id: string
  label: string | null
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type QboOAuthState = {
  companyId: string
  userId: string
  exp: number
  nonce: string
}

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

// ---------------------------------------------------------------------------
// QBO HTTP helpers
// ---------------------------------------------------------------------------

const QBO_RETRY_DELAYS_MS = [200, 1000, 5000] as const

function qboShouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

async function qboFetch<T>(url: string, init: RequestInit): Promise<T> {
  let lastStatus = 0
  let lastStatusText = ''
  for (let attempt = 0; attempt <= QBO_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch(url, init)
    if (response.ok) return (await response.json()) as T
    lastStatus = response.status
    lastStatusText = response.statusText
    if (!qboShouldRetry(response.status) || attempt === QBO_RETRY_DELAYS_MS.length) {
      throw new Error(`QBO API error: ${response.status} ${response.statusText}`)
    }
    const delay = QBO_RETRY_DELAYS_MS[attempt] ?? 0
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`QBO API error: ${lastStatus} ${lastStatusText}`)
}

async function qboGet<T>(baseUrl: string, endpoint: string, realmId: string, accessToken: string): Promise<T> {
  return qboFetch<T>(`${baseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
}

async function qboPost<T>(
  baseUrl: string,
  endpoint: string,
  realmId: string,
  accessToken: string,
  body: unknown,
): Promise<T> {
  return qboFetch<T>(`${baseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// OAuth state helpers
// ---------------------------------------------------------------------------

function signQboStatePayload(payload: string, stateSecret: string) {
  return createHmac('sha256', stateSecret).update(payload).digest('base64url')
}

function isSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function encodeQboState(state: QboOAuthState, stateSecret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
  const signature = signQboStatePayload(payload, stateSecret)
  return `${payload}.${signature}`
}

export function decodeQboState(rawState: string, stateSecret: string): QboOAuthState {
  const [payload, signature] = rawState.split('.', 2)
  if (!payload || !signature || !isSafeEqual(signQboStatePayload(payload, stateSecret), signature)) {
    throw new HttpError(400, 'invalid state')
  }

  let parsed: QboOAuthState
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as QboOAuthState
  } catch {
    throw new HttpError(400, 'invalid state')
  }

  if (!parsed.companyId || !parsed.userId || !parsed.exp || parsed.exp < Date.now()) {
    throw new HttpError(400, 'expired state')
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Integration connection DB helpers (pool-parameterized)
// ---------------------------------------------------------------------------

export async function getIntegrationConnection(
  pool: Pool,
  companyId: string,
  provider: string,
  executor: LedgerExecutor = pool,
) {
  const result = await executor.query(
    `
    select id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    from integration_connections
    where company_id = $1 and provider = $2
    order by created_at desc
    limit 1
    `,
    [companyId, provider],
  )
  return result.rows[0] ?? null
}

export async function getIntegrationConnectionWithSecrets(pool: Pool, companyId: string, provider: string) {
  const result = await pool.query(
    `
    select id, provider, provider_account_id, access_token, refresh_token, webhook_secret, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    from integration_connections
    where company_id = $1 and provider = $2
    order by created_at desc
    limit 1
    `,
    [companyId, provider],
  )
  return result.rows[0] ?? null
}

export async function upsertIntegrationConnection(
  pool: Pool,
  companyId: string,
  provider: string,
  values: {
    provider_account_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
    webhook_secret?: string | null
    sync_cursor?: string | null
    status?: string | null
  },
  executor: LedgerExecutor = pool,
) {
  const existing = await getIntegrationConnection(pool, companyId, provider, executor)
  if (!existing) {
    const inserted = await executor.query(
      `
      insert into integration_connections (
        company_id, provider, provider_account_id, access_token, refresh_token, webhook_secret, sync_cursor, status
      )
      values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'connected'))
      returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
      `,
      [
        companyId,
        provider,
        values.provider_account_id ?? null,
        values.access_token ?? null,
        values.refresh_token ?? null,
        values.webhook_secret ?? null,
        values.sync_cursor ?? null,
        values.status ?? 'connected',
      ],
    )
    return inserted.rows[0]
  }

  const updated = await executor.query(
    `
    update integration_connections
    set
      provider_account_id = coalesce($3, provider_account_id),
      access_token = coalesce($4, access_token),
      refresh_token = coalesce($5, refresh_token),
      webhook_secret = coalesce($6, webhook_secret),
      sync_cursor = coalesce($7, sync_cursor),
      status = coalesce($8, status),
      last_synced_at = coalesce(last_synced_at, now()),
      version = version + 1
    where company_id = $1 and provider = $2 and id = $9
    returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    `,
    [
      companyId,
      provider,
      values.provider_account_id ?? null,
      values.access_token ?? null,
      values.refresh_token ?? null,
      values.webhook_secret ?? null,
      values.sync_cursor ?? null,
      values.status ?? null,
      existing.id,
    ],
  )
  return updated.rows[0] ?? existing
}

// ---------------------------------------------------------------------------
// Integration mapping DB helpers (pool-parameterized)
// ---------------------------------------------------------------------------

export async function listIntegrationMappings(
  pool: Pool,
  companyId: string,
  provider: string,
  entityType?: string | null,
) {
  const filters: string[] = ['company_id = $1', 'provider = $2', 'deleted_at is null']
  const values: unknown[] = [companyId, provider]
  if (entityType) {
    values.push(entityType)
    filters.push(`entity_type = $${values.length}`)
  }
  const result = await pool.query(
    `
    select id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
    from integration_mappings
    where ${filters.join(' and ')}
    order by entity_type asc, created_at asc
    `,
    values,
  )
  return result.rows as IntegrationMappingRow[]
}

export async function upsertIntegrationMapping(
  pool: Pool,
  companyId: string,
  provider: string,
  values: {
    entity_type: string
    local_ref: string
    external_id: string
    label?: string | null
    status?: string | null
    notes?: string | null
  },
  executor: LedgerExecutor = pool,
) {
  const result = await executor.query(
    `
    insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
    values ($1, $2, $3, $4, $5, $6, coalesce($7, 'active'), $8)
    on conflict (company_id, provider, entity_type, local_ref)
    do update set
      external_id = excluded.external_id,
      label = coalesce(excluded.label, integration_mappings.label),
      status = coalesce(excluded.status, integration_mappings.status),
      notes = coalesce(excluded.notes, integration_mappings.notes),
      version = integration_mappings.version + 1,
      updated_at = now(),
      deleted_at = null
    returning id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
    `,
    [
      companyId,
      provider,
      values.entity_type,
      values.local_ref,
      values.external_id,
      values.label ?? null,
      values.status ?? 'active',
      values.notes ?? null,
    ],
  )
  return result.rows[0] as IntegrationMappingRow
}

// ---------------------------------------------------------------------------
// Backfill helpers (pool-parameterized)
// ---------------------------------------------------------------------------

export async function backfillCustomerMapping(
  pool: Pool,
  companyId: string,
  customer: { id: string; external_id: string | null; name: string },
  executor: LedgerExecutor = pool,
) {
  if (!customer.external_id) return null
  const mapping = await upsertIntegrationMapping(
    pool,
    companyId,
    'qbo',
    {
      entity_type: 'customer',
      local_ref: customer.id,
      external_id: customer.external_id,
      label: customer.name,
      status: 'active',
      notes: 'backfilled from customer external_id',
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

export async function backfillServiceItemMapping(
  pool: Pool,
  companyId: string,
  serviceItem: { code: string; name: string; source?: string | null },
  externalId?: string | null,
  executor: LedgerExecutor = pool,
) {
  const resolvedExternalId = externalId ?? (serviceItem.code.startsWith('qbo-') ? serviceItem.code.slice(4) : null)
  if (!resolvedExternalId) return null
  const mapping = await upsertIntegrationMapping(
    pool,
    companyId,
    'qbo',
    {
      entity_type: 'service_item',
      local_ref: serviceItem.code,
      external_id: resolvedExternalId,
      label: serviceItem.name,
      status: 'active',
      notes:
        serviceItem.source === 'qbo'
          ? 'backfilled from qbo service_item import'
          : 'backfilled from qbo-prefixed service_item',
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

export async function backfillDivisionMapping(
  pool: Pool,
  companyId: string,
  division: { code: string; name: string },
  externalId: string,
  executor: LedgerExecutor = pool,
) {
  const mapping = await upsertIntegrationMapping(
    pool,
    companyId,
    'qbo',
    {
      entity_type: 'division',
      local_ref: division.code,
      external_id: externalId,
      label: division.name,
      status: 'active',
      notes: 'backfilled from qbo class sync',
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

export async function backfillProjectMapping(
  pool: Pool,
  companyId: string,
  project: { id: string; name: string },
  externalId: string,
  executor: LedgerExecutor = pool,
) {
  const mapping = await upsertIntegrationMapping(
    pool,
    companyId,
    'qbo',
    {
      entity_type: 'project',
      local_ref: project.id,
      external_id: externalId,
      label: project.name,
      status: 'active',
      notes: 'backfilled from qbo estimate push',
    },
    executor,
  )
  await recordMutationLedger(executor, {
    companyId,
    entityType: 'integration_mapping',
    entityId: mapping.id,
    action: 'upsert',
    row: mapping,
    syncPayload: { action: 'upsert', mapping },
    outboxPayload: mapping as Record<string, unknown>,
    idempotencyKey: `integration_mapping:qbo:${mapping.id}`,
  })
  return mapping
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

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
      const status = error instanceof HttpError ? error.status : 400
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
    const tokenResponse = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
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

  // POST /api/integrations/qbo/sync — full sync (simulated or live)
  if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/sync') {
    if (!requireRole(['admin', 'office'])) return true
    const connection = await getIntegrationConnectionWithSecrets(pool, company.id, 'qbo')
    await upsertIntegrationConnection(pool, company.id, 'qbo', { status: 'syncing' })
    try {
      if (!connection?.access_token) {
        const customersResult = await pool.query(
          'select id, external_id, name from customers where company_id = $1 and deleted_at is null and external_id is not null',
          [company.id],
        )
        const serviceItemsResult = await pool.query(
          "select code, name, source from service_items where company_id = $1 and deleted_at is null and (source = 'qbo' or code like 'qbo-%')",
          [company.id],
        )
        const divisionsResult = await pool.query(
          'select code, name from divisions where company_id = $1 order by sort_order asc',
          [company.id],
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
          const connectionId = connection?.id ?? row.id
          await recordMutationLedger(client, {
            companyId: company.id,
            entityType: 'integration_connection',
            entityId: connectionId,
            action: 'sync',
            syncPayload: {
              action: 'sync',
              provider: 'qbo',
              snapshot: qboSnapshot,
              simulated: true,
            },
            outboxPayload: qboSnapshot,
            idempotencyKey: `integration_connection:qbo:sync:${connectionId}`,
          })
          return row
        })
        sendJson(200, {
          connection: refreshed,
          snapshot: qboSnapshot,
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
        Sentry.captureException(e, { tags: { scope: 'qbo_customers' } })
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
        Sentry.captureException(e, { tags: { scope: 'qbo_items' } })
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
            Sentry.captureException(e, { tags: { scope: 'qbo_items_parse' } })
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
        Sentry.captureException(e, { tags: { scope: 'qbo_classes' } })
      }

      const divisionsResult = await pool.query(
        'select code, name from divisions where company_id = $1 order by sort_order asc',
        [company.id],
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
            Sentry.captureException(e, { tags: { scope: 'qbo_classes_parse' } })
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
        Sentry.captureException(e, { tags: { scope: 'qbo_time_activities' } })
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
        Sentry.captureException(e, { tags: { scope: 'qbo_bills' } })
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
        await recordMutationLedger(client, {
          companyId: company.id,
          entityType: 'integration_connection',
          entityId: connection.id,
          action: 'sync',
          syncPayload: { action: 'sync', provider: 'qbo', snapshot: qboSnapshot },
          outboxPayload: qboSnapshot,
          idempotencyKey: `integration_connection:qbo:sync:${connection.id}`,
        })
        return result.rows[0] ?? connection
      })

      sendJson(200, {
        connection: refreshed,
        snapshot: qboSnapshot,
      })
    } catch (error) {
      logger.error({ err: error, scope: 'qbo_sync' }, 'QBO sync error')
      Sentry.captureException(error, { tags: { scope: 'qbo_sync' } })
      await upsertIntegrationConnection(pool, company.id, 'qbo', { status: 'error' })
      sendJson(500, { error: 'sync failed' })
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

    const accountMappingResult = await pool.query<{ external_id: string }>(
      `select external_id from integration_mappings
       where company_id = $1 and provider = 'qbo'
         and entity_type = 'qbo_account' and local_ref = 'materials'
         and deleted_at is null
       limit 1`,
      [company.id],
    )
    const materialsAccountId = accountMappingResult.rows[0]?.external_id ?? null

    const unsynced = await pool.query<{
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
    )

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
          const mappedVendor = await pool.query<{ external_id: string }>(
            `select external_id from integration_mappings
             where company_id = $1 and provider = 'qbo'
               and entity_type = 'qbo_vendor' and local_ref = $2
               and deleted_at is null
             limit 1`,
            [company.id, displayName],
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
        Sentry.captureException(err, { tags: { scope: 'qbo_material_bill_push' } })
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

    const projectResult = await pool.query(
      'select id, name, customer_name, bid_total from projects where company_id = $1 and id = $2',
      [company.id, projectId],
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
          Sentry.captureException(e, { tags: { scope: 'qbo_push_estimate_parse' } })
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
      Sentry.captureException(error, { tags: { scope: 'qbo_push_estimate' } })
      sendJson(500, { error: 'failed to push estimate to qbo' })
    }
    return true
  }

  return false
}
