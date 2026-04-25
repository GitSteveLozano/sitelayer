import { Sentry } from './instrument.js'
import http from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Pool, type PoolConfig } from 'pg'
import { processQueue as processDatabaseQueue } from '@sitelayer/queue'
import { createLogger, getRequestContext, runWithRequestContext, type RequestContext } from '@sitelayer/logger'
import {
  authorizeDebugTraceRequest,
  DebugTraceError,
  fetchSentryTrace,
  parseTraceIdFromSentryTraceHeader,
} from './debug-trace.js'
import {
  DEFAULT_BONUS_RULE,
  LA_TEMPLATE,
  WORKFLOW_STAGES,
  calculateBonusPayout,
  calculateMargin,
  calculateTakeoffQuantity,
  calculateProjectCost,
  formatMoney,
  normalizePolygonGeometry,
} from '@sitelayer/domain'
import { loadAppConfig, logAppConfigBanner, postgresOptionsForTier, TierConfigError } from './tier.js'
import {
  assertKeyInCompany,
  buildBlueprintStorageKey,
  createBlueprintStorage,
  getBlueprintMimeType,
  readStorageEnv,
  StorageError,
  type BlueprintStorage,
} from './storage.js'
import { recordAudit, isAuditableEntity } from './audit.js'
import { COMPANY_SLUG_PATTERN, seedCompanyDefaults } from './onboarding.js'
import { AuthError, loadAuthConfig, resolveIdentity, type Identity } from './auth.js'
import { attachPool, observeAudit, observeRequest, renderMetrics } from './metrics.js'

const logger = createLogger('api')
const CORS_ALLOW_HEADERS =
  'content-type, authorization, baggage, sentry-trace, traceparent, x-sitelayer-company-id, x-sitelayer-company-slug, x-sitelayer-user-id'

function currentTraceHeaders(): { sentryTrace: string | null; baggage: string | null } {
  try {
    const data = Sentry.getTraceData()
    return {
      sentryTrace: data['sentry-trace'] ?? null,
      baggage: data.baggage ?? null,
    }
  } catch {
    return { sentryTrace: null, baggage: null }
  }
}

const debugRateBuckets = new Map<string, { tokens: number; updatedAt: number }>()
function debugRateLimit(key: string, capacity = 10, refillPerMs = 10 / 60_000): boolean {
  const now = Date.now()
  const current = debugRateBuckets.get(key) ?? { tokens: capacity, updatedAt: now }
  const elapsed = Math.max(0, now - current.updatedAt)
  const tokens = Math.min(capacity, current.tokens + elapsed * refillPerMs)
  if (tokens < 1) {
    debugRateBuckets.set(key, { tokens, updatedAt: now })
    return false
  }
  debugRateBuckets.set(key, { tokens: tokens - 1, updatedAt: now })
  return true
}

async function fetchQueueRowsForTraceOrRequest(params: { traceId?: string; requestId?: string }) {
  const clauses: string[] = []
  const values: unknown[] = []
  if (params.requestId) {
    values.push(params.requestId)
    clauses.push(`request_id = $${values.length}`)
  }
  if (params.traceId) {
    values.push(`%${params.traceId}%`)
    clauses.push(`sentry_trace like $${values.length}`)
  }
  if (!clauses.length) return { outbox: [], syncEvents: [] }
  const where = clauses.join(' or ')
  const outbox = await pool.query(
    `select id, company_id, entity_type, entity_id, mutation_type, status, attempt_count, created_at, applied_at, request_id, sentry_trace
     from mutation_outbox where ${where} order by created_at asc limit 200`,
    values,
  )
  const syncEvents = await pool.query(
    `select id, company_id, entity_type, entity_id, direction, status, attempt_count, created_at, applied_at, request_id, sentry_trace
     from sync_events where ${where} order by created_at asc limit 200`,
    values,
  )
  return { outbox: outbox.rows, syncEvents: syncEvents.rows }
}

let appConfig: ReturnType<typeof loadAppConfig>
try {
  appConfig = loadAppConfig()
  logAppConfigBanner(appConfig)
} catch (err) {
  if (err instanceof TierConfigError) {
    logger.fatal({ err }, '[tier] refusing to start')
    process.exit(1)
  }
  throw err
}

let storage: BlueprintStorage
try {
  storage = await createBlueprintStorage(readStorageEnv(process.env, appConfig.tier))
  logger.info({ backend: storage.backend, bucket: storage.bucket ?? null }, '[storage] ready')
} catch (err) {
  logger.fatal({ err }, '[storage] refusing to start')
  process.exit(1)
}

type ActiveCompany = {
  id: string
  slug: string
  name: string
  created_at: string
}

type IntegrationMappingRow = {
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

type BlueprintDocumentRow = {
  id: string
  project_id: string
  file_name: string
  storage_path: string
  preview_type: string
  calibration_length: string | null
  calibration_unit: string | null
  sheet_scale: string | null
  version: number
  deleted_at: string | null
  replaces_blueprint_document_id: string | null
  file_url: string
  created_at: string
}

const port = Number(process.env.PORT ?? 3001)
const databaseUrl = appConfig.databaseUrl
const databaseSslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
const activeCompanySlug = process.env.ACTIVE_COMPANY_SLUG ?? 'la-operations'
const activeUserId = process.env.ACTIVE_USER_ID ?? 'demo-user'
const authConfig = loadAuthConfig(process.env)
const buildSha = process.env.APP_BUILD_SHA ?? process.env.SENTRY_RELEASE ?? 'unknown'
const startedAt = new Date().toISOString()
const metricsToken = process.env.API_METRICS_TOKEN?.trim() || null
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
const qboClientId = process.env.QBO_CLIENT_ID ?? 'demo'
const qboClientSecret = process.env.QBO_CLIENT_SECRET ?? 'demo'
const qboRedirectUri = process.env.QBO_REDIRECT_URI ?? 'http://localhost:3001/api/integrations/qbo/callback'
const qboSuccessRedirectUri = process.env.QBO_SUCCESS_REDIRECT_URI ?? 'http://localhost:3000/?qbo=connected'
const qboEnvironment = (process.env.QBO_ENVIRONMENT ?? 'sandbox') as 'sandbox' | 'production'
const qboBaseUrl =
  process.env.QBO_BASE_URL ??
  (qboEnvironment === 'sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com')
const qboStateSecret = process.env.QBO_STATE_SECRET ?? qboClientSecret
const maxJsonBodyBytes = Number(process.env.MAX_JSON_BODY_BYTES ?? 20 * 1024 * 1024)

function withTierOptions(config: PoolConfig): PoolConfig {
  return { ...config, options: postgresOptionsForTier(appConfig.tier, config.options || process.env.PGOPTIONS) }
}

function getPoolConfig(connectionString: string): PoolConfig {
  try {
    const url = new URL(connectionString)
    const sslMode = url.searchParams.get('sslmode')
    if (!databaseSslRejectUnauthorized && sslMode && sslMode !== 'disable') {
      url.searchParams.delete('sslmode')
      return withTierOptions({
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: false },
      })
    }
  } catch {
    return withTierOptions({ connectionString })
  }

  return withTierOptions({ connectionString })
}

const pool = new Pool(getPoolConfig(databaseUrl))
attachPool(pool)

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function getCorsOrigin(req: http.IncomingMessage): string {
  const origin = req.headers.origin
  if (!origin) return allowedOrigins[0] ?? '*'
  const originStr = Array.isArray(origin) ? origin[0] : origin
  return allowedOrigins.includes(originStr) ? originStr : (allowedOrigins[0] ?? '*')
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.trim().replace(/[^a-zA-Z0-9._-]+/g, '-')
  return cleaned || 'blueprint.pdf'
}

function getBlueprintFilePath(companyId: string, blueprintId: string, fileName: string): string {
  return buildBlueprintStorageKey(companyId, blueprintId, fileName)
}

function assertBlueprintFilePath(companyId: string, filePath: string): string {
  try {
    return assertKeyInCompany(companyId, filePath)
  } catch (err) {
    if (err instanceof StorageError) throw new HttpError(err.status, err.message)
    throw err
  }
}

function resolveBlueprintStoragePath(
  companyId: string,
  blueprintId: string,
  fileName: string,
  requestedPath?: string | null,
): string {
  const cleanRequested = requestedPath?.trim()
  if (!cleanRequested) return buildBlueprintStorageKey(companyId, blueprintId, fileName)
  return assertBlueprintFilePath(companyId, cleanRequested)
}

async function persistBlueprintFile(
  companyId: string,
  blueprintId: string,
  fileName: string,
  contentsBase64: string,
): Promise<string> {
  const key = buildBlueprintStorageKey(companyId, blueprintId, fileName)
  const source = contentsBase64.includes(',') ? (contentsBase64.split(',', 2)[1] ?? '') : contentsBase64
  await storage.put(key, Buffer.from(source, 'base64'), getBlueprintMimeType(fileName))
  return key
}

async function copyBlueprintFile(
  companyId: string,
  blueprintId: string,
  sourcePath: string,
  fileName: string,
): Promise<string> {
  const sourceKey = assertBlueprintFilePath(companyId, sourcePath)
  const destKey = buildBlueprintStorageKey(companyId, blueprintId, fileName)
  await storage.copy(sourceKey, destKey)
  return destKey
}

