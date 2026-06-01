#!/usr/bin/env -S npx tsx
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { Pool, type PoolConfig } from 'pg'
import { setCompanyGuc } from '../apps/worker/src/runner-utils.js'
import { forwardMeshTraceOnce } from '../apps/worker/src/runners/mesh-trace-forward.js'

type SessionRow = {
  company_id: string
  route_path: string | null
}

type InsertedEventRow = {
  id: string
  seq: number
}

type ForwardStateRow = {
  event_ref: string
  status: string
  attempt_count: number
  forwarded_at: string | null
  last_status: number | null
  capture_session_id: string | null
}

type ControlPlaneTraceRow = {
  event_ref: string
  project_key: string
  principal_id: string
  principal_kind: string
  owner_id: string
  visibility: string
  tier: number
  session_id: string
  capture_session_id: string
  seq: number
  event_class: string
  route_path: string
  outcome: string
  error_code: string
  payload: Record<string, unknown>
  occurred_at: string
  received_at: string
}

type TracePreflightCheck = {
  name: string
  status: 'ok' | 'missing' | 'skipped' | 'failed' | 'warning'
  detail?: string
  metadata?: Record<string, unknown>
}

type TracePreflightResult = {
  project_key: string
  component: string | null
  forward_url_configured: boolean
  control_plane_db_checked: boolean
  ready_for_real_trace_smoke: boolean
  checks: TracePreflightCheck[]
}

type TableExistsRow = {
  exists: boolean
}

type ColumnExistsRow = {
  exists: boolean
}

type ComponentSecretRow = {
  component_name: string
  created_at: string
  expires_at: string
  expired: boolean
  rotated: boolean
}

type CaptureGrantRow = {
  owner_id: string
  visibility: string
  principal_kind: string
  tier: number
  allowed_streams: string[]
  retention_ttl_days: number
  expires_at: string | null
}

type TraceRequest = {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: string
}

function usage() {
  console.log(`Usage:
  CAPTURE_SESSION_ID=<uuid> DATABASE_URL=postgres://... npm run capture:trace-smoke
  npm run capture:trace-smoke -- --preflight

Appends one low-PII capture_session_event for the selected session, then runs
the existing Mesh product-trace forwarder once.

By default this starts a local fake product-trace endpoint and injects temporary
MESH_TRACE_* env. To hit a real Control Plane endpoint, set MESH_TRACE_FORWARD_URL,
MESH_TRACE_HMAC_COMPONENT, MESH_TRACE_HMAC_SECRET, and ALLOW_REAL_MESH_TRACE_SMOKE=1.
Set MESH_POSTGRES_DSN or CONTROL_PLANE_POSTGRES_DSN to verify the row landed in
Control Plane product_trace_events. Set REQUIRE_MESH_TRACE_DB_VERIFY=1 to fail
when that verification is unavailable or missing.
Use --preflight to check the real Control Plane product-trace prerequisites
without mutating a capture session. Set REQUIRE_MESH_TRACE_PREFLIGHT=1 to fail
when a checked prerequisite is missing.

This mutates the selected capture session by appending one smoke event. It
refuses non-local DATABASE_URL values unless ALLOW_CAPTURE_TRACE_SMOKE=1 is set.`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
}

function isLocalDatabaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return ['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(parsed.hostname)
  } catch {
    return false
  }
}

function parseJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  throw new Error('Expected JSON object body')
}

function parseKeywordPostgresDsn(value: string): PoolConfig {
  const config: PoolConfig = {}
  const pairs = value.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|\S*)/g)
  for (const match of pairs) {
    const key = match[1]
    let raw = match[2] ?? ''
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1)
    }
    switch (key) {
      case 'host':
        config.host = raw
        break
      case 'port':
        config.port = Number(raw)
        break
      case 'user':
        config.user = raw
        break
      case 'password':
        config.password = raw
        break
      case 'dbname':
      case 'database':
        config.database = raw
        break
      case 'sslmode':
        if (raw && raw !== 'disable') config.ssl = { rejectUnauthorized: false }
        break
      default:
        break
    }
  }
  return config
}

function postgresPoolConfig(value: string): PoolConfig {
  const trimmed = value.trim()
  if (/^postgres(ql)?:\/\//i.test(trimmed)) return { connectionString: trimmed }
  return parseKeywordPostgresDsn(trimmed)
}

function controlPlanePoolConfig(value: string): PoolConfig {
  return {
    ...postgresPoolConfig(value),
    allowExitOnIdle: true,
    connectionTimeoutMillis: Number(process.env.MESH_TRACE_DB_CONNECT_TIMEOUT_MS ?? '2000') || 2000,
  }
}

function controlPlaneDsn(): string {
  return (
    process.env.CONTROL_PLANE_POSTGRES_DSN?.trim() ||
    process.env.MESH_POSTGRES_DSN?.trim() ||
    process.env.MESH_LOCAL_POSTGRES_DSN?.trim() ||
    ''
  )
}

function traceProjectKey(): string {
  return process.env.MESH_TRACE_PROJECT_KEY?.trim() || 'sitelayer'
}

function traceComponent(): string | null {
  const value = process.env.MESH_TRACE_HMAC_COMPONENT?.trim()
  return value || null
}

function validateHexSecret(value: string | undefined): TracePreflightCheck {
  const secret = value?.trim() ?? ''
  if (!secret) return { name: 'MESH_TRACE_HMAC_SECRET', status: 'missing', detail: 'not configured' }
  if (!/^[0-9a-fA-F]+$/.test(secret) || secret.length % 2 !== 0) {
    return { name: 'MESH_TRACE_HMAC_SECRET', status: 'failed', detail: 'must be even-length hex' }
  }
  const bytes = secret.length / 2
  if (bytes < 32) {
    return { name: 'MESH_TRACE_HMAC_SECRET', status: 'failed', detail: 'must decode to at least 32 bytes' }
  }
  return { name: 'MESH_TRACE_HMAC_SECRET', status: 'ok', metadata: { bytes } }
}

async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  const result = await pool.query<TableExistsRow>('select to_regclass($1) is not null as exists', [tableName])
  return Boolean(result.rows[0]?.exists)
}

async function columnExists(pool: Pool, tableName: string, columnName: string): Promise<boolean> {
  const result = await pool.query<ColumnExistsRow>(
    `select exists (
       select 1
         from information_schema.columns
        where table_schema = current_schema()
          and table_name = $1
          and column_name = $2
     ) as exists`,
    [tableName, columnName],
  )
  return Boolean(result.rows[0]?.exists)
}