async function qboGet<T>(endpoint: string, realmId: string, accessToken: string): Promise<T> {
  const response = await fetch(`${qboBaseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`QBO API error: ${response.status} ${response.statusText}`)
  return response.json() as Promise<T>
}

async function qboPost<T>(endpoint: string, realmId: string, accessToken: string, body: unknown): Promise<T> {
  const response = await fetch(`${qboBaseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`QBO API error: ${response.status} ${response.statusText}`)
  return response.json() as Promise<T>
}

async function getCompany(req?: http.IncomingMessage): Promise<ActiveCompany | null> {
  const headerSlug = req?.headers['x-sitelayer-company-slug']
  const headerId = req?.headers['x-sitelayer-company-id']
  const requestedSlug = Array.isArray(headerSlug) ? headerSlug[0] : headerSlug
  const requestedId = Array.isArray(headerId) ? headerId[0] : headerId

  let company: ActiveCompany | null = null
  if (requestedId) {
    const byId = await pool.query<ActiveCompany>(
      'select id, slug, name, created_at from companies where id = $1 limit 1',
      [requestedId],
    )
    if (byId.rows[0]) company = byId.rows[0]
  }

  if (!company) {
    const companySlug = requestedSlug?.trim() || getCurrentCompanySlug(req)
    const result = await pool.query<ActiveCompany>(
      'select id, slug, name, created_at from companies where slug = $1 limit 1',
      [companySlug],
    )
    company = result.rows[0] ?? null
  }

  if (!company) return null

  // Verify membership
  const userId = getCurrentUserId(req)
  const membership = await pool.query(
    'select role from company_memberships where company_id = $1 and clerk_user_id = $2',
    [company.id, userId],
  )
  if (!membership.rows.length) return null

  return company
}

async function getMemberships(userId: string) {
  const result = await pool.query(
    `
    select cm.id, cm.company_id, cm.clerk_user_id, cm.role, cm.created_at, c.slug, c.name
    from company_memberships cm
    join companies c on c.id = cm.company_id
    where cm.clerk_user_id = $1
    order by c.created_at asc
    `,
    [userId],
  )
  return result.rows
}

function getHeaderValue(req: http.IncomingMessage | undefined, key: string): string | null {
  const value = req?.headers[key]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getCurrentUserId(req?: http.IncomingMessage): string {
  const ctxUser = getRequestContext()?.actorUserId
  if (ctxUser) return ctxUser
  return getHeaderValue(req, 'x-sitelayer-user-id') ?? activeUserId
}

function getCurrentCompanySlug(req?: http.IncomingMessage): string {
  return getHeaderValue(req, 'x-sitelayer-company-slug') ?? activeCompanySlug
}

type QboOAuthState = {
  companyId: string
  userId: string
  exp: number
  nonce: string
}

function signQboStatePayload(payload: string) {
  return createHmac('sha256', qboStateSecret).update(payload).digest('base64url')
}

function isSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function encodeQboState(state: QboOAuthState) {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
  const signature = signQboStatePayload(payload)
  return `${payload}.${signature}`
}

function decodeQboState(rawState: string): QboOAuthState {
  const [payload, signature] = rawState.split('.', 2)
  if (!payload || !signature || !isSafeEqual(signQboStatePayload(payload), signature)) {
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

function sendJson(res: http.ServerResponse, status: number, body: unknown, req?: http.IncomingMessage) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': req ? getCorsOrigin(req) : '*',
    'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
  })
  res.end(JSON.stringify(body, null, 2))
}

function sendRedirect(res: http.ServerResponse, location: string) {
  res.writeHead(303, { location })
  res.end()
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let receivedBytes = 0
    let rejected = false
    req.on('data', (chunk) => {
      if (rejected) return
      const buffer = Buffer.from(chunk)
      receivedBytes += buffer.length
      if (receivedBytes > maxJsonBodyBytes) {
        rejected = true
        reject(new HttpError(413, `request body exceeds ${maxJsonBodyBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (rejected) return
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, any>)
      } catch {
        reject(new HttpError(400, 'invalid JSON body'))
      }
    })
    req.on('error', (error) => {
      if (!rejected) reject(error)
    })
  })
}

async function loadBootstrap(companyId: string) {
  const [
    divisions,
    serviceItems,
    customers,
    projects,
    workers,
    pricingProfiles,
    bonusRules,
    integrations,
    mappings,
    schedules,
    laborEntries,
  ] = await Promise.all([
    pool.query('select code, name, sort_order from divisions where company_id = $1 order by sort_order asc', [
      companyId,
    ]),
    pool.query(
      'select code, name, category, unit, default_rate, source, version from service_items where company_id = $1 and deleted_at is null order by name asc',
      [companyId],
    ),
    pool.query(
      'select id, external_id, name, source, created_at from customers where company_id = $1 and deleted_at is null order by name asc',
      [companyId],
    ),
    pool.query(
      'select id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, version, created_at, updated_at from projects where company_id = $1 order by updated_at desc',
      [companyId],
    ),
    pool.query('select id, name, role, created_at from workers where company_id = $1 order by name asc', [companyId]),
    pool.query(
      'select id, name, is_default, config, version, created_at from pricing_profiles where company_id = $1 order by created_at asc',
      [companyId],
    ),
    pool.query(
      'select id, name, config, is_active, version, created_at from bonus_rules where company_id = $1 order by created_at asc',
      [companyId],
    ),
    pool.query(
      'select id, provider, provider_account_id, sync_cursor, last_synced_at, status, version from integration_connections where company_id = $1 order by created_at asc',
      [companyId],
    ),
    pool.query(
      `
        select id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
        from integration_mappings
        where company_id = $1 and deleted_at is null
        order by entity_type asc, created_at asc
        `,
      [companyId],
    ),
    pool.query(
      'select id, project_id, scheduled_for, crew, status from crew_schedules where company_id = $1 order by scheduled_for desc',
      [companyId],
    ),
    pool.query(
      'select id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, version, deleted_at from labor_entries where company_id = $1 order by occurred_on desc, created_at desc',
      [companyId],
    ),
  ])

  return {
    template: LA_TEMPLATE,
    workflowStages: WORKFLOW_STAGES,
    divisions: divisions.rows,
    serviceItems: serviceItems.rows,
    customers: customers.rows,
    projects: projects.rows,
    workers: workers.rows,
    pricingProfiles: pricingProfiles.rows,
    bonusRules: bonusRules.rows,
    integrations: integrations.rows,
    integrationMappings: mappings.rows,
    schedules: schedules.rows,
    laborEntries: laborEntries.rows,
  }
}

async function recordSyncEvent(
  companyId: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
  integrationConnectionId: string | null = null,
) {
  const { sentryTrace, baggage } = currentTraceHeaders()
  const requestId = getRequestContext()?.requestId ?? null
  await pool.query(
    `
    insert into sync_events (
      company_id, integration_connection_id, direction, entity_type, entity_id, payload, status,
      sentry_trace, sentry_baggage, request_id
    )
    values ($1, $2, 'local', $3, $4, $5::jsonb, 'pending', $6, $7, $8)
    `,
    [
      companyId,
      integrationConnectionId,
      entityType,
      entityId,
      JSON.stringify(payload),
      sentryTrace,
      baggage,
      requestId,
    ],
  )
  if (isAuditableEntity(entityType)) {
    const action = typeof payload.action === 'string' ? payload.action : 'event'
    const after = (payload as Record<string, unknown>)[entityType] ?? payload
    try {
      await recordAudit(pool, {
        companyId,
        entityType,
        entityId,
        action,
        after,
        sentryTrace,
      })
      observeAudit(entityType, action)
    } catch (err) {
      logger.warn({ err, entityType, entityId, action }, 'audit insert failed')
    }
  }
}

async function recordMutationOutbox(
  companyId: string,
  entityType: string,
  entityId: string,
  mutationType: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  deviceId = 'server',
  actorUserId: string | null = null,
) {
  const { sentryTrace, baggage } = currentTraceHeaders()
  const requestId = getRequestContext()?.requestId ?? null
  await pool.query(
    `
    insert into mutation_outbox (
      company_id, device_id, actor_user_id, entity_type, entity_id, mutation_type, payload, idempotency_key, status,
      sentry_trace, sentry_baggage, request_id
    )
    values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'pending', $9, $10, $11)
    on conflict (company_id, idempotency_key) do update
      set payload = excluded.payload,
          status = 'pending',
          attempt_count = mutation_outbox.attempt_count + 1,
          next_attempt_at = now(),
          sentry_trace = excluded.sentry_trace,
          sentry_baggage = excluded.sentry_baggage,
          request_id = excluded.request_id
    `,
    [
      companyId,
      deviceId,
      actorUserId,
      entityType,
      entityId,
      mutationType,
      JSON.stringify(payload),
      idempotencyKey,
      sentryTrace,
      baggage,
      requestId,
    ],
  )
}

async function getIntegrationConnection(companyId: string, provider: string) {
  const result = await pool.query(
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

async function getIntegrationConnectionWithSecrets(companyId: string, provider: string) {
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

async function listIntegrationMappings(companyId: string, provider: string, entityType?: string | null) {
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

async function upsertIntegrationMapping(
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
) {
  const result = await pool.query(
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

async function backfillCustomerMapping(
  companyId: string,
  customer: { id: string; external_id: string | null; name: string },
) {
  if (!customer.external_id) return null
  const mapping = await upsertIntegrationMapping(companyId, 'qbo', {
    entity_type: 'customer',
    local_ref: customer.id,
    external_id: customer.external_id,
    label: customer.name,
    status: 'active',
    notes: 'backfilled from customer external_id',
  })
  await recordSyncEvent(companyId, 'integration_mapping', mapping.id, {
    action: 'upsert',
    mapping,
  })
  await recordMutationOutbox(
    companyId,
    'integration_mapping',
    mapping.id,
    'upsert',
    mapping,
    `integration_mapping:qbo:${mapping.id}`,
  )
  return mapping
}

async function backfillServiceItemMapping(
  companyId: string,
  serviceItem: { code: string; name: string; source?: string | null },
  externalId?: string | null,
) {
  const resolvedExternalId = externalId ?? (serviceItem.code.startsWith('qbo-') ? serviceItem.code.slice(4) : null)
  if (!resolvedExternalId) return null
  const mapping = await upsertIntegrationMapping(companyId, 'qbo', {
    entity_type: 'service_item',
    local_ref: serviceItem.code,
    external_id: resolvedExternalId,
    label: serviceItem.name,
    status: 'active',
    notes:
      serviceItem.source === 'qbo'
        ? 'backfilled from qbo service_item import'
        : 'backfilled from qbo-prefixed service_item',
  })
  await recordSyncEvent(companyId, 'integration_mapping', mapping.id, {
    action: 'upsert',
    mapping,
  })
  await recordMutationOutbox(
    companyId,
    'integration_mapping',
    mapping.id,
    'upsert',
    mapping,
    `integration_mapping:qbo:${mapping.id}`,
  )
  return mapping
}

async function backfillDivisionMapping(
  companyId: string,
  division: { code: string; name: string },
  externalId: string,
) {
  const mapping = await upsertIntegrationMapping(companyId, 'qbo', {
    entity_type: 'division',
    local_ref: division.code,
    external_id: externalId,
    label: division.name,
    status: 'active',
    notes: 'backfilled from qbo class sync',
  })
  await recordSyncEvent(companyId, 'integration_mapping', mapping.id, {
    action: 'upsert',
    mapping,
  })
  await recordMutationOutbox(
    companyId,
    'integration_mapping',
    mapping.id,
    'upsert',
    mapping,
    `integration_mapping:qbo:${mapping.id}`,
  )
  return mapping
}

async function backfillProjectMapping(companyId: string, project: { id: string; name: string }, externalId: string) {
  const mapping = await upsertIntegrationMapping(companyId, 'qbo', {
    entity_type: 'project',
    local_ref: project.id,
    external_id: externalId,
    label: project.name,
    status: 'active',
    notes: 'backfilled from qbo estimate push',
  })
  await recordSyncEvent(companyId, 'integration_mapping', mapping.id, {
    action: 'upsert',
    mapping,
  })
  await recordMutationOutbox(
    companyId,
    'integration_mapping',
    mapping.id,
    'upsert',
    mapping,
    `integration_mapping:qbo:${mapping.id}`,
  )
  return mapping
}

async function upsertIntegrationConnection(
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
) {
  const existing = await getIntegrationConnection(companyId, provider)
  if (!existing) {
    const inserted = await pool.query(
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

  const updated = await pool.query(
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

async function countQueueRows(companyId: string) {
  const [outboxResult, syncResult] = await Promise.all([
    pool.query<{ pending_count: number }>(
      `
      select count(*)::int as pending_count
      from mutation_outbox
      where company_id = $1
        and status in ('pending', 'processing')
      `,
      [companyId],
    ),
    pool.query<{ pending_count: number }>(
      `
      select count(*)::int as pending_count
      from sync_events
      where company_id = $1
        and status in ('pending', 'processing')
      `,
      [companyId],
    ),
  ])
  return {
    pendingOutboxCount: outboxResult.rows[0]?.pending_count ?? 0,
    pendingSyncEventCount: syncResult.rows[0]?.pending_count ?? 0,
  }
}

async function processQueue(companyId: string, limit = 25) {
  return processDatabaseQueue(pool, companyId, limit)
}

async function getSyncStatus(companyId: string) {
  const queue = await countQueueRows(companyId)
  const [connections, latestSyncEvent] = await Promise.all([
    pool.query(
      `
      select id, provider, provider_account_id, sync_cursor, last_synced_at, status, version, created_at
      from integration_connections
      where company_id = $1
      order by created_at asc
      `,
      [companyId],
    ),
    pool.query(
      `
      select created_at, entity_type, entity_id, direction, status, attempt_count, applied_at, error
      from sync_events
      where company_id = $1
      order by created_at desc
      limit 1
      `,
      [companyId],
    ),
  ])

  return {
    ...queue,
    connections: connections.rows,
    latestSyncEvent: latestSyncEvent.rows[0] ?? null,
  }
}

async function summarizeProject(companyId: string, projectId: string) {
  const projectResult = await pool.query(
    'select id, company_id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, version from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const [measurementsResult, estimateLinesResult, laborEntriesResult, materialBillsResult, bonusRuleResult] =
    await Promise.all([
      pool.query(
        'select service_item_code, quantity, unit, notes, created_at from takeoff_measurements where company_id = $1 and project_id = $2 order by created_at asc',
        [companyId, projectId],
      ),
      pool.query(
        'select service_item_code, quantity, unit, rate, amount, created_at from estimate_lines where company_id = $1 and project_id = $2 order by created_at asc',
        [companyId, projectId],
      ),
      pool.query(
        'select service_item_code, hours, sqft_done, status, occurred_on from labor_entries where company_id = $1 and project_id = $2 order by occurred_on desc, created_at desc',
        [companyId, projectId],
      ),
      pool.query(
        'select amount, bill_type from material_bills where company_id = $1 and project_id = $2 and deleted_at is null',
        [companyId, projectId],
      ),
      pool.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [companyId]),
    ])

  const laborCost = laborEntriesResult.rows.reduce(
    (total, entry) => total + Number(entry.hours) * Number(project.labor_rate ?? 0),
    0,
  )
  const materialCost = materialBillsResult.rows
    .filter((b) => b.bill_type !== 'sub')
    .reduce((total, b) => total + Number(b.amount ?? 0), 0)
  const subCost = materialBillsResult.rows
    .filter((b) => b.bill_type === 'sub')
    .reduce((total, b) => total + Number(b.amount ?? 0), 0)
  const totalCost = calculateProjectCost({ laborCost, materialCost, subCost })
  const margin = calculateMargin({ revenue: Number(project.bid_total ?? 0), cost: totalCost })
  const bonusTiers = bonusRuleResult.rows[0]?.config?.tiers ?? DEFAULT_BONUS_RULE.tiers
  const bonus = calculateBonusPayout(margin.margin, Number(project.bonus_pool ?? 0), bonusTiers)
  const totalMeasurementQuantity = measurementsResult.rows.reduce(
    (total, measurement) => total + Number(measurement.quantity),
    0,
  )
  const estimateTotal = estimateLinesResult.rows.reduce((total, line) => total + Number(line.amount), 0)

  return {
    project,
    metrics: {
      totalMeasurementQuantity,
      estimateTotal,
      laborCost,
      materialCost,
      subCost,
      totalCost,
      margin,
      bonus,
    },
    measurements: measurementsResult.rows,
    estimateLines: estimateLinesResult.rows,
    laborEntries: laborEntriesResult.rows,
  }
}

async function listBlueprintDocuments(companyId: string, projectId: string) {
  const result = await pool.query(
    `
    select
      id,
      project_id,
      file_name,
      storage_path,
      preview_type,
      calibration_length,
      calibration_unit,
      sheet_scale,
      version,
      deleted_at,
      replaces_blueprint_document_id,
      concat('/api/blueprints/', id, '/file') as file_url,
      created_at
    from blueprint_documents
    where company_id = $1 and project_id = $2 and deleted_at is null
    order by version desc, created_at desc
    `,
    [companyId, projectId],
  )
  return result.rows as BlueprintDocumentRow[]
}

async function listTakeoffMeasurements(companyId: string, projectId: string) {
  const result = await pool.query(
    `
    select id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, deleted_at, created_at
    from takeoff_measurements
    where company_id = $1 and project_id = $2 and deleted_at is null
    order by created_at desc
    `,
    [companyId, projectId],
  )
  return result.rows
}

async function listSchedules(companyId: string, projectId: string) {
  const result = await pool.query(
    `
    select id, project_id, scheduled_for, crew, status, version, deleted_at, created_at
    from crew_schedules
    where company_id = $1 and project_id = $2 and deleted_at is null
    order by scheduled_for desc, created_at desc
    `,
    [companyId, projectId],
  )
  return result.rows
}

async function createEstimateFromMeasurements(companyId: string, projectId: string) {
  const projectResult = await pool.query(
    'select id, bid_total, labor_rate, bonus_pool from projects where company_id = $1 and id = $2 limit 1',
    [companyId, projectId],
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const [measurementsResult, serviceItemsResult] = await Promise.all([
    pool.query(
      'select service_item_code, quantity, unit, notes from takeoff_measurements where company_id = $1 and project_id = $2 order by created_at asc',
      [companyId, projectId],
    ),
    pool.query('select code, default_rate, unit from service_items where company_id = $1', [companyId]),
  ])

  const itemIndex = new Map<string, { default_rate: string | null; unit: string }>()
  for (const item of serviceItemsResult.rows) {
    itemIndex.set(item.code, { default_rate: item.default_rate, unit: item.unit })
  }

  await pool.query('delete from estimate_lines where company_id = $1 and project_id = $2', [companyId, projectId])

  const createdLines = []
  for (const measurement of measurementsResult.rows) {
    const item = itemIndex.get(measurement.service_item_code)
    const rate = Number(item?.default_rate ?? 0)
    const amount = Number(measurement.quantity) * rate
    const insertResult = await pool.query(
      `
      insert into estimate_lines (company_id, project_id, service_item_code, quantity, unit, rate, amount)
      values ($1, $2, $3, $4, $5, $6, $7)
      returning service_item_code, quantity, unit, rate, amount, created_at
      `,
      [
        companyId,
        projectId,
        measurement.service_item_code,
        measurement.quantity,
        item?.unit ?? measurement.unit,
        rate,
        amount,
      ],
    )
    createdLines.push(insertResult.rows[0])
  }

  const bidTotal = createdLines.reduce((total, line) => total + Number(line.amount), 0)
  await pool.query(
    'update projects set bid_total = $1, updated_at = now(), version = version + 1 where company_id = $2 and id = $3',
    [bidTotal, companyId, projectId],
  )

  return {
    projectId,
    bidTotal,
    lines: createdLines,
  }
}

async function listProjects(companyId: string) {
  const result = await pool.query(
    `
    select
      id, customer_id, name, customer_name, division_code, status, bid_total,
      labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, version, created_at, updated_at
    from projects
    where company_id = $1
    order by updated_at desc
    `,
    [companyId],
  )
  return result.rows
}

async function listCustomers(companyId: string) {
  const result = await pool.query(
    'select id, external_id, name, source, version, deleted_at, created_at from customers where company_id = $1 and deleted_at is null order by name asc',
    [companyId],
  )
  return result.rows
}

async function listWorkers(companyId: string) {
  const result = await pool.query(
    'select id, name, role, version, deleted_at, created_at from workers where company_id = $1 and deleted_at is null order by name asc',
    [companyId],
  )
  return result.rows
}

async function listDivisions(companyId: string) {
  const result = await pool.query(
    'select code, name, sort_order from divisions where company_id = $1 order by sort_order asc',
    [companyId],
  )
  return result.rows
}

async function listPricingProfiles(companyId: string) {
  const result = await pool.query(
    'select id, name, is_default, config, version, created_at from pricing_profiles where company_id = $1 order by created_at asc',
    [companyId],
  )
  return result.rows
}

async function listAuditEvents(
  companyId: string,
  filters: { entityType?: string | null; entityId?: string | null; actorUserId?: string | null; since?: string | null; limit?: number },
) {
  const clauses: string[] = ['company_id = $1']
  const values: unknown[] = [companyId]
  if (filters.entityType) {
    values.push(filters.entityType)
    clauses.push(`entity_type = $${values.length}`)
  }
  if (filters.entityId) {
    values.push(filters.entityId)
    clauses.push(`entity_id = $${values.length}`)
  }
  if (filters.actorUserId) {
    values.push(filters.actorUserId)
    clauses.push(`actor_user_id = $${values.length}`)
  }
  if (filters.since) {
    values.push(filters.since)
    clauses.push(`created_at >= $${values.length}::timestamptz`)
  }
  const limit = Math.max(1, Math.min(1000, filters.limit ?? 200))
  values.push(limit)
  const result = await pool.query(
    `select id, actor_user_id, actor_role, entity_type, entity_id, action, before, after, request_id, sentry_trace, created_at
     from audit_events
     where ${clauses.join(' and ')}
     order by created_at desc
     limit $${values.length}`,
    values,
  )
  return result.rows
}

async function listBonusRules(companyId: string) {
  const result = await pool.query(
    'select id, name, config, is_active, version, created_at from bonus_rules where company_id = $1 order by created_at asc',
    [companyId],
  )
  return result.rows
}

function parseConfigPayload(value: unknown) {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'object') return value as Record<string, unknown>
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    return JSON.parse(trimmed) as Record<string, unknown>
  }
  return {}
}

function isValidDateInput(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function parseExpectedVersion(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function isValidUuid(value: unknown) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

type PreparedTakeoffMeasurementInput = {
  serviceItemCode: string
  quantity: number
  unit: string
  notes: string | null
  geometryJson: string | null
  blueprintDocumentId: string | null
}

function prepareTakeoffMeasurementInput(rawInput: unknown, label = 'measurement'): PreparedTakeoffMeasurementInput {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    throw new HttpError(400, `${label} must be an object`)
  }

  const input = rawInput as Record<string, unknown>
  const serviceItemCode = String(input.service_item_code ?? '').trim()
  const unit = String(input.unit ?? '').trim()
  const notes =
    input.notes === undefined || input.notes === null || String(input.notes).trim() === '' ? null : String(input.notes)
  const blueprintDocumentId =
    input.blueprint_document_id === undefined ||
    input.blueprint_document_id === null ||
    input.blueprint_document_id === ''
      ? null
      : String(input.blueprint_document_id)

  if (!serviceItemCode) {
    throw new HttpError(400, `${label}.service_item_code is required`)
  }
  if (!unit) {
    throw new HttpError(400, `${label}.unit is required`)
  }
  if (blueprintDocumentId && !isValidUuid(blueprintDocumentId)) {
    throw new HttpError(400, `${label}.blueprint_document_id must be a valid uuid`)
  }

  const rawGeometry = input.geometry
  let quantity = Number(input.quantity ?? 0)
  let geometryJson: string | null = null
  if (rawGeometry !== undefined && rawGeometry !== null && rawGeometry !== '') {
    const geometry = normalizePolygonGeometry(rawGeometry)
    if (!geometry) {
      throw new HttpError(400, `${label}.geometry must be a polygon with at least 3 points inside the board`)
    }
    quantity = calculateTakeoffQuantity(geometry.points, geometry.sheet_scale ?? 1)
    if (quantity <= 0) {
      throw new HttpError(400, `${label}.geometry must produce a positive area`)
    }
    geometryJson = JSON.stringify(geometry)
  }

  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new HttpError(400, `${label}.quantity must be a non-negative number`)
  }

  return {
    serviceItemCode,
    quantity,
    unit,
    notes,
    geometryJson,
    blueprintDocumentId,
  }
}

async function assertBlueprintDocumentsBelongToProject(
  companyId: string,
  projectId: string,
  blueprintDocumentIds: Array<string | null>,
) {
  const uniqueIds = Array.from(new Set(blueprintDocumentIds.filter((id): id is string => Boolean(id))))
  if (!uniqueIds.length) return

  const result = await pool.query<{ id: string }>(
    `
    select id
    from blueprint_documents
    where company_id = $1
      and project_id = $2
      and id = any($3::uuid[])
      and deleted_at is null
    `,
    [companyId, projectId, uniqueIds],
  )
  const validIds = new Set(result.rows.map((row) => row.id))
  const invalidIds = uniqueIds.filter((id) => !validIds.has(id))
  if (invalidIds.length) {
    throw new HttpError(400, 'blueprint_document_id must belong to the project')
  }
}

async function listAnalytics(companyId: string) {
  const [projectRows, laborRows, materialRows, bonusRules] = await Promise.all([
    pool.query(
      'select id, name, customer_name, division_code, status, bid_total, labor_rate, bonus_pool from projects where company_id = $1 order by updated_at desc',
      [companyId],
    ),
    pool.query(
      'select project_id, service_item_code, hours, sqft_done, occurred_on from labor_entries where company_id = $1 and deleted_at is null',
      [companyId],
    ),
    pool.query(
      'select project_id, amount, bill_type from material_bills where company_id = $1 and deleted_at is null',
      [companyId],
    ),
    pool.query('select config from bonus_rules where company_id = $1 order by created_at desc limit 1', [companyId]),
  ])

  const bonusTiers = bonusRules.rows[0]?.config?.tiers ?? DEFAULT_BONUS_RULE.tiers
  const laborByProject = new Map<string, typeof laborRows.rows>()
  const materialByProject = new Map<string, typeof materialRows.rows>()

  for (const labor of laborRows.rows) {
    const list = laborByProject.get(labor.project_id) ?? []
    list.push(labor)
    laborByProject.set(labor.project_id, list)
  }

  for (const material of materialRows.rows) {
    const list = materialByProject.get(material.project_id) ?? []
    list.push(material)
    materialByProject.set(material.project_id, list)
  }

  const analytics = projectRows.rows.map((project) => {
    const projectLabor = laborByProject.get(project.id) ?? []
    const projectMaterial = materialByProject.get(project.id) ?? []

    const totalHours = projectLabor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
    const totalSqft = projectLabor.reduce((sum, l) => sum + Number(l.sqft_done ?? 0), 0)
    const laborCost = totalHours * Number(project.labor_rate ?? 0)
    const materialCost = projectMaterial
      .filter((m) => m.bill_type !== 'sub')
      .reduce((sum, m) => sum + Number(m.amount ?? 0), 0)
    const subCost = projectMaterial
      .filter((m) => m.bill_type === 'sub')
      .reduce((sum, m) => sum + Number(m.amount ?? 0), 0)
    const totalCost = laborCost + materialCost + subCost
    const revenue = Number(project.bid_total ?? 0)
    const profit = revenue - totalCost
    const margin = revenue > 0 ? profit / revenue : 0
    const bonus = calculateBonusPayout(margin, Number(project.bonus_pool ?? 0), bonusTiers)
    const sqftPerHr = totalHours > 0 ? totalSqft / totalHours : 0

    return {
      project,
      metrics: {
        totalHours,
        totalSqft,
        laborCost,
        materialCost,
        subCost,
        totalCost,
        revenue,
        profit,
        margin,
        bonus,
        sqftPerHr,
      },
    }
  })

  const byDivision = new Map<string, { revenue: number; cost: number; count: number }>()
  for (const row of analytics) {
    const current = byDivision.get(row.project.division_code) ?? { revenue: 0, cost: 0, count: 0 }
    current.revenue += row.metrics.revenue
    current.cost += row.metrics.totalCost
    current.count += 1
    byDivision.set(row.project.division_code, current)
  }

  return {
    projects: analytics,
    divisions: Array.from(byDivision.entries()).map(([divisionCode, totals]) => ({
      divisionCode,
      revenue: totals.revenue,
      cost: totals.cost,
      profit: totals.revenue - totals.cost,
      margin: totals.revenue > 0 ? ((totals.revenue - totals.cost) / totals.revenue) * 100 : 0,
      count: totals.count,
    })),
  }
}

const server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now()
  const headerRequestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : ''
  const requestId = headerRequestId || randomUUID()
  res.setHeader('x-request-id', requestId)
  const method = req.method ?? 'UNKNOWN'
  let initialRoute = '/'
  try {
    initialRoute = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname
  } catch {
    initialRoute = '/'
  }
  const companySlugHeader =
    typeof req.headers['x-sitelayer-company-slug'] === 'string' ? req.headers['x-sitelayer-company-slug'] : undefined
  const userIdHeader =
    typeof req.headers['x-sitelayer-user-id'] === 'string' ? req.headers['x-sitelayer-user-id'] : undefined
  const requestContext: RequestContext = {
    requestId,
    route: initialRoute,
    method,
    ...(companySlugHeader ? { companySlug: companySlugHeader } : {}),
    ...(userIdHeader ? { userId: userIdHeader } : {}),
  }
  res.on('finish', () => {
    observeRequest(method, requestContext.route ?? initialRoute, res.statusCode || 0, Date.now() - requestStartedAt)
  })

  await runWithRequestContext(requestContext, () =>
    Sentry.withIsolationScope((scope) => {
      scope.setTag('request_id', requestId)
      scope.setTag('route', initialRoute)
      scope.setTag('method', method)
      if (companySlugHeader) scope.setTag('company_slug', companySlugHeader)
      if (userIdHeader) scope.setUser({ id: userIdHeader })
      return Sentry.startSpan(
        {
          name: `${method} ${initialRoute}`,
          op: 'http.server',
          attributes: {
            'http.method': method,
            'http.route': initialRoute,
            request_id: requestId,
            ...(companySlugHeader ? { company_slug: companySlugHeader } : {}),
          },
        },
        async (rootSpan) => {
          try {
            if (!req.url || !req.method) {
              sendJson(res, 400, { error: 'bad request' })
              return
            }

            const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
            rootSpan?.setAttribute('http.route', url.pathname)

            if (req.method === 'OPTIONS') {
              res.writeHead(204, {
                'access-control-allow-origin': getCorsOrigin(req),
                'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
                'access-control-allow-headers': CORS_ALLOW_HEADERS,
              })
              res.end()
              return
            }

            if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
              const probe = await Promise.race([
                pool
                  .query('select 1 as ok')
                  .then(() => ({ db: 'healthy' as const, error: null as string | null }))
                  .catch((err) => ({
                    db: 'down' as const,
                    error: err instanceof Error ? err.message : String(err),
                  })),
                new Promise<{ db: 'timeout'; error: string }>((resolve) =>
                  setTimeout(() => resolve({ db: 'timeout', error: 'db probe exceeded 2s' }), 2000),
                ),
              ])
              const ok = probe.db === 'healthy'
              const status = ok ? 200 : 503
              if (req.method === 'HEAD') {
                res.writeHead(status, {
                  'content-type': 'application/json; charset=utf-8',
                  'access-control-allow-origin': getCorsOrigin(req),
                  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
                  'access-control-allow-headers': CORS_ALLOW_HEADERS,
                })
                res.end()
                return
              }
              sendJson(res, status, {
                ok,
                service: 'api',
                tier: appConfig.tier,
                build_sha: buildSha,
                started_at: startedAt,
                db: probe,
                money: formatMoney(1234.56),
              })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/version') {
              sendJson(res, 200, {
                service: 'api',
                tier: appConfig.tier,
                build_sha: buildSha,
                started_at: startedAt,
                node_version: process.version,
              })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/metrics') {
              if (metricsToken) {
                const header = req.headers['authorization']
                const value = Array.isArray(header) ? header[0] : header
                const presented = value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null
                if (!presented || presented !== metricsToken) {
                  res.setHeader('www-authenticate', 'Bearer realm="sitelayer-metrics"')
                  sendJson(res, 401, { error: 'metrics token required' })
                  return
                }
              }
              const { contentType, body } = await renderMetrics()
              res.writeHead(200, {
                'content-type': contentType,
                'access-control-allow-origin': getCorsOrigin(req),
              })
              res.end(body)
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/features') {
              sendJson(res, 200, {
                tier: appConfig.tier,
                flags: Array.from(appConfig.flags).sort(),
                ribbon: appConfig.ribbon,
              })
              return
            }

            const isPublicPath = url.pathname === '/api/integrations/qbo/callback'
            let identity: Identity
            try {
              identity = isPublicPath
                ? { userId: 'qbo-oauth-redirect', source: 'default' }
                : resolveIdentity(req, authConfig)
            } catch (err) {
              if (err instanceof AuthError) {
                if (err.status === 401) {
                  res.setHeader('www-authenticate', 'Bearer realm="sitelayer"')
                }
                sendJson(res, err.status, { error: err.message, request_id: requestId })
                return
              }
              throw err
            }
            requestContext.actorUserId = identity.userId
            scope.setUser({ id: identity.userId })
            scope.setTag('auth_source', identity.source)

            if (req.method === 'GET' && url.pathname === '/api/companies') {
              const memberships = await getMemberships(identity.userId)
              const companies = memberships.map((m) => ({
                id: m.company_id,
                slug: m.slug,
                name: m.name,
                created_at: m.created_at,
                role: m.role,
              }))
              sendJson(res, 200, { companies })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/companies') {
              const body = await readBody(req)
              const slug = String(body.slug ?? '')
                .trim()
                .toLowerCase()
              const name = String(body.name ?? '').trim()
              if (!slug || !COMPANY_SLUG_PATTERN.test(slug)) {
                sendJson(res, 400, { error: 'slug must be 2-64 chars, lowercase letters/digits/dashes' })
                return
              }
              if (!name) {
                sendJson(res, 400, { error: 'name is required' })
                return
              }
              const seedDefaults = body.seed_defaults !== false
              const client = await pool.connect()
              try {
                await client.query('begin')
                const existing = await client.query('select id from companies where slug = $1 limit 1', [slug])
                if (existing.rows[0]) {
                  await client.query('rollback')
                  sendJson(res, 409, { error: 'slug already in use' })
                  return
                }
                const created = await client.query<{ id: string; slug: string; name: string; created_at: string }>(
                  `insert into companies (slug, name) values ($1, $2)
                   returning id, slug, name, created_at`,
                  [slug, name],
                )
                const newCompany = created.rows[0]!
                await client.query(
                  `insert into company_memberships (company_id, clerk_user_id, role)
                   values ($1, $2, 'admin')`,
                  [newCompany.id, identity.userId],
                )
                if (seedDefaults) {
                  await seedCompanyDefaults(client, newCompany.id)
                }
                await client.query('commit')
                await recordAudit(pool, {
                  companyId: newCompany.id,
                  actorUserId: identity.userId,
                  entityType: 'company',
                  entityId: newCompany.id,
                  action: 'create',
                  after: newCompany,
                })
                observeAudit('company', 'create')
                sendJson(res, 201, { company: newCompany, role: 'admin' })
              } catch (err) {
                await client.query('rollback').catch(() => {})
                throw err
              } finally {
                client.release()
              }
              return
            }

            const companyMembershipMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/memberships$/)
            if (req.method === 'POST' && companyMembershipMatch) {
              const targetCompanyId = companyMembershipMatch[1]!
              const adminCheck = await pool.query<{ role: string }>(
                'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
                [targetCompanyId, identity.userId],
              )
              if (!adminCheck.rows[0] || adminCheck.rows[0].role !== 'admin') {
                sendJson(res, 403, { error: 'admin role required' })
                return
              }
              const body = await readBody(req)
              const inviteUserId = String(body.clerk_user_id ?? body.user_id ?? '').trim()
              const role = String(body.role ?? 'member').trim() || 'member'
              if (!inviteUserId) {
                sendJson(res, 400, { error: 'clerk_user_id is required' })
                return
              }
              if (!['admin', 'member', 'foreman', 'office'].includes(role)) {
                sendJson(res, 400, { error: 'role must be admin, member, foreman, or office' })
                return
              }
              const inserted = await pool.query<{
                id: string
                company_id: string
                clerk_user_id: string
                role: string
                created_at: string
              }>(
                `insert into company_memberships (company_id, clerk_user_id, role)
                 values ($1, $2, $3)
                 on conflict (company_id, clerk_user_id) do update set role = excluded.role
                 returning id, company_id, clerk_user_id, role, created_at`,
                [targetCompanyId, inviteUserId, role],
              )
              const membership = inserted.rows[0]!
              await recordAudit(pool, {
                companyId: targetCompanyId,
                actorUserId: identity.userId,
                entityType: 'company_membership',
                entityId: membership.id,
                action: 'upsert',
                after: membership,
              })
              observeAudit('company_membership', 'upsert')
              sendJson(res, 201, { membership })
              return
            }

            const company = await getCompany(req)
            if (!company) {
              sendJson(res, 404, { error: `company slug ${activeCompanySlug} not found` })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
              const bootstrap = await loadBootstrap(company.id)
              sendJson(res, 200, { company, ...bootstrap })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/spec') {
              sendJson(res, 200, {
                product: 'Sitelayer',
                company,
                workflow: WORKFLOW_STAGES,
              })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/session') {
              const userId = getCurrentUserId(req)
              const membershipRows = await getMemberships(userId)
              sendJson(res, 200, {
                user: { id: userId, role: membershipRows[0]?.role ?? 'admin' },
                activeCompany: company,
                memberships: membershipRows,
              })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/projects') {
              sendJson(res, 200, { projects: await listProjects(company.id) })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/customers') {
              sendJson(res, 200, { customers: await listCustomers(company.id) })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/workers') {
              sendJson(res, 200, { workers: await listWorkers(company.id) })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/divisions') {
              sendJson(res, 200, { divisions: await listDivisions(company.id) })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/pricing-profiles') {
              sendJson(res, 200, { pricingProfiles: await listPricingProfiles(company.id) })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/bonus-rules') {
              sendJson(res, 200, { bonusRules: await listBonusRules(company.id) })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/audit-events') {
              const adminCheck = await pool.query<{ role: string }>(
                'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
                [company.id, identity.userId],
              )
              if (!adminCheck.rows[0] || adminCheck.rows[0].role !== 'admin') {
                sendJson(res, 403, { error: 'admin role required' })
                return
              }
              const limitParam = url.searchParams.get('limit')
              const events = await listAuditEvents(company.id, {
                entityType: url.searchParams.get('entity_type'),
                entityId: url.searchParams.get('entity_id'),
                actorUserId: url.searchParams.get('actor_user_id'),
                since: url.searchParams.get('since'),
                ...(limitParam ? { limit: Number(limitParam) } : {}),
              })
              sendJson(res, 200, { events })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/integrations/qbo/mappings') {
              const entityType = url.searchParams.get('entity_type')
              sendJson(res, 200, { mappings: await listIntegrationMappings(company.id, 'qbo', entityType) })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/sync/status') {
              sendJson(res, 200, {
                company,
                ...(await getSyncStatus(company.id)),
              })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/sync/process') {
              const body = await readBody(req)
              const limit = Math.max(1, Math.min(100, Number(body.limit ?? 25)))
              sendJson(res, 200, await processQueue(company.id, limit))
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/integrations/qbo/auth') {
              const state = encodeQboState({
                companyId: company.id,
                userId: getCurrentUserId(req),
                exp: Date.now() + 10 * 60 * 1000,
                nonce: randomUUID(),
              })
              const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(qboClientId)}&redirect_uri=${encodeURIComponent(qboRedirectUri)}&response_type=code&scope=com.intuit.quickbooks.accounting&state=${encodeURIComponent(state)}`
              sendJson(res, 200, { authUrl })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/integrations/qbo/callback') {
              const code = url.searchParams.get('code')
              const realmId = url.searchParams.get('realmId')
              const state = url.searchParams.get('state')
              if (!code || !realmId || !state) {
                sendJson(res, 400, { error: 'missing code, realmId, or state' })
                return
              }
              let stateData: QboOAuthState
              try {
                stateData = decodeQboState(state)
              } catch (error) {
                const status = error instanceof HttpError ? error.status : 400
                sendJson(res, status, { error: error instanceof Error ? error.message : 'invalid state' })
                return
              }
              const stateMembership = await pool.query(
                'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
                [stateData.companyId, stateData.userId],
              )
              if (!stateMembership.rows.length) {
                sendJson(res, 403, { error: 'state user is not a member of this company' })
                return
              }
              const auth = Buffer.from(`${qboClientId}:${qboClientSecret}`).toString('base64')
              const tokenResponse = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: `Basic ${auth}`,
                },
                body: new URLSearchParams({
                  grant_type: 'authorization_code',
                  code,
                  redirect_uri: qboRedirectUri,
                }).toString(),
              })
              if (!tokenResponse.ok) {
                sendJson(res, 400, { error: 'token exchange failed' })
                return
              }
              const tokenData = (await tokenResponse.json()) as {
                access_token: string
                refresh_token: string
                expires_in: number
              }
              const connection = await upsertIntegrationConnection(stateData.companyId, 'qbo', {
                provider_account_id: realmId,
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                status: 'connected',
              })
              await recordSyncEvent(stateData.companyId, 'integration_connection', connection.id, {
                action: 'oauth_connect',
                provider: 'qbo',
              })
              if (qboSuccessRedirectUri) {
                sendRedirect(res, qboSuccessRedirectUri)
                return
              }
              sendJson(res, 200, { connection, success: true })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/integrations/qbo') {
              const connection = await getIntegrationConnection(company.id, 'qbo')
              sendJson(res, 200, {
                connection,
                status: await getSyncStatus(company.id),
              })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/mappings') {
              const body = await readBody(req)
              const entityType = String(body.entity_type ?? '').trim()
              const localRef = String(body.local_ref ?? '').trim()
              const externalId = String(body.external_id ?? '').trim()
              if (!entityType || !localRef || !externalId) {
                sendJson(res, 400, { error: 'entity_type, local_ref, and external_id are required' })
                return
              }
              const mapping = await upsertIntegrationMapping(company.id, 'qbo', {
                entity_type: entityType,
                local_ref: localRef,
                external_id: externalId,
                label: body.label ? String(body.label).trim() : null,
                status: body.status ? String(body.status).trim() : 'active',
                notes: body.notes ? String(body.notes).trim() : null,
              })
              await recordSyncEvent(company.id, 'integration_mapping', mapping.id, {
                action: 'upsert',
                mapping,
              })
              await recordMutationOutbox(
                company.id,
                'integration_mapping',
                mapping.id,
                'upsert',
                mapping,
                `integration_mapping:qbo:${mapping.id}`,
              )
              sendJson(res, 201, mapping)
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/integrations\/qbo\/mappings\/[^/]+$/)) {
              const mappingId = url.pathname.split('/')[5] ?? ''
              if (!mappingId) {
                sendJson(res, 400, { error: 'mapping id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update integration_mappings
        set
          entity_type = coalesce($3, entity_type),
          local_ref = coalesce($4, local_ref),
          external_id = coalesce($5, external_id),
          label = coalesce($6, label),
          status = coalesce($7, status),
          notes = coalesce($8, notes),
          version = version + 1,
          updated_at = now(),
          deleted_at = null
        where company_id = $1 and provider = 'qbo' and id = $2 and deleted_at is null and ($9::int is null or version = $9)
        returning id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
        `,
                [
                  company.id,
                  mappingId,
                  body.entity_type ?? null,
                  body.local_ref ?? null,
                  body.external_id ?? null,
                  body.label ?? null,
                  body.status ?? null,
                  body.notes ?? null,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version, deleted_at from integration_mappings where company_id = $1 and provider = $2 and id = $3',
                  [company.id, 'qbo', mappingId],
                )
                const current = existing.rows[0]
                if (
                  current &&
                  !current.deleted_at &&
                  expectedVersion !== null &&
                  Number(current.version) !== expectedVersion
                ) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'mapping not found' })
                return
              }
              await recordSyncEvent(company.id, 'integration_mapping', mappingId, {
                action: 'update',
                mapping: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'integration_mapping',
                mappingId,
                'update',
                result.rows[0],
                `integration_mapping:qbo:update:${mappingId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/integrations\/qbo\/mappings\/[^/]+$/)) {
              const mappingId = url.pathname.split('/')[5] ?? ''
              if (!mappingId) {
                sendJson(res, 400, { error: 'mapping id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update integration_mappings
        set deleted_at = now(), version = version + 1, status = 'deleted', updated_at = now()
        where company_id = $1 and provider = 'qbo' and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, provider, entity_type, local_ref, external_id, label, status, notes, version, deleted_at, created_at, updated_at
        `,
                [company.id, mappingId, expectedVersion],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version, deleted_at from integration_mappings where company_id = $1 and provider = $2 and id = $3',
                  [company.id, 'qbo', mappingId],
                )
                const current = existing.rows[0]
                if (
                  current &&
                  !current.deleted_at &&
                  expectedVersion !== null &&
                  Number(current.version) !== expectedVersion
                ) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'mapping not found' })
                return
              }
              await recordSyncEvent(company.id, 'integration_mapping', mappingId, {
                action: 'delete',
                mapping: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'integration_mapping',
                mappingId,
                'delete',
                result.rows[0],
                `integration_mapping:qbo:delete:${mappingId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/integrations/qbo') {
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const currentConnection = await getIntegrationConnection(company.id, 'qbo')
              if (
                currentConnection &&
                expectedVersion !== null &&
                Number(currentConnection.version) !== expectedVersion
              ) {
                sendJson(res, 409, { error: 'version conflict', current_version: Number(currentConnection.version) })
                return
              }
              const connection = await upsertIntegrationConnection(company.id, 'qbo', {
                provider_account_id: body.provider_account_id ?? null,
                access_token: body.access_token ?? null,
                refresh_token: body.refresh_token ?? null,
                webhook_secret: body.webhook_secret ?? null,
                sync_cursor: body.sync_cursor ?? null,
                status: body.status ?? 'connected',
              })
              await recordSyncEvent(company.id, 'integration_connection', connection.id, {
                action: currentConnection ? 'upsert' : 'create',
                provider: 'qbo',
                connection,
              })
              await recordMutationOutbox(
                company.id,
                'integration_connection',
                connection.id,
                'upsert',
                connection,
                `integration_connection:qbo:${connection.id}`,
              )
              sendJson(res, 200, { connection })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/integrations/qbo/sync') {
              const connection = await getIntegrationConnectionWithSecrets(company.id, 'qbo')
              await upsertIntegrationConnection(company.id, 'qbo', { status: 'syncing' })
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
                  for (const row of customersResult.rows) {
                    const customer = row as { id: string; external_id: string; name: string }
                    await backfillCustomerMapping(company.id, customer)
                  }
                  for (const row of serviceItemsResult.rows) {
                    const serviceItem = row as { code: string; name: string; source?: string | null }
                    await backfillServiceItemMapping(
                      company.id,
                      serviceItem,
                      serviceItem.code.startsWith('qbo-') ? serviceItem.code.slice(4) : null,
                    )
                  }
                  for (const row of divisionsResult.rows) {
                    const division = row as { code: string; name: string }
                    await backfillDivisionMapping(company.id, division, division.code)
                  }
                  const refreshedConnection = await pool.query(
                    `
            update integration_connections
            set sync_cursor = $2, last_synced_at = now(), status = 'connected', version = version + 1
            where company_id = $1 and provider = 'qbo'
            returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
            `,
                    [company.id, new Date().toISOString()],
                  )
                  await recordSyncEvent(
                    company.id,
                    'integration_connection',
                    connection?.id ?? refreshedConnection.rows[0].id,
                    {
                      action: 'sync',
                      provider: 'qbo',
                      snapshot: qboSnapshot,
                      simulated: true,
                    },
                  )
                  await recordMutationOutbox(
                    company.id,
                    'integration_connection',
                    connection?.id ?? refreshedConnection.rows[0].id,
                    'sync',
                    qboSnapshot,
                    `integration_connection:qbo:sync:${connection?.id ?? refreshedConnection.rows[0].id}`,
                  )
                  sendJson(res, 200, {
                    connection: refreshedConnection.rows[0],
                    snapshot: qboSnapshot,
                  })
                  return
                }
                const realmId = connection.provider_account_id ?? ''
                const accessToken = connection.access_token ?? ''

                // Fetch customers from QBO
                let qboCustomers: { id: string; displayName: string }[] = []
                try {
                  const customerResponse = (await qboGet<{ QueryResponse: { Customer?: unknown[] } }>(
                    `/query?query=${encodeURIComponent('SELECT * FROM Customer')}`,
                    realmId,
                    accessToken,
                  )) as any
                  qboCustomers = customerResponse.QueryResponse?.Customer ?? []
                } catch (e) {
                  logger.error({ err: e, scope: 'qbo_customers' }, 'Failed to sync customers from QBO')
                  Sentry.captureException(e, { tags: { scope: 'qbo_customers' } })
                }

                // Upsert QBO customers into local database
                const syncedCustomers: string[] = []
                for (const qboCustomer of qboCustomers) {
                  const name = (qboCustomer as any).displayName ?? (qboCustomer as any).id
                  const customerResult = await pool.query(
                    `
            insert into customers (company_id, external_id, name, source)
            values ($1, $2, $3, 'qbo')
            on conflict (company_id, external_id) do update set name = $3, updated_at = now()
            returning id, external_id, name, source, version, deleted_at, created_at
            `,
                    [company.id, (qboCustomer as any).id, name],
                  )
                  await upsertIntegrationMapping(company.id, 'qbo', {
                    entity_type: 'customer',
                    local_ref: customerResult.rows[0].id,
                    external_id: String((qboCustomer as any).id),
                    label: name,
                    status: 'active',
                    notes: 'synced from qbo customer import',
                  })
                  syncedCustomers.push((qboCustomer as any).id)
                }

                // Fetch items from QBO
                let qboItems: { id: string; name: string; unitPrice?: number }[] = []
                try {
                  const itemResponse = (await qboGet<{ QueryResponse: { Item?: unknown[] } }>(
                    `/query?query=${encodeURIComponent("SELECT * FROM Item WHERE Type IN ('Service', 'Inventory')")}`,
                    realmId,
                    accessToken,
                  )) as any
                  qboItems = itemResponse.QueryResponse?.Item ?? []
                } catch (e) {
                  logger.error({ err: e, scope: 'qbo_items' }, 'Failed to sync items from QBO')
                  Sentry.captureException(e, { tags: { scope: 'qbo_items' } })
                }

                // Upsert QBO items into local service_items
                const syncedItems: string[] = []
                for (const qboItem of qboItems) {
                  const code = `qbo-${(qboItem as any).id}`
                  const name = (qboItem as any).name ?? code
                  const rate = (qboItem as any).unitPrice ?? 0
                  const itemResult = await pool.query(
                    `
            insert into service_items (company_id, code, name, default_rate, category, unit, source)
            values ($1, $2, $3, $4, 'accounting', 'ea', 'qbo')
            on conflict (company_id, code) do update set name = $3, default_rate = $4, source = 'qbo', updated_at = now()
            returning code, name, category, unit, default_rate, source, created_at
            `,
                    [company.id, code, name, rate],
                  )
                  await backfillServiceItemMapping(company.id, itemResult.rows[0], String((qboItem as any).id))
                  syncedItems.push(code)
                }

                // Fetch classes from QBO and backfill division mappings by name match.
                let qboClasses: { id: string; name: string }[] = []
                try {
                  const classResponse = (await qboGet<{ QueryResponse: { Class?: unknown[] } }>(
                    `/query?query=${encodeURIComponent('SELECT * FROM Class')}`,
                    realmId,
                    accessToken,
                  )) as any
                  qboClasses = classResponse.QueryResponse?.Class ?? []
                } catch (e) {
                  logger.error({ err: e, scope: 'qbo_classes' }, 'Failed to sync classes from QBO')
                  Sentry.captureException(e, { tags: { scope: 'qbo_classes' } })
                }

                const divisionsResult = await pool.query(
                  'select code, name from divisions where company_id = $1 order by sort_order asc',
                  [company.id],
                )
                const syncedDivisions: string[] = []
                for (const qboClass of qboClasses) {
                  const className = String((qboClass as any).name ?? (qboClass as any).Name ?? '').trim()
                  const classId = String((qboClass as any).id ?? (qboClass as any).Id ?? '').trim()
                  if (!className || !classId) continue
                  const division = divisionsResult.rows.find(
                    (row) =>
                      row.name.toLowerCase() === className.toLowerCase() ||
                      row.code.toLowerCase() === className.toLowerCase(),
                  )
                  if (!division) continue
                  await backfillDivisionMapping(company.id, division, classId)
                  syncedDivisions.push(division.code)
                }

                const qboSnapshot = {
                  syncedCustomers: syncedCustomers.length,
                  syncedItems: syncedItems.length,
                  syncedDivisions: syncedDivisions.length,
                }

                const refreshedConnection = await pool.query(
                  `
          update integration_connections
          set sync_cursor = $2, last_synced_at = now(), status = 'connected', version = version + 1
          where company_id = $1 and provider = 'qbo'
          returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
          `,
                  [company.id, new Date().toISOString()],
                )

                await recordSyncEvent(company.id, 'integration_connection', connection.id, {
                  action: 'sync',
                  provider: 'qbo',
                  snapshot: qboSnapshot,
                })
                await recordMutationOutbox(
                  company.id,
                  'integration_connection',
                  connection.id,
                  'sync',
                  qboSnapshot,
                  `integration_connection:qbo:sync:${connection.id}`,
                )

                sendJson(res, 200, {
                  connection: refreshedConnection.rows[0] ?? connection,
                  snapshot: qboSnapshot,
                })
              } catch (error) {
                logger.error({ err: error, scope: 'qbo_sync' }, 'QBO sync error')
                Sentry.captureException(error, { tags: { scope: 'qbo_sync' } })
                await upsertIntegrationConnection(company.id, 'qbo', { status: 'error' })
                sendJson(res, 500, { error: 'sync failed' })
              }
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/pricing-profiles') {
              const body = await readBody(req)
              const name = String(body.name ?? '').trim()
              if (!name) {
                sendJson(res, 400, { error: 'name is required' })
                return
              }
              let config: Record<string, unknown>
              try {
                config = parseConfigPayload(body.config ?? body.config_json)
              } catch {
                sendJson(res, 400, { error: 'config must be valid json' })
                return
              }
              if (body.is_default) {
                await pool.query('update pricing_profiles set is_default = false where company_id = $1', [company.id])
              }
              const result = await pool.query(
                `
        insert into pricing_profiles (company_id, name, is_default, config, version)
        values ($1, $2, coalesce($3, false), $4::jsonb, 1)
        returning id, name, is_default, config, version, created_at
        `,
                [company.id, name, body.is_default ?? false, JSON.stringify(config)],
              )
              await recordSyncEvent(company.id, 'pricing_profile', result.rows[0].id, {
                action: 'create',
                pricingProfile: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'pricing_profile',
                result.rows[0].id,
                'create',
                result.rows[0],
                `pricing_profile:create:${result.rows[0].id}`,
              )
              sendJson(res, 201, result.rows[0])
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/pricing-profiles\/[^/]+$/)) {
              const pricingProfileId = url.pathname.split('/')[3] ?? ''
              if (!pricingProfileId) {
                sendJson(res, 400, { error: 'pricing profile id is required' })
                return
              }
              const body = await readBody(req)
              let config: Record<string, unknown> | null = null
              if (body.config !== undefined || body.config_json !== undefined) {
                try {
                  config = parseConfigPayload(body.config ?? body.config_json)
                } catch {
                  sendJson(res, 400, { error: 'config must be valid json' })
                  return
                }
              }
              if (body.is_default) {
                await pool.query('update pricing_profiles set is_default = false where company_id = $1 and id <> $2', [
                  company.id,
                  pricingProfileId,
                ])
              }
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update pricing_profiles
        set
          name = coalesce($3, name),
          is_default = coalesce($4, is_default),
          config = coalesce($5::jsonb, config),
          version = version + 1
        where company_id = $1 and id = $2 and ($6::int is null or version = $6)
        returning id, name, is_default, config, version, created_at
        `,
                [
                  company.id,
                  pricingProfileId,
                  body.name ?? null,
                  body.is_default ?? null,
                  config ? JSON.stringify(config) : null,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from pricing_profiles where company_id = $1 and id = $2',
                  [company.id, pricingProfileId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'pricing profile not found' })
                return
              }
              await recordSyncEvent(company.id, 'pricing_profile', pricingProfileId, {
                action: 'update',
                pricingProfile: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'pricing_profile',
                pricingProfileId,
                'update',
                result.rows[0],
                `pricing_profile:update:${pricingProfileId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/pricing-profiles\/[^/]+$/)) {
              const pricingProfileId = url.pathname.split('/')[3] ?? ''
              if (!pricingProfileId) {
                sendJson(res, 400, { error: 'pricing profile id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                'delete from pricing_profiles where company_id = $1 and id = $2 and ($3::int is null or version = $3) returning id, name, is_default, config, version, created_at',
                [company.id, pricingProfileId, expectedVersion],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from pricing_profiles where company_id = $1 and id = $2',
                  [company.id, pricingProfileId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'pricing profile not found' })
                return
              }
              await recordSyncEvent(company.id, 'pricing_profile', pricingProfileId, {
                action: 'delete',
                pricingProfile: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'pricing_profile',
                pricingProfileId,
                'delete',
                result.rows[0],
                `pricing_profile:delete:${pricingProfileId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/bonus-rules') {
              const body = await readBody(req)
              const name = String(body.name ?? '').trim()
              if (!name) {
                sendJson(res, 400, { error: 'name is required' })
                return
              }
              let config: Record<string, unknown>
              try {
                config = parseConfigPayload(body.config ?? body.config_json)
              } catch {
                sendJson(res, 400, { error: 'config must be valid json' })
                return
              }
              const result = await pool.query(
                `
        insert into bonus_rules (company_id, name, config, is_active, version)
        values ($1, $2, $3::jsonb, coalesce($4, true), 1)
        returning id, name, config, is_active, version, created_at
        `,
                [company.id, name, JSON.stringify(config), body.is_active ?? true],
              )
              await recordSyncEvent(company.id, 'bonus_rule', result.rows[0].id, {
                action: 'create',
                bonusRule: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'bonus_rule',
                result.rows[0].id,
                'create',
                result.rows[0],
                `bonus_rule:create:${result.rows[0].id}`,
              )
              sendJson(res, 201, result.rows[0])
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/bonus-rules\/[^/]+$/)) {
              const bonusRuleId = url.pathname.split('/')[3] ?? ''
              if (!bonusRuleId) {
                sendJson(res, 400, { error: 'bonus rule id is required' })
                return
              }
              const body = await readBody(req)
              let config: Record<string, unknown> | null = null
              if (body.config !== undefined || body.config_json !== undefined) {
                try {
                  config = parseConfigPayload(body.config ?? body.config_json)
                } catch {
                  sendJson(res, 400, { error: 'config must be valid json' })
                  return
                }
              }
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update bonus_rules
        set
          name = coalesce($3, name),
          config = coalesce($4::jsonb, config),
          is_active = coalesce($5, is_active),
          version = version + 1
        where company_id = $1 and id = $2 and ($6::int is null or version = $6)
        returning id, name, config, is_active, version, created_at
        `,
                [
                  company.id,
                  bonusRuleId,
                  body.name ?? null,
                  config ? JSON.stringify(config) : null,
                  body.is_active ?? null,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query('select version from bonus_rules where company_id = $1 and id = $2', [
                  company.id,
                  bonusRuleId,
                ])
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'bonus rule not found' })
                return
              }
              await recordSyncEvent(company.id, 'bonus_rule', bonusRuleId, {
                action: 'update',
                bonusRule: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'bonus_rule',
                bonusRuleId,
                'update',
                result.rows[0],
                `bonus_rule:update:${bonusRuleId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/bonus-rules\/[^/]+$/)) {
              const bonusRuleId = url.pathname.split('/')[3] ?? ''
              if (!bonusRuleId) {
                sendJson(res, 400, { error: 'bonus rule id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                'delete from bonus_rules where company_id = $1 and id = $2 and ($3::int is null or version = $3) returning id, name, config, is_active, version, created_at',
                [company.id, bonusRuleId, expectedVersion],
              )
              if (!result.rows[0]) {
                const existing = await pool.query('select version from bonus_rules where company_id = $1 and id = $2', [
                  company.id,
                  bonusRuleId,
                ])
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'bonus rule not found' })
                return
              }
              await recordSyncEvent(company.id, 'bonus_rule', bonusRuleId, {
                action: 'delete',
                bonusRule: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'bonus_rule',
                bonusRuleId,
                'delete',
                result.rows[0],
                `bonus_rule:delete:${bonusRuleId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/sync/events') {
              const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 25)))
              const result = await pool.query(
                `
        select id, integration_connection_id, direction, entity_type, entity_id, payload, status, attempt_count, next_attempt_at, applied_at, error, created_at
        from sync_events
        where company_id = $1
        order by created_at desc
        limit $2
        `,
                [company.id, limit],
              )
              sendJson(res, 200, { events: result.rows })
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/sync/outbox') {
              const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 25)))
              const result = await pool.query(
                `
        select
          id, device_id, actor_user_id, entity_type, entity_id, mutation_type, payload,
          idempotency_key, status, attempt_count, next_attempt_at, applied_at, error, created_at
        from mutation_outbox
        where company_id = $1
        order by created_at desc
        limit $2
        `,
                [company.id, limit],
              )
              sendJson(res, 200, { outbox: result.rows })
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/customers') {
              const body = await readBody(req)
              const name = String(body.name ?? '').trim()
              if (!name) {
                sendJson(res, 400, { error: 'name is required' })
                return
              }
              const result = await pool.query(
                `
        insert into customers (company_id, external_id, name, source, version)
        values ($1, $2, $3, $4, 1)
        returning id, external_id, name, source, version, deleted_at, created_at
        `,
                [company.id, body.external_id ?? null, name, body.source ?? 'manual'],
              )
              await recordSyncEvent(company.id, 'customer', result.rows[0].id, {
                action: 'create',
                customer: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'customer',
                result.rows[0].id,
                'create',
                result.rows[0],
                `customer:create:${result.rows[0].id}`,
              )
              await backfillCustomerMapping(company.id, result.rows[0])
              sendJson(res, 201, result.rows[0])
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/customers\/[^/]+$/)) {
              const customerId = url.pathname.split('/')[3] ?? ''
              if (!customerId) {
                sendJson(res, 400, { error: 'customer id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update customers
        set
          external_id = coalesce($3, external_id),
          name = coalesce($4, name),
          source = coalesce($5, source),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($6::int is null or version = $6)
        returning id, external_id, name, source, version, deleted_at, created_at
        `,
                [
                  company.id,
                  customerId,
                  body.external_id ?? null,
                  body.name ?? null,
                  body.source ?? null,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version, deleted_at from customers where company_id = $1 and id = $2',
                  [company.id, customerId],
                )
                const current = existing.rows[0]
                if (
                  current &&
                  !current.deleted_at &&
                  expectedVersion !== null &&
                  Number(current.version) !== expectedVersion
                ) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'customer not found' })
                return
              }
              await recordSyncEvent(company.id, 'customer', customerId, { action: 'update', customer: result.rows[0] })
              await recordMutationOutbox(
                company.id,
                'customer',
                customerId,
                'update',
                result.rows[0],
                `customer:update:${customerId}`,
              )
              await backfillCustomerMapping(company.id, result.rows[0])
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/customers\/[^/]+$/)) {
              const customerId = url.pathname.split('/')[3] ?? ''
              if (!customerId) {
                sendJson(res, 400, { error: 'customer id is required' })
                return
              }
              const result = await pool.query(
                `
        update customers
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, external_id, name, source, version, deleted_at, created_at
        `,
                [company.id, customerId],
              )
              if (!result.rows[0]) {
                sendJson(res, 404, { error: 'customer not found' })
                return
              }
              await recordSyncEvent(company.id, 'customer', customerId, { action: 'delete', customer: result.rows[0] })
              await recordMutationOutbox(
                company.id,
                'customer',
                customerId,
                'delete',
                result.rows[0],
                `customer:delete:${customerId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/workers') {
              const body = await readBody(req)
              const name = String(body.name ?? '').trim()
              if (!name) {
                sendJson(res, 400, { error: 'name is required' })
                return
              }
              const result = await pool.query(
                `
        insert into workers (company_id, name, role)
        values ($1, $2, $3)
        returning id, name, role, version, deleted_at, created_at
        `,
                [company.id, name, body.role ?? 'crew'],
              )
              await recordSyncEvent(company.id, 'worker', result.rows[0].id, {
                action: 'create',
                worker: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'worker',
                result.rows[0].id,
                'create',
                result.rows[0],
                `worker:create:${result.rows[0].id}`,
              )
              sendJson(res, 201, result.rows[0])
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/workers\/[^/]+$/)) {
              const workerId = url.pathname.split('/')[3] ?? ''
              if (!workerId) {
                sendJson(res, 400, { error: 'worker id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update workers
        set
          name = coalesce($3, name),
          role = coalesce($4, role),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($5::int is null or version = $5)
        returning id, name, role, version, deleted_at, created_at
        `,
                [company.id, workerId, body.name ?? null, body.role ?? null, expectedVersion],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version, deleted_at from workers where company_id = $1 and id = $2',
                  [company.id, workerId],
                )
                const current = existing.rows[0]
                if (
                  current &&
                  !current.deleted_at &&
                  expectedVersion !== null &&
                  Number(current.version) !== expectedVersion
                ) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'worker not found' })
                return
              }
              await recordSyncEvent(company.id, 'worker', workerId, { action: 'update', worker: result.rows[0] })
              await recordMutationOutbox(
                company.id,
                'worker',
                workerId,
                'update',
                result.rows[0],
                `worker:update:${workerId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/workers\/[^/]+$/)) {
              const workerId = url.pathname.split('/')[3] ?? ''
              if (!workerId) {
                sendJson(res, 400, { error: 'worker id is required' })
                return
              }
              const result = await pool.query(
                `
        update workers
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, name, role, version, deleted_at, created_at
        `,
                [company.id, workerId],
              )
              if (!result.rows[0]) {
                sendJson(res, 404, { error: 'worker not found' })
                return
              }
              await recordSyncEvent(company.id, 'worker', workerId, { action: 'delete', worker: result.rows[0] })
              await recordMutationOutbox(
                company.id,
                'worker',
                workerId,
                'delete',
                result.rows[0],
                `worker:delete:${workerId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/service-items') {
              const body = await readBody(req)
              const code = String(body.code ?? '').trim()
              const name = String(body.name ?? '').trim()
              const category = String(body.category ?? 'labor').trim()
              const unit = String(body.unit ?? 'hr').trim()
              if (!code || !name) {
                sendJson(res, 400, { error: 'code and name are required' })
                return
              }
              const result = await pool.query(
                `
        insert into service_items (company_id, code, name, category, unit, default_rate, source, version, created_at)
        values ($1, $2, $3, $4, $5, $6, coalesce($7, 'manual'), 1, now())
        returning code, name, category, unit, default_rate, source, version, created_at
        `,
                [company.id, code, name, category, unit, body.default_rate ?? null, body.source ?? 'manual'],
              )
              await recordSyncEvent(company.id, 'service_item', code, {
                action: 'create',
                service_item: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'service_item',
                code,
                'create',
                result.rows[0],
                `service_item:create:${code}`,
              )
              sendJson(res, 201, result.rows[0])
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/service-items\/[^/]+$/)) {
              const code = url.pathname.split('/')[3] ?? ''
              if (!code) {
                sendJson(res, 400, { error: 'service item code is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update service_items
        set
          name = coalesce($3, name),
          category = coalesce($4, category),
          unit = coalesce($5, unit),
          default_rate = coalesce($6, default_rate),
          version = version + 1
        where company_id = $1 and code = $2 and ($7::int is null or version = $7)
        returning code, name, category, unit, default_rate, source, version, created_at
        `,
                [
                  company.id,
                  code,
                  body.name ?? null,
                  body.category ?? null,
                  body.unit ?? null,
                  body.default_rate ?? null,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from service_items where company_id = $1 and code = $2',
                  [company.id, code],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'service item not found' })
                return
              }
              await recordSyncEvent(company.id, 'service_item', code, {
                action: 'update',
                service_item: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'service_item',
                code,
                'update',
                result.rows[0],
                `service_item:update:${code}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/service-items\/[^/]+$/)) {
              const code = url.pathname.split('/')[3] ?? ''
              if (!code) {
                sendJson(res, 400, { error: 'service item code is required' })
                return
              }
              const body = await readBody(req)
              const result = await pool.query(
                `
        update service_items
        set deleted_at = now(), version = version + 1
        where company_id = $1 and code = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning code, name, category, unit, default_rate, source, version, created_at
        `,
                [company.id, code, parseExpectedVersion(body.expected_version ?? body.version)],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from service_items where company_id = $1 and code = $2',
                  [company.id, code],
                )
                const current = existing.rows[0]
                if (
                  current &&
                  parseExpectedVersion(body.expected_version ?? body.version) !== null &&
                  Number(current.version) !== parseExpectedVersion(body.expected_version ?? body.version)
                ) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'service item not found' })
                return
              }
              await recordSyncEvent(company.id, 'service_item', code, {
                action: 'delete',
                service_item: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'service_item',
                code,
                'delete',
                result.rows[0],
                `service_item:delete:${code}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/projects') {
              const body = await readBody(req)
              const name = String(body.name ?? '').trim()
              const customerName = String(body.customer_name ?? '').trim()
              const divisionCode = String(body.division_code ?? 'D4')
              if (!name || !customerName) {
                sendJson(res, 400, { error: 'name and customer_name are required' })
                return
              }
              const customerId =
                body.customer_id === undefined || body.customer_id === null || body.customer_id === ''
                  ? null
                  : String(body.customer_id).trim()
              if (customerId && !isValidUuid(customerId)) {
                sendJson(res, 400, { error: 'customer_id must be a valid uuid' })
                return
              }

              const created = await pool.query(
                `
        insert into projects (
          company_id, customer_id, name, customer_name, division_code, status,
          bid_total, labor_rate, target_sqft_per_hr, bonus_pool, version
        )
        values (
          $1,
          nullif($2, '')::uuid,
          $3,
          $4,
          $5,
          coalesce($6, 'lead'),
          coalesce($7, 0),
          coalesce($8, 0),
          $9,
          coalesce($10, 0),
          1
        )
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, version, created_at, updated_at
        `,
                [
                  company.id,
                  customerId,
                  name,
                  customerName,
                  divisionCode,
                  body.status ?? 'lead',
                  body.bid_total ?? 0,
                  body.labor_rate ?? 0,
                  body.target_sqft_per_hr ?? null,
                  body.bonus_pool ?? 0,
                ],
              )
              await recordSyncEvent(company.id, 'project', created.rows[0].id, {
                action: 'create',
                project: created.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'project',
                created.rows[0].id,
                'create',
                created.rows[0],
                `project:create:${created.rows[0].id}`,
              )
              sendJson(res, 201, created.rows[0])
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/projects\/[^/]+$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update projects
        set
          name = coalesce($3, name),
          customer_name = coalesce($4, customer_name),
          division_code = coalesce($5, division_code),
          status = coalesce($6, status),
          bid_total = coalesce($7, bid_total),
          labor_rate = coalesce($8, labor_rate),
          target_sqft_per_hr = coalesce($9, target_sqft_per_hr),
          bonus_pool = coalesce($10, bonus_pool),
          updated_at = now(),
          version = version + 1
        where company_id = $1 and id = $2 and ($11::int is null or version = $11)
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, version, created_at, updated_at
        `,
                [
                  company.id,
                  projectId,
                  body.name ?? null,
                  body.customer_name ?? null,
                  body.division_code ?? null,
                  body.status ?? null,
                  body.bid_total ?? null,
                  body.labor_rate ?? null,
                  body.target_sqft_per_hr ?? null,
                  body.bonus_pool ?? null,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query('select version from projects where company_id = $1 and id = $2', [
                  company.id,
                  projectId,
                ])
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              await recordSyncEvent(company.id, 'project', projectId, {
                action: 'update',
                project: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'project',
                projectId,
                'update',
                result.rows[0],
                `project:update:${projectId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/closeout$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              const result = await pool.query(
                `
        update projects
        set
          status = 'completed',
          closed_at = coalesce(closed_at, now()),
          summary_locked_at = coalesce(summary_locked_at, now()),
          updated_at = now(),
          version = version + 1
        where company_id = $1 and id = $2 and ($3::int is null or version = $3)
        returning id, customer_id, name, customer_name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool, closed_at, summary_locked_at, version, created_at, updated_at
        `,
                [company.id, projectId, parseExpectedVersion(body?.expected_version ?? body?.version)],
              )
              if (!result.rows[0]) {
                const existing = await pool.query('select version from projects where company_id = $1 and id = $2', [
                  company.id,
                  projectId,
                ])
                const current = existing.rows[0]
                const expectedVersion = parseExpectedVersion(body?.expected_version ?? body?.version)
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              await recordSyncEvent(company.id, 'project', projectId, { action: 'closeout', project: result.rows[0] })
              await recordMutationOutbox(
                company.id,
                'project',
                projectId,
                'closeout',
                result.rows[0],
                `project:closeout:${projectId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/material-bills$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const result = await pool.query(
                `
        select id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        from material_bills
        where company_id = $1 and project_id = $2 and deleted_at is null
        order by occurred_on desc, created_at desc
        `,
                [company.id, projectId],
              )
              sendJson(res, 200, { materialBills: result.rows })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/material-bills$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              if (!body.vendor || body.amount === undefined || !body.bill_type) {
                sendJson(res, 400, { error: 'vendor, amount, and bill_type are required' })
                return
              }
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              if (expectedVersion !== null) {
                const projectVersionResult = await pool.query(
                  'select version from projects where company_id = $1 and id = $2',
                  [company.id, projectId],
                )
                const currentProject = projectVersionResult.rows[0]
                if (!currentProject) {
                  sendJson(res, 404, { error: 'project not found' })
                  return
                }
                if (Number(currentProject.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(currentProject.version) })
                  return
                }
              }
              const result = await pool.query(
                `
        insert into material_bills (company_id, project_id, vendor_name, amount, bill_type, description, occurred_on)
        values ($1, $2, $3, $4, $5, $6, coalesce($7, now()::date))
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
                [
                  company.id,
                  projectId,
                  body.vendor,
                  body.amount,
                  body.bill_type,
                  body.description ?? null,
                  body.occurred_on ?? null,
                ],
              )
              await recordSyncEvent(company.id, 'material_bill', result.rows[0].id, {
                action: 'create',
                bill: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'material_bill',
                result.rows[0].id,
                'create',
                result.rows[0],
                `material_bill:create:${result.rows[0].id}`,
              )
              await pool.query(
                'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              sendJson(res, 201, result.rows[0])
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/material-bills\/[^/]+$/)) {
              const billId = url.pathname.split('/')[3] ?? ''
              if (!billId) {
                sendJson(res, 400, { error: 'bill id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update material_bills
        set
          vendor_name = coalesce($3, vendor_name),
          amount = coalesce($4, amount),
          bill_type = coalesce($5, bill_type),
          description = coalesce($6, description),
          occurred_on = coalesce($7, occurred_on),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($8::int is null or version = $8)
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
                [
                  company.id,
                  billId,
                  body.vendor ?? null,
                  body.amount ?? null,
                  body.bill_type ?? null,
                  body.description ?? null,
                  body.occurred_on ?? null,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from material_bills where company_id = $1 and id = $2',
                  [company.id, billId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'bill not found' })
                return
              }
              await recordSyncEvent(company.id, 'material_bill', billId, {
                action: 'update',
                bill: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'material_bill',
                billId,
                'update',
                result.rows[0],
                `material_bill:update:${billId}`,
              )
              await pool.query(
                'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                [company.id, result.rows[0].project_id],
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/material-bills\/[^/]+$/)) {
              const billId = url.pathname.split('/')[3] ?? ''
              if (!billId) {
                sendJson(res, 400, { error: 'bill id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update material_bills
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, project_id, vendor_name as vendor, amount, bill_type, description, occurred_on, version, deleted_at, created_at
        `,
                [company.id, billId, expectedVersion],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from material_bills where company_id = $1 and id = $2',
                  [company.id, billId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'bill not found' })
                return
              }
              await recordSyncEvent(company.id, 'material_bill', billId, {
                action: 'delete',
                bill: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'material_bill',
                billId,
                'delete',
                result.rows[0],
                `material_bill:delete:${billId}`,
              )
              await pool.query(
                'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                [company.id, result.rows[0].project_id],
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/push-qbo$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const connection = await getIntegrationConnectionWithSecrets(company.id, 'qbo')

              const projectResult = await pool.query(
                'select id, name, customer_name, bid_total from projects where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              if (!projectResult.rows[0]) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }

              const project = projectResult.rows[0]
              try {
                if (!connection?.access_token) {
                  const simulatedExternalId = `SIM-EST-${project.id.slice(0, 8)}`
                  await backfillProjectMapping(company.id, project, simulatedExternalId)
                  const payload = {
                    simulated: true,
                    estimateId: simulatedExternalId,
                    projectId: project.id,
                    projectName: project.name,
                    amount: project.bid_total,
                  }
                  await recordSyncEvent(company.id, 'project', project.id, {
                    action: 'push_qbo',
                    payload,
                    simulated: true,
                  })
                  await recordMutationOutbox(
                    company.id,
                    'project',
                    project.id,
                    'push-qbo',
                    payload,
                    `project:push-qbo:${project.id}`,
                  )
                  sendJson(res, 200, payload)
                  return
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
                  '/estimate',
                  connection.provider_account_id ?? '',
                  connection.access_token ?? '',
                  estimatePayload,
                )

                const qboEstimateId = String(
                  (result as any).Estimate?.Id ?? (result as any).Id ?? (result as any).id ?? '',
                ).trim()
                if (qboEstimateId) {
                  await backfillProjectMapping(company.id, project, qboEstimateId)
                }

                await recordSyncEvent(company.id, 'project', projectId, {
                  action: 'push_qbo',
                  result: result,
                })
                sendJson(res, 200, { success: true, result })
              } catch (error) {
                logger.error({ err: error, scope: 'qbo_push_estimate' }, 'Failed to push estimate to QBO')
                Sentry.captureException(error, { tags: { scope: 'qbo_push_estimate' } })
                sendJson(res, 500, { error: 'failed to push estimate to qbo' })
              }
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/schedules') {
              const body = await readBody(req)
              if (!body.project_id || !body.scheduled_for) {
                sendJson(res, 400, { error: 'project_id and scheduled_for are required' })
                return
              }
              if (!isValidDateInput(body.scheduled_for)) {
                sendJson(res, 400, { error: 'scheduled_for must be YYYY-MM-DD' })
                return
              }
              const result = await pool.query(
                `
        insert into crew_schedules (company_id, project_id, scheduled_for, crew, status, version)
        values ($1, $2, $3, $4::jsonb, coalesce($5, 'draft'), 1)
        returning id, project_id, scheduled_for, crew, status, version, deleted_at, created_at
        `,
                [
                  company.id,
                  body.project_id,
                  body.scheduled_for,
                  JSON.stringify(body.crew ?? []),
                  body.status ?? 'draft',
                ],
              )
              await recordSyncEvent(company.id, 'crew_schedule', result.rows[0].id, {
                action: 'create',
                schedule: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'crew_schedule',
                result.rows[0].id,
                'create',
                result.rows[0],
                `crew_schedule:create:${result.rows[0].id}`,
              )
              sendJson(res, 201, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname === '/api/labor-entries') {
              const body = await readBody(req)
              const required = ['project_id', 'service_item_code', 'hours', 'occurred_on']
              for (const key of required) {
                if (body[key] === undefined || body[key] === null || body[key] === '') {
                  sendJson(res, 400, { error: `${key} is required` })
                  return
                }
              }
              if (!isValidDateInput(body.occurred_on)) {
                sendJson(res, 400, { error: 'occurred_on must be YYYY-MM-DD' })
                return
              }
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              if (expectedVersion !== null) {
                const projectVersionResult = await pool.query(
                  'select version from projects where company_id = $1 and id = $2',
                  [company.id, body.project_id],
                )
                const currentProject = projectVersionResult.rows[0]
                if (!currentProject) {
                  sendJson(res, 404, { error: 'project not found' })
                  return
                }
                if (Number(currentProject.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(currentProject.version) })
                  return
                }
              }
              const result = await pool.query(
                `
        insert into labor_entries (company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on)
        values ($1, $2, $3, $4, $5, coalesce($6, 0), coalesce($7, 'draft'), $8)
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, created_at
        `,
                [
                  company.id,
                  body.project_id,
                  body.worker_id ?? null,
                  body.service_item_code,
                  body.hours,
                  body.sqft_done ?? 0,
                  body.status ?? 'draft',
                  body.occurred_on,
                ],
              )
              await recordSyncEvent(company.id, 'labor_entry', result.rows[0].id, {
                action: 'create',
                laborEntry: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'labor_entry',
                result.rows[0].id,
                'create',
                result.rows[0],
                `labor_entry:create:${result.rows[0].id}`,
              )
              await pool.query(
                'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                [company.id, body.project_id],
              )
              sendJson(res, 201, result.rows[0])
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/labor-entries') {
              const projectId = String(url.searchParams.get('project_id') ?? '').trim()
              const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50)))
              const result = await pool.query(
                `
        select id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, version, deleted_at, created_at
        from labor_entries
        where company_id = $1 and ($2 = '' or project_id = $2)
        order by occurred_on desc, created_at desc
        limit $3
        `,
                [company.id, projectId, limit],
              )
              sendJson(res, 200, { laborEntries: result.rows })
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/labor-entries\/[^/]+$/)) {
              const laborEntryId = url.pathname.split('/')[3] ?? ''
              if (!laborEntryId) {
                sendJson(res, 400, { error: 'labor entry id is required' })
                return
              }
              const body = await readBody(req)
              const result = await pool.query(
                `
        update labor_entries
        set
          worker_id = coalesce($3, worker_id),
          service_item_code = coalesce($4, service_item_code),
          hours = coalesce($5, hours),
          sqft_done = coalesce($6, sqft_done),
          status = coalesce($7, status),
          occurred_on = coalesce($8, occurred_on),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, version, deleted_at, created_at
        `,
                [
                  company.id,
                  laborEntryId,
                  body.worker_id ?? null,
                  body.service_item_code ?? null,
                  body.hours ?? null,
                  body.sqft_done ?? null,
                  body.status ?? null,
                  body.occurred_on ?? null,
                ],
              )
              if (!result.rows[0]) {
                sendJson(res, 404, { error: 'labor entry not found' })
                return
              }
              await recordSyncEvent(company.id, 'labor_entry', laborEntryId, {
                action: 'update',
                laborEntry: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'labor_entry',
                laborEntryId,
                'update',
                result.rows[0],
                `labor_entry:update:${laborEntryId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/labor-entries\/[^/]+$/)) {
              const laborEntryId = url.pathname.split('/')[3] ?? ''
              if (!laborEntryId) {
                sendJson(res, 400, { error: 'labor entry id is required' })
                return
              }
              const result = await pool.query(
                `
        update labor_entries
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null
        returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, version, deleted_at, created_at
        `,
                [company.id, laborEntryId],
              )
              if (!result.rows[0]) {
                sendJson(res, 404, { error: 'labor entry not found' })
                return
              }
              await recordSyncEvent(company.id, 'labor_entry', laborEntryId, {
                action: 'delete',
                laborEntry: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'labor_entry',
                laborEntryId,
                'delete',
                result.rows[0],
                `labor_entry:delete:${laborEntryId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurement$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const measurementInput = prepareTakeoffMeasurementInput(body)

              const projectVersionResult = await pool.query(
                'select version from projects where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              const currentProject = projectVersionResult.rows[0]
              if (!currentProject) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              if (expectedVersion !== null && Number(currentProject.version) !== expectedVersion) {
                sendJson(res, 409, { error: 'version conflict', current_version: Number(currentProject.version) })
                return
              }

              await assertBlueprintDocumentsBelongToProject(company.id, projectId, [
                measurementInput.blueprintDocumentId,
              ])

              const insertResult = await pool.query(
                `
        insert into takeoff_measurements (
          company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version
        )
        values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), 1)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, deleted_at, created_at
        `,
                [
                  company.id,
                  projectId,
                  measurementInput.blueprintDocumentId,
                  measurementInput.serviceItemCode,
                  measurementInput.quantity,
                  measurementInput.unit,
                  measurementInput.notes,
                  measurementInput.geometryJson,
                ],
              )

              const measurement = insertResult.rows[0]
              const estimate = await createEstimateFromMeasurements(company.id, projectId)
              await recordSyncEvent(company.id, 'takeoff_measurement', measurement.id, {
                action: 'create',
                measurement,
                estimate,
              })
              await recordMutationOutbox(
                company.id,
                'takeoff_measurement',
                measurement.id,
                'create',
                { measurement, estimate },
                `takeoff_measurement:create:${measurement.id}`,
                'server',
                getCurrentUserId(req),
              )
              sendJson(res, 201, { measurement, estimate })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurements$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              const body = await readBody(req)
              const measurements = Array.isArray(body.measurements) ? body.measurements : []
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)

              if (!measurements.length) {
                sendJson(res, 400, { error: 'measurements array is required' })
                return
              }

              const preparedMeasurements = measurements.map((measurement, index) =>
                prepareTakeoffMeasurementInput(measurement, `measurements[${index}]`),
              )
              const projectVersionResult = await pool.query(
                'select version from projects where company_id = $1 and id = $2',
                [company.id, projectId],
              )
              const currentProject = projectVersionResult.rows[0]
              if (!currentProject) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              if (expectedVersion !== null && Number(currentProject.version) !== expectedVersion) {
                sendJson(res, 409, { error: 'version conflict', current_version: Number(currentProject.version) })
                return
              }
              await assertBlueprintDocumentsBelongToProject(
                company.id,
                projectId,
                preparedMeasurements.map((measurement) => measurement.blueprintDocumentId),
              )

              await pool.query(
                `
        update takeoff_measurements
        set deleted_at = now(), version = version + 1
        where company_id = $1 and project_id = $2 and deleted_at is null
        `,
                [company.id, projectId],
              )

              const createdRows = []
              for (const measurement of preparedMeasurements) {
                const insertResult = await pool.query(
                  `
          insert into takeoff_measurements (
            company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version
          )
          values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), 1)
          returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, deleted_at, created_at
          `,
                  [
                    company.id,
                    projectId,
                    measurement.blueprintDocumentId,
                    measurement.serviceItemCode,
                    measurement.quantity,
                    measurement.unit,
                    measurement.notes,
                    measurement.geometryJson,
                  ],
                )
                createdRows.push(insertResult.rows[0])
              }

              const estimate = await createEstimateFromMeasurements(company.id, projectId)
              await recordSyncEvent(company.id, 'takeoff_measurement', projectId, {
                action: 'replace',
                measurementCount: createdRows.length,
                measurements: createdRows,
                estimate,
              })
              await recordMutationOutbox(
                company.id,
                'takeoff_measurement',
                projectId,
                'replace',
                { measurementCount: createdRows.length, measurements: createdRows, estimate },
                `takeoff_measurement:replace:${projectId}`,
              )
              sendJson(res, 201, { measurements: createdRows, estimate })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/estimate\/recompute$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const estimate = await createEstimateFromMeasurements(company.id, projectId)
              if (!estimate) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              await recordSyncEvent(company.id, 'estimate', projectId, {
                action: 'recompute',
                estimate,
              })
              await recordMutationOutbox(
                company.id,
                'estimate',
                projectId,
                'recompute',
                estimate,
                `estimate:recompute:${projectId}`,
              )
              sendJson(res, 200, estimate)
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/summary$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const summary = await summarizeProject(company.id, projectId)
              if (!summary) {
                sendJson(res, 404, { error: 'project not found' })
                return
              }
              sendJson(res, 200, summary)
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics') {
              sendJson(res, 200, await listAnalytics(company.id))
              return
            }

            if (req.method === 'GET' && url.pathname === '/api/analytics/history') {
              const from = url.searchParams.get('from') ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
              const to = url.searchParams.get('to') ?? new Date().toISOString()

              const result = await pool.query(
                `
        select
          date_trunc('day', le.occurred_on)::date as day,
          p.division_code,
          sum(le.hours) as total_hours,
          sum(le.sqft_done) as total_sqft,
          count(distinct p.id) as project_count
        from labor_entries le
        join projects p on le.project_id = p.id
        where le.company_id = $1 and le.occurred_on >= $2::timestamp and le.occurred_on < $3::timestamp and le.deleted_at is null
        group by date_trunc('day', le.occurred_on), p.division_code
        order by day desc
        `,
                [company.id, from, to],
              )

              const history = result.rows.map((row) => ({
                date: row.day,
                division: row.division_code,
                hours: Number(row.total_hours ?? 0),
                sqft: Number(row.total_sqft ?? 0),
                projects: Number(row.project_count ?? 0),
                productivity:
                  Number(row.total_hours ?? 0) > 0 ? Number(row.total_sqft ?? 0) / Number(row.total_hours ?? 0) : 0,
              }))

              sendJson(res, 200, { history, from, to })
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/blueprints$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              sendJson(res, 200, { blueprints: await listBlueprintDocuments(company.id, projectId) })
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/takeoff\/measurements$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              sendJson(res, 200, { measurements: await listTakeoffMeasurements(company.id, projectId) })
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/schedules$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              sendJson(res, 200, { schedules: await listSchedules(company.id, projectId) })
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/blueprints$/)) {
              const projectId = url.pathname.split('/')[3] ?? ''
              if (!projectId) {
                sendJson(res, 400, { error: 'project id is required' })
                return
              }
              const body = await readBody(req)
              const fileName = String(body.file_name ?? body.original_file_name ?? '').trim()
              const requestedStoragePath = body.storage_path === undefined ? null : String(body.storage_path)
              const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
              if (!fileName && !fileContentsBase64) {
                sendJson(res, 400, { error: 'file_name or file_contents_base64 is required' })
                return
              }
              const blueprintId = String(body.id ?? randomUUID())
              const versionResult = await pool.query<{ version: number }>(
                'select coalesce(max(version), 0) + 1 as version from blueprint_documents where company_id = $1 and project_id = $2',
                [company.id, projectId],
              )
              const version = Number(body.version ?? versionResult.rows[0]?.version ?? 1)
              const resolvedFileName = fileName || 'blueprint.pdf'
              let resolvedStoragePath = resolveBlueprintStoragePath(
                company.id,
                blueprintId,
                resolvedFileName,
                requestedStoragePath,
              )
              if (fileContentsBase64) {
                resolvedStoragePath = await persistBlueprintFile(
                  company.id,
                  blueprintId,
                  resolvedFileName,
                  fileContentsBase64,
                )
              }
              const inserted = await pool.query(
                `
        insert into blueprint_documents (
          id, company_id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, replaces_blueprint_document_id
        )
        values ($1, $2, $3, $4, $5, coalesce($6, 'storage_path'), $7, $8, $9, $10, $11)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
                [
                  blueprintId,
                  company.id,
                  projectId,
                  resolvedFileName,
                  resolvedStoragePath,
                  body.preview_type ?? null,
                  body.calibration_length ?? null,
                  body.calibration_unit ?? null,
                  body.sheet_scale ?? null,
                  version,
                  body.replaces_blueprint_document_id ?? null,
                ],
              )
              await recordSyncEvent(company.id, 'blueprint_document', inserted.rows[0].id, {
                action: 'create',
                blueprint: inserted.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'blueprint_document',
                inserted.rows[0].id,
                'create',
                inserted.rows[0],
                `blueprint_document:create:${inserted.rows[0].id}`,
              )
              sendJson(res, 201, inserted.rows[0])
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/blueprints\/[^/]+$/)) {
              const blueprintId = url.pathname.split('/')[3] ?? ''
              if (!blueprintId) {
                sendJson(res, 400, { error: 'blueprint id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
              const storagePath =
                body.storage_path === undefined || !String(body.storage_path).trim()
                  ? null
                  : resolveBlueprintStoragePath(
                      company.id,
                      blueprintId,
                      String(body.file_name ?? 'blueprint.pdf'),
                      String(body.storage_path),
                    )
              const result = await pool.query(
                `
        update blueprint_documents
        set
          file_name = coalesce($3, file_name),
          storage_path = coalesce($4, storage_path),
          preview_type = coalesce($5, preview_type),
          calibration_length = coalesce($6, calibration_length),
          calibration_unit = coalesce($7, calibration_unit),
          sheet_scale = coalesce($8, sheet_scale),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($9::int is null or version = $9)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
                [
                  company.id,
                  blueprintId,
                  body.file_name ?? null,
                  storagePath,
                  body.preview_type ?? null,
                  body.calibration_length ?? null,
                  body.calibration_unit ?? null,
                  body.sheet_scale ?? null,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from blueprint_documents where company_id = $1 and id = $2',
                  [company.id, blueprintId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'blueprint not found' })
                return
              }
              if (fileContentsBase64) {
                await persistBlueprintFile(
                  company.id,
                  blueprintId,
                  String(result.rows[0].file_name ?? body.file_name ?? 'blueprint.pdf'),
                  fileContentsBase64,
                )
              }
              await recordSyncEvent(company.id, 'blueprint_document', blueprintId, {
                action: 'update',
                blueprint: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'blueprint_document',
                blueprintId,
                'update',
                result.rows[0],
                `blueprint_document:update:${blueprintId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/blueprints\/[^/]+\/versions$/)) {
              const sourceBlueprintId = url.pathname.split('/')[3] ?? ''
              if (!sourceBlueprintId) {
                sendJson(res, 400, { error: 'blueprint id is required' })
                return
              }
              const sourceResult = await pool.query(
                `
        select id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at
        from blueprint_documents
        where company_id = $1 and id = $2 and deleted_at is null
        limit 1
        `,
                [company.id, sourceBlueprintId],
              )
              const source = sourceResult.rows[0]
              if (!source) {
                sendJson(res, 404, { error: 'blueprint not found' })
                return
              }
              const body = await readBody(req)
              const copyMeasurements = body.copy_measurements !== false
              const fileName = String(body.file_name ?? source.file_name ?? 'blueprint.pdf').trim()
              const fileContentsBase64 = String(body.file_contents_base64 ?? body.file_contents ?? '').trim()
              const versionResult = await pool.query<{ version: number }>(
                'select coalesce(max(version), 0) + 1 as version from blueprint_documents where company_id = $1 and project_id = $2',
                [company.id, source.project_id],
              )
              const version = Number(body.version ?? versionResult.rows[0]?.version ?? 1)
              const blueprintId = String(body.id ?? randomUUID())
              const requestedStoragePath = body.storage_path === undefined ? null : String(body.storage_path)
              let storagePath = requestedStoragePath
                ? resolveBlueprintStoragePath(company.id, blueprintId, fileName, requestedStoragePath)
                : ''
              if (fileContentsBase64) {
                storagePath = await persistBlueprintFile(company.id, blueprintId, fileName, fileContentsBase64)
              } else if (source.storage_path) {
                try {
                  storagePath = await copyBlueprintFile(company.id, blueprintId, source.storage_path, fileName)
                } catch {
                  storagePath = getBlueprintFilePath(company.id, blueprintId, fileName)
                }
              } else if (!storagePath) {
                storagePath = getBlueprintFilePath(company.id, blueprintId, fileName)
              }
              const inserted = await pool.query(
                `
        insert into blueprint_documents (
          id, company_id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, replaces_blueprint_document_id
        )
        values ($1, $2, $3, $4, $5, coalesce($6, 'storage_path'), $7, $8, $9, $10, $11)
        returning id, project_id, file_name, storage_path, preview_type, calibration_length, calibration_unit, sheet_scale, version, deleted_at, replaces_blueprint_document_id, concat('/api/blueprints/', id, '/file') as file_url, created_at
        `,
                [
                  blueprintId,
                  company.id,
                  source.project_id,
                  fileName,
                  storagePath,
                  body.preview_type ?? source.preview_type ?? null,
                  body.calibration_length ?? source.calibration_length ?? null,
                  body.calibration_unit ?? source.calibration_unit ?? null,
                  body.sheet_scale ?? source.sheet_scale ?? null,
                  version,
                  source.id,
                ],
              )
              if (copyMeasurements) {
                const sourceMeasurements = await pool.query(
                  `
          select project_id, service_item_code, quantity, unit, notes, geometry
          from takeoff_measurements
          where company_id = $1 and blueprint_document_id = $2 and deleted_at is null
          order by created_at asc
          `,
                  [company.id, source.id],
                )
                for (const measurement of sourceMeasurements.rows) {
                  await pool.query(
                    `
            insert into takeoff_measurements (
              company_id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1)
            `,
                    [
                      company.id,
                      measurement.project_id,
                      inserted.rows[0].id,
                      measurement.service_item_code,
                      measurement.quantity,
                      measurement.unit,
                      `${measurement.notes ?? ''}${measurement.notes ? ' · ' : ''}copied from blueprint v${source.version}`,
                      JSON.stringify(measurement.geometry ?? {}),
                    ],
                  )
                }
              }
              await recordSyncEvent(company.id, 'blueprint_document', inserted.rows[0].id, {
                action: 'version',
                source_blueprint_id: source.id,
                blueprint: inserted.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'blueprint_document',
                inserted.rows[0].id,
                'version',
                inserted.rows[0],
                `blueprint_document:version:${inserted.rows[0].id}`,
              )
              sendJson(res, 201, inserted.rows[0])
              return
            }

            if (req.method === 'GET' && url.pathname.match(/^\/api\/blueprints\/[^/]+\/file$/)) {
              const blueprintId = url.pathname.split('/')[3] ?? ''
              if (!blueprintId) {
                sendJson(res, 400, { error: 'blueprint id is required' })
                return
              }
              const result = await pool.query(
                'select file_name, storage_path from blueprint_documents where company_id = $1 and id = $2 and deleted_at is null limit 1',
                [company.id, blueprintId],
              )
              const blueprint = result.rows[0]
              if (!blueprint) {
                sendJson(res, 404, { error: 'blueprint not found' })
                return
              }
              try {
                const storageKey = assertBlueprintFilePath(company.id, String(blueprint.storage_path))
                const content = await storage.get(storageKey)
                const mimeType = getBlueprintMimeType(String(blueprint.file_name))
                res.writeHead(200, {
                  'content-type': mimeType,
                  'content-disposition': `inline; filename="${sanitizeFileName(String(blueprint.file_name))}"`,
                  'access-control-allow-origin': getCorsOrigin(req),
                  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                  'access-control-allow-headers': CORS_ALLOW_HEADERS,
                })
                res.end(content)
              } catch {
                sendJson(res, 404, { error: 'blueprint file not found' })
              }
              return
            }

            if (req.method === 'PATCH' && url.pathname.match(/^\/api\/takeoff\/measurements\/[^/]+$/)) {
              const measurementId = url.pathname.split('/')[4] ?? ''
              if (!measurementId) {
                sendJson(res, 400, { error: 'measurement id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              let geometryJson: string | null = null
              let quantity = body.quantity ?? null
              if (body.geometry !== undefined && body.geometry !== null && body.geometry !== '') {
                const geometry = normalizePolygonGeometry(body.geometry)
                if (!geometry) {
                  sendJson(res, 400, { error: 'geometry must be a polygon with at least 3 points inside the board' })
                  return
                }
                geometryJson = JSON.stringify(geometry)
                if (quantity === null || quantity === undefined || quantity === '') {
                  quantity = calculateTakeoffQuantity(geometry.points, geometry.sheet_scale ?? 1)
                }
                if (Number(quantity) <= 0) {
                  sendJson(res, 400, { error: 'geometry must produce a positive area' })
                  return
                }
              }
              if (quantity !== null && quantity !== undefined && quantity !== '') {
                const parsedQuantity = Number(quantity)
                if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
                  sendJson(res, 400, { error: 'quantity must be a non-negative number' })
                  return
                }
                quantity = parsedQuantity
              }
              const patchBlueprintDocumentId =
                body.blueprint_document_id === undefined ||
                body.blueprint_document_id === null ||
                body.blueprint_document_id === ''
                  ? null
                  : String(body.blueprint_document_id)
              if (patchBlueprintDocumentId) {
                if (!isValidUuid(patchBlueprintDocumentId)) {
                  sendJson(res, 400, { error: 'blueprint_document_id must be a valid uuid' })
                  return
                }
                const measurementProjectResult = await pool.query<{ project_id: string }>(
                  'select project_id from takeoff_measurements where company_id = $1 and id = $2 and deleted_at is null limit 1',
                  [company.id, measurementId],
                )
                const measurementProjectId = measurementProjectResult.rows[0]?.project_id
                if (!measurementProjectId) {
                  sendJson(res, 404, { error: 'measurement not found' })
                  return
                }
                await assertBlueprintDocumentsBelongToProject(company.id, measurementProjectId, [
                  patchBlueprintDocumentId,
                ])
              }
              const result = await pool.query(
                `
        update takeoff_measurements
        set
          service_item_code = coalesce($3, service_item_code),
          quantity = coalesce($4, quantity),
          unit = coalesce($5, unit),
          notes = coalesce($6, notes),
          blueprint_document_id = coalesce($7, blueprint_document_id),
          geometry = coalesce($8::jsonb, geometry),
          version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($9::int is null or version = $9)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, deleted_at, created_at
        `,
                [
                  company.id,
                  measurementId,
                  body.service_item_code ?? null,
                  quantity,
                  body.unit ?? null,
                  body.notes ?? null,
                  patchBlueprintDocumentId,
                  geometryJson,
                  expectedVersion,
                ],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from takeoff_measurements where company_id = $1 and id = $2',
                  [company.id, measurementId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'measurement not found' })
                return
              }
              await recordSyncEvent(company.id, 'takeoff_measurement', measurementId, {
                action: 'update',
                measurement: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'takeoff_measurement',
                measurementId,
                'update',
                result.rows[0],
                `takeoff_measurement:update:${measurementId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/takeoff\/measurements\/[^/]+$/)) {
              const measurementId = url.pathname.split('/')[4] ?? ''
              if (!measurementId) {
                sendJson(res, 400, { error: 'measurement id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update takeoff_measurements
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, project_id, blueprint_document_id, service_item_code, quantity, unit, notes, geometry, version, deleted_at, created_at
        `,
                [company.id, measurementId, expectedVersion],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from takeoff_measurements where company_id = $1 and id = $2',
                  [company.id, measurementId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'measurement not found' })
                return
              }
              await recordSyncEvent(company.id, 'takeoff_measurement', measurementId, {
                action: 'delete',
                measurement: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'takeoff_measurement',
                measurementId,
                'delete',
                result.rows[0],
                `takeoff_measurement:delete:${measurementId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'POST' && url.pathname.match(/^\/api\/schedules\/[^/]+\/confirm$/)) {
              const scheduleId = url.pathname.split('/')[3] ?? ''
              if (!scheduleId) {
                sendJson(res, 400, { error: 'schedule id is required' })
                return
              }
              const body = await readBody(req)
              const entries = Array.isArray(body.entries) ? body.entries : []
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const scheduleResult = await pool.query(
                `
        update crew_schedules
        set status = 'confirmed', version = version + 1
        where company_id = $1 and id = $2 and ($3::int is null or version = $3)
        returning id, project_id, scheduled_for, crew, status, version, created_at
        `,
                [company.id, scheduleId, expectedVersion],
              )
              const schedule = scheduleResult.rows[0]
              if (!schedule) {
                const existing = await pool.query(
                  'select version from crew_schedules where company_id = $1 and id = $2',
                  [company.id, scheduleId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'schedule not found' })
                return
              }
              const createdLaborEntries = []
              for (const entry of entries) {
                if (!entry.service_item_code || entry.hours === undefined || !entry.occurred_on) continue
                const inserted = await pool.query(
                  `
          insert into labor_entries (company_id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on)
          values ($1, $2, $3, $4, $5, coalesce($6, 0), 'confirmed', $7)
          returning id, project_id, worker_id, service_item_code, hours, sqft_done, status, occurred_on, created_at
          `,
                  [
                    company.id,
                    schedule.project_id,
                    entry.worker_id ?? null,
                    entry.service_item_code,
                    entry.hours,
                    entry.sqft_done ?? 0,
                    entry.occurred_on,
                  ],
                )
                createdLaborEntries.push(inserted.rows[0])
              }
              await pool.query(
                'update projects set version = version + 1, updated_at = now() where company_id = $1 and id = $2',
                [company.id, schedule.project_id],
              )
              await recordSyncEvent(company.id, 'crew_schedule', scheduleId, {
                action: 'confirm',
                schedule,
                laborEntries: createdLaborEntries,
              })
              await recordMutationOutbox(
                company.id,
                'crew_schedule',
                scheduleId,
                'confirm',
                { schedule, laborEntries: createdLaborEntries },
                `crew_schedule:confirm:${scheduleId}`,
              )
              sendJson(res, 200, { schedule, laborEntries: createdLaborEntries })
              return
            }

            if (req.method === 'DELETE' && url.pathname.match(/^\/api\/blueprints\/[^/]+$/)) {
              const blueprintId = url.pathname.split('/')[3] ?? ''
              if (!blueprintId) {
                sendJson(res, 400, { error: 'blueprint id is required' })
                return
              }
              const body = await readBody(req)
              const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
              const result = await pool.query(
                `
        update blueprint_documents
        set deleted_at = now(), version = version + 1
        where company_id = $1 and id = $2 and deleted_at is null and ($3::int is null or version = $3)
        returning id, project_id, file_name, storage_path, version, deleted_at, created_at
        `,
                [company.id, blueprintId, expectedVersion],
              )
              if (!result.rows[0]) {
                const existing = await pool.query(
                  'select version from blueprint_documents where company_id = $1 and id = $2',
                  [company.id, blueprintId],
                )
                const current = existing.rows[0]
                if (current && expectedVersion !== null && Number(current.version) !== expectedVersion) {
                  sendJson(res, 409, { error: 'version conflict', current_version: Number(current.version) })
                  return
                }
                sendJson(res, 404, { error: 'blueprint not found' })
                return
              }
              await recordSyncEvent(company.id, 'blueprint_document', blueprintId, {
                action: 'delete',
                blueprint: result.rows[0],
              })
              await recordMutationOutbox(
                company.id,
                'blueprint_document',
                blueprintId,
                'delete',
                result.rows[0],
                `blueprint_document:delete:${blueprintId}`,
              )
              sendJson(res, 200, result.rows[0])
              return
            }

            if (req.method === 'GET' && url.pathname.startsWith('/api/debug/traces/')) {
              const authResult = authorizeDebugTraceRequest({
                debugToken: process.env.DEBUG_TRACE_TOKEN,
                tier: appConfig.tier,
                allowProd: process.env.DEBUG_ALLOW_PROD,
                authorizationHeader: req.headers['authorization'],
                requestId,
              })
              if (!authResult.ok) {
                if (authResult.authenticate) {
                  res.setHeader('www-authenticate', 'Bearer realm="sitelayer-debug"')
                }
                sendJson(res, authResult.status, authResult.body)
                return
              }
              const presented = authResult.presentedToken
              const rlKey = (req.socket.remoteAddress ?? 'unknown') + ':' + presented.slice(0, 8)
              if (!debugRateLimit(rlKey)) {
                res.setHeader('retry-after', '6')
                sendJson(res, 429, { error: 'rate limit exceeded', request_id: requestId })
                return
              }
              const lookupId = url.pathname.slice('/api/debug/traces/'.length).trim()
              const byRequest = url.searchParams.get('by') === 'request_id'
              if (!lookupId || lookupId.includes('/')) {
                sendJson(res, 400, { error: 'invalid trace id', request_id: requestId })
                return
              }
              logger.info({ scope: 'debug_trace', target: lookupId, by_request: byRequest }, 'debug trace lookup')
              Sentry.setTag('debug_trace_lookup', '1')
              try {
                let traceId = byRequest ? null : lookupId
                const queueRows = await fetchQueueRowsForTraceOrRequest(
                  byRequest ? { requestId: lookupId } : { traceId: lookupId },
                )
                if (byRequest && !traceId) {
                  const hintRow = queueRows.outbox[0] ?? queueRows.syncEvents[0]
                  const hintTrace = hintRow ? (hintRow as { sentry_trace: string | null }).sentry_trace : null
                  traceId = parseTraceIdFromSentryTraceHeader(hintTrace)
                }
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), 8_000)
                let sentryPayload: unknown = null
                let sentryError: string | null = null
                if (traceId) {
                  try {
                    sentryPayload = await fetchSentryTrace(traceId, controller.signal)
                  } catch (err) {
                    if (err instanceof DebugTraceError) {
                      sentryError = err.message
                    } else {
                      sentryError = err instanceof Error ? err.message : 'sentry fetch failed'
                    }
                  } finally {
                    clearTimeout(timeout)
                  }
                } else {
                  clearTimeout(timeout)
                  sentryError = 'no trace_id found; pass ?by=request_id only when request has at least one enqueued row'
                }
                sendJson(res, 200, {
                  request_id: requestId,
                  lookup: { kind: byRequest ? 'request_id' : 'trace_id', id: lookupId },
                  trace_id: traceId,
                  sentry: sentryPayload,
                  sentry_error: sentryError,
                  queue: queueRows,
                })
              } catch (err) {
                logger.error({ err, scope: 'debug_trace' }, 'debug trace lookup failed')
                const status = err instanceof DebugTraceError ? err.status : err instanceof HttpError ? err.status : 500
                sendJson(res, status, {
                  error: err instanceof Error ? err.message : 'debug trace lookup failed',
                  request_id: requestId,
                })
              }
              return
            }

            sendJson(res, 404, { error: 'not found' })
          } catch (error) {
            logger.error({ err: error }, 'unhandled request error')
            Sentry.captureException(error)
            const status = error instanceof HttpError ? error.status : 500
            if (rootSpan) {
              rootSpan.setStatus({ code: 2, message: error instanceof Error ? error.message : 'internal_error' })
            }
            sendJson(res, status, {
              error: error instanceof Error ? error.message : 'internal server error',
              request_id: requestId,
            })
          }
        },
      )
    }),
  )
})

server.listen(port, () => {
  logger.info({ port }, '[api] listening')
})