async function tracePreflight(): Promise<TracePreflightResult> {
  const projectKey = traceProjectKey()
  const component = traceComponent()
  const checks: TracePreflightCheck[] = []
  const forwardUrl = process.env.MESH_TRACE_FORWARD_URL?.trim() ?? ''
  checks.push(
    forwardUrl
      ? { name: 'MESH_TRACE_FORWARD_URL', status: 'ok', metadata: { url: forwardUrl.replace(/\/+$/, '') } }
      : { name: 'MESH_TRACE_FORWARD_URL', status: 'missing', detail: 'not configured' },
  )
  checks.push(
    component
      ? { name: 'MESH_TRACE_HMAC_COMPONENT', status: 'ok', metadata: { component } }
      : { name: 'MESH_TRACE_HMAC_COMPONENT', status: 'missing', detail: 'not configured' },
  )
  checks.push(validateHexSecret(process.env.MESH_TRACE_HMAC_SECRET))
  const traceEnvReady = checks.every((check) =>
    ['MESH_TRACE_FORWARD_URL', 'MESH_TRACE_HMAC_COMPONENT', 'MESH_TRACE_HMAC_SECRET'].includes(check.name)
      ? check.status === 'ok'
      : true,
  )
  if (!traceEnvReady && process.env.MESH_TRACE_PREFLIGHT_CHECK_DB !== '1') {
    checks.push({
      name: 'control_plane_db',
      status: 'skipped',
      detail: 'trace env is incomplete; set MESH_TRACE_PREFLIGHT_CHECK_DB=1 to probe Control Plane DB anyway',
    })
    return {
      project_key: projectKey,
      component,
      forward_url_configured: Boolean(forwardUrl),
      control_plane_db_checked: false,
      ready_for_real_trace_smoke: false,
      checks,
    }
  }

  const dsn = controlPlaneDsn()
  if (!dsn) {
    checks.push({
      name: 'CONTROL_PLANE_POSTGRES_DSN',
      status: 'skipped',
      detail:
        'MESH_POSTGRES_DSN or CONTROL_PLANE_POSTGRES_DSN not set; cannot verify component secret, capture_grant, or product_trace schema',
    })
    return {
      project_key: projectKey,
      component,
      forward_url_configured: Boolean(forwardUrl),
      control_plane_db_checked: false,
      ready_for_real_trace_smoke: false,
      checks,
    }
  }

  const pool = new Pool(controlPlanePoolConfig(dsn))
  try {
    for (const table of ['component_auth_secrets', 'capture_grants', 'product_trace_events']) {
      const exists = await tableExists(pool, table)
      checks.push({
        name: `table:${table}`,
        status: exists ? 'ok' : 'missing',
        ...(exists ? {} : { detail: `${table} is not migrated` }),
      })
    }

    const hasCaptureSessionId = await columnExists(pool, 'product_trace_events', 'capture_session_id')
    checks.push({
      name: 'product_trace_events.capture_session_id',
      status: hasCaptureSessionId ? 'ok' : 'missing',
      ...(hasCaptureSessionId ? {} : { detail: 'migration 325_product_trace_capture_session_id.sql is required' }),
    })

    if (component) {
      const secret = await pool.query<ComponentSecretRow>(
        `select component_name,
                created_at::text as created_at,
                expires_at::text as expires_at,
                expires_at <= now() as expired,
                rotated_at is not null as rotated
           from component_auth_secrets
          where component_name = $1
          limit 1`,
        [component],
      )
      const secretRow = secret.rows[0]
      checks.push(
        secretRow
          ? {
              name: 'component_auth_secrets.component',
              status: secretRow.expired ? 'failed' : 'ok',
              detail: secretRow.expired ? 'component secret is expired' : undefined,
              metadata: {
                component_name: secretRow.component_name,
                created_at: secretRow.created_at,
                expires_at: secretRow.expires_at,
                rotated: secretRow.rotated,
              },
            }
          : {
              name: 'component_auth_secrets.component',
              status: 'missing',
              detail: `no component secret metadata for ${component}`,
            },
      )

      const grant = await pool.query<CaptureGrantRow>(
        `select owner_id,
                visibility,
                principal_kind,
                tier::int as tier,
                allowed_streams,
                retention_ttl_days::int as retention_ttl_days,
                expires_at::text as expires_at
           from capture_grants
          where project_key = $1
            and principal_id = $2
            and status = 'active'
          order by created_at desc
          limit 1`,
        [projectKey, component],
      )
      const grantRow = grant.rows[0]
      if (!grantRow) {
        checks.push({
          name: 'capture_grants.active_component_project',
          status: 'missing',
          detail: `no active grant for project_key=${projectKey} principal_id=${component}`,
        })
      } else {
        const streamSet = new Set(grantRow.allowed_streams)
        checks.push({
          name: 'capture_grants.active_component_project',
          status: 'ok',
          metadata: {
            owner_id: grantRow.owner_id,
            visibility: grantRow.visibility,
            principal_kind: grantRow.principal_kind,
            tier: grantRow.tier,
            allowed_streams: grantRow.allowed_streams,
            retention_ttl_days: grantRow.retention_ttl_days,
            expires_at: grantRow.expires_at,
          },
        })
        if (!streamSet.has('events') && !streamSet.has('trace')) {
          checks.push({
            name: 'capture_grants.allowed_streams',
            status: 'warning',
            detail:
              "active grant does not list 'events' or 'trace'; current ingest does not enforce it, but the grant is semantically incomplete",
            metadata: { allowed_streams: grantRow.allowed_streams },
          })
        }
      }
    }
  } catch (error) {
    checks.push({
      name: 'control_plane_db',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await pool.end()
  }

  const hardFailures = checks.filter((check) => ['missing', 'failed'].includes(check.status))
  return {
    project_key: projectKey,
    component,
    forward_url_configured: Boolean(forwardUrl),
    control_plane_db_checked: true,
    ready_for_real_trace_smoke: hardFailures.length === 0,
    checks,
  }
}

function requireTracePreflightIfRequested(preflight: TracePreflightResult): void {
  if (process.env.REQUIRE_MESH_TRACE_PREFLIGHT !== '1') return
  if (!preflight.ready_for_real_trace_smoke) {
    const failed = preflight.checks
      .filter((check) => ['missing', 'failed'].includes(check.status))
      .map((check) => `${check.name}:${check.status}`)
      .join(', ')
    throw new Error(`Mesh trace preflight failed: ${failed || 'not ready'}`)
  }
}

function meshStoredEventRef(component: string, projectKey: string, producerEventRef: string): string {
  const clean = producerEventRef
    .replace(/[^A-Za-z0-9:._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160)
  return `${component.trim().toLowerCase()}:${projectKey.trim().toLowerCase()}:${clean}`
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function startFakeProductTraceServer(): Promise<{
  url: string
  requests: TraceRequest[]
  close: () => Promise<void>
}> {
  const requests: TraceRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ accepted: true, count: requestTraceCount(body) }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake product-trace server did not bind')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
  }
}

function requestTraceCount(body: string): number {
  try {
    const parsed = parseJson(body)
    return Array.isArray(parsed.events) ? parsed.events.length : 0
  } catch {
    return 0
  }
}

async function appendSmokeCaptureEvent(
  pool: Pool,
  captureSessionId: string,
): Promise<{
  companyId: string
  routePath: string | null
  event: InsertedEventRow
}> {
  const session = await pool.query<SessionRow>(
    `select company_id::text as company_id, route_path
       from capture_sessions
      where id = $1::uuid
      limit 1`,
    [captureSessionId],
  )
  const row = session.rows[0]
  if (!row) throw new Error(`Capture session not found: ${captureSessionId}`)
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, row.company_id)
    const inserted = await client.query<InsertedEventRow>(
      `insert into capture_session_events (
         company_id, capture_session_id, seq, client_event_id, event_type,
         event_class, route_path, workflow_id, entity_type, entity_id,
         payload, occurred_at
       )
       select $1::uuid,
              $2::uuid,
              coalesce(max(seq), 0) + 1,
              $3,
              'trace.smoke',
              'smoke',
              $4,
              'capture_trace_smoke',
              'capture_session',
              $2,
              $5::jsonb,
              now()
         from capture_session_events
        where company_id = $1::uuid and capture_session_id = $2::uuid
       returning id::text, seq::int`,
      [
        row.company_id,
        captureSessionId,
        `trace-smoke:${Date.now()}`,
        row.route_path ?? '/capture/trace-smoke',
        JSON.stringify({ source: 'trace_capture_session_smoke' }),
      ],
    )
    await client.query('commit')
    const event = inserted.rows[0]
    if (!event) throw new Error('Smoke event insert returned no row')
    return { companyId: row.company_id, routePath: row.route_path, event }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function loadForwardState(pool: Pool, companyId: string, eventRef: string): Promise<ForwardStateRow | null> {
  const state = await pool.query<ForwardStateRow>(
    `select event_ref,
            status,
            attempt_count::int as attempt_count,
            forwarded_at::text as forwarded_at,
            last_status,
            capture_session_id::text as capture_session_id
       from mesh_trace_forward_state
      where company_id = $1::uuid
        and event_ref = $2
      limit 1`,
    [companyId, eventRef],
  )
  return state.rows[0] ?? null
}

async function loadControlPlaneTraceEvent(pool: Pool, eventRef: string): Promise<ControlPlaneTraceRow | null> {
  const row = await pool.query<ControlPlaneTraceRow>(
    `select event_ref,
            project_key,
            principal_id,
            principal_kind,
            owner_id,
            visibility,
            tier::int as tier,
            session_id,
            capture_session_id,
            seq::int as seq,
            event_class,
            route_path,
            outcome,
            error_code,
            payload,
            occurred_at::text as occurred_at,
            received_at::text as received_at
       from product_trace_events
      where event_ref = $1
      limit 1`,
    [eventRef],
  )
  return row.rows[0] ?? null
}

async function verifyControlPlaneTrace(args: {
  expectedEventRef: string
  captureSessionId: string
  timeoutMs: number
}): Promise<{
  checked: boolean
  found: boolean
  expected_event_ref: string
  row: ControlPlaneTraceRow | null
  reason?: string
}> {
  const dsn = controlPlaneDsn()
  if (!dsn) {
    return {
      checked: false,
      found: false,
      expected_event_ref: args.expectedEventRef,
      row: null,
      reason: 'MESH_POSTGRES_DSN or CONTROL_PLANE_POSTGRES_DSN not set',
    }
  }

  const pool = new Pool(controlPlanePoolConfig(dsn))
  const deadline = Date.now() + args.timeoutMs
  try {
    while (true) {
      const row = await loadControlPlaneTraceEvent(pool, args.expectedEventRef)
      if (row) {
        if (row.capture_session_id !== args.captureSessionId) {
          throw new Error('Control Plane product_trace_events row did not preserve capture_session_id')
        }
        return {
          checked: true,
          found: true,
          expected_event_ref: args.expectedEventRef,
          row,
        }
      }
      if (Date.now() >= deadline) {
        return {
          checked: true,
          found: false,
          expected_event_ref: args.expectedEventRef,
          row: null,
          reason: 'event_ref not found before timeout',
        }
      }
      await sleep(500)
    }
  } finally {
    await pool.end()
  }
}

function setEnv(name: string, value: string): string | undefined {
  const previous = process.env[name]
  process.env[name] = value
  return previous
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage()
    return
  }
  if (process.argv.includes('--preflight')) {
    const preflight = await tracePreflight()
    console.log(JSON.stringify({ trace_preflight: preflight }, null, 2))
    requireTracePreflightIfRequested(preflight)
    return
  }
  const captureSessionId = requiredEnv('CAPTURE_SESSION_ID')
  const databaseUrl = requiredEnv('DATABASE_URL')
  if (!isLocalDatabaseUrl(databaseUrl) && process.env.ALLOW_CAPTURE_TRACE_SMOKE !== '1') {
    throw new Error('Refusing non-local DATABASE_URL without ALLOW_CAPTURE_TRACE_SMOKE=1')
  }

  const useRealTraceEndpoint = Boolean(process.env.MESH_TRACE_FORWARD_URL)
  if (useRealTraceEndpoint && process.env.ALLOW_REAL_MESH_TRACE_SMOKE !== '1') {
    throw new Error('Refusing real MESH_TRACE_FORWARD_URL without ALLOW_REAL_MESH_TRACE_SMOKE=1')
  }
  const realTracePreflight = useRealTraceEndpoint ? await tracePreflight() : null
  if (realTracePreflight) requireTracePreflightIfRequested(realTracePreflight)

  const pool = new Pool({ connectionString: databaseUrl })
  const fake = useRealTraceEndpoint ? null : await startFakeProductTraceServer()
  const previousUrl = fake ? setEnv('MESH_TRACE_FORWARD_URL', fake.url) : undefined
  const previousComponent = fake ? setEnv('MESH_TRACE_HMAC_COMPONENT', 'sitelayer-trace-smoke') : undefined
  const previousSecret = fake
    ? setEnv('MESH_TRACE_HMAC_SECRET', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
    : undefined
  const previousProject = fake ? setEnv('MESH_TRACE_PROJECT_KEY', 'sitelayer') : undefined
  const previousWindow = setEnv('MESH_TRACE_FORWARD_WINDOW_MIN', process.env.MESH_TRACE_FORWARD_WINDOW_MIN ?? '60')
  const previousTimeout = fake ? setEnv('MESH_TRACE_FORWARD_TIMEOUT_MS', '3000') : undefined
  try {
    const inserted = await appendSmokeCaptureEvent(pool, captureSessionId)
    const summary = await forwardMeshTraceOnce({ pool })
    const eventRef = `capture_session_event:${inserted.event.id}`
    const forwardState = await loadForwardState(pool, inserted.companyId, eventRef)
    const expectedControlPlaneEventRef = meshStoredEventRef(
      process.env.MESH_TRACE_HMAC_COMPONENT ?? '',
      process.env.MESH_TRACE_PROJECT_KEY ?? 'sitelayer',
      eventRef,
    )
    const controlPlaneVerification = useRealTraceEndpoint
      ? await verifyControlPlaneTrace({
          expectedEventRef: expectedControlPlaneEventRef,
          captureSessionId,
          timeoutMs: Number(process.env.MESH_TRACE_DB_VERIFY_TIMEOUT_MS ?? '5000') || 5000,
        })
      : null

    const output: Record<string, unknown> = {
      capture_session_id: captureSessionId,
      company_id: inserted.companyId,
      appended_event_id: inserted.event.id,
      appended_event_seq: inserted.event.seq,
      forward_summary: summary,
      forward_state: forwardState,
      trace_preflight: realTracePreflight,
      expected_control_plane_event_ref: useRealTraceEndpoint ? expectedControlPlaneEventRef : null,
      control_plane_product_trace: controlPlaneVerification,
      fake_product_trace_request_count: fake?.requests.length ?? null,
    }

    if (fake) {
      const first = fake.requests[0]
      output.fake_product_trace_request = first
        ? {
            method: first.method,
            url: first.url,
            has_component_header: Boolean(first.headers['x-mesh-component']),
            has_signature_header: Boolean(first.headers['x-mesh-signature']),
            body: parseJson(first.body),
          }
        : null
      if (!first) throw new Error('Expected fake product-trace endpoint to receive one request')
      const body = parseJson(first.body)
      const events = Array.isArray(body.events) ? (body.events as Array<Record<string, unknown>>) : []
      const forwarded = events.find((event) => event.event_ref === eventRef)
      if (!forwarded) throw new Error('Expected forwarded product trace event for appended capture event')
      if (forwarded.capture_session_id !== captureSessionId) {
        throw new Error('Forwarded event did not preserve capture_session_id')
      }
      if (JSON.stringify(forwarded).includes('trace_capture_session_smoke')) {
        throw new Error('Forwarded product trace leaked raw capture event payload')
      }
      if (!forwardState) throw new Error('Expected mesh_trace_forward_state row for forwarded event')
      if (forwardState.status !== 'forwarded') {
        throw new Error(`Expected forwarded state, got ${forwardState.status}`)
      }
      if (forwardState.capture_session_id !== captureSessionId) {
        throw new Error('Forward state did not preserve capture_session_id')
      }
    }

    console.log(JSON.stringify(output, null, 2))
    if (!summary.ran) throw new Error(`Mesh trace forwarder did not run: ${summary.reason ?? 'unknown'}`)
    if (summary.forwarded_events < 1) throw new Error('Expected at least one forwarded product trace event')
    if (process.env.REQUIRE_MESH_TRACE_DB_VERIFY === '1' && !controlPlaneVerification?.found) {
      throw new Error(`Control Plane product_trace_events verification failed: ${controlPlaneVerification?.reason}`)
    }
  } finally {
    restoreEnv('MESH_TRACE_FORWARD_WINDOW_MIN', previousWindow)
    if (fake) {
      restoreEnv('MESH_TRACE_FORWARD_URL', previousUrl)
      restoreEnv('MESH_TRACE_HMAC_COMPONENT', previousComponent)
      restoreEnv('MESH_TRACE_HMAC_SECRET', previousSecret)
      restoreEnv('MESH_TRACE_PROJECT_KEY', previousProject)
      restoreEnv('MESH_TRACE_FORWARD_TIMEOUT_MS', previousTimeout)
      await fake.close().catch(() => undefined)
    }
    await pool.end()
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
