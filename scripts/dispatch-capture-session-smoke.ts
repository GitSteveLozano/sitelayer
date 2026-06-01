#!/usr/bin/env -S npx tsx
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { Pool, type PoolConfig } from 'pg'
import { setCompanyGuc } from '../apps/worker/src/runner-utils.js'
import { createBlueprintStorageGcClient } from '../apps/worker/src/runners/blueprint-storage-gc.js'
import { createCaptureArtifactAnalysisRunner } from '../apps/worker/src/runners/capture-artifact-analysis.js'
import { createContextWorkDispatchRunner } from '../apps/worker/src/runners/context-work-dispatch.js'

type SessionRow = {
  company_id: string
  company_slug: string
}

type WorkItemRow = {
  id: string
  status: string
  lane: string
}

type OutboxRow = {
  status: string
  attempt_count: number
  error: string | null
}

type DispatchAckRow = {
  payload: Record<string, unknown>
  recorded_at: string | null
}

type ControlPlaneTaskRow = {
  id: string
  state: string
  subject: string
  source: string
  task_type: string | null
  tags: string | null
  properties_json: Record<string, unknown>
  execution_json: Record<string, unknown>
  created_at: string | null
  updated_at: string | null
}

type CountRow = {
  count: number
}

type CallbackRow = {
  url: string
  path: string
  token: string
  token_type: string
  expires_at: string
}

type MeshRequest = {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: string
}

const CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION = 'sitelayer.context_work_dispatch.v1'

function usage() {
  console.log(`Usage:
  CAPTURE_SESSION_ID=<uuid> DATABASE_URL=postgres://... npm run capture:dispatch-smoke

Marks the capture session's finalized work item as explicitly agent-routable,
runs capture artifact analysis with the default-off auto-dispatch bridge enabled,
then drains context-work dispatch into a local fake Mesh HTTP endpoint.

By default this starts a local fake Mesh endpoint and injects
MESH_WORK_REQUEST_DISPATCH_URL. To hit a real Control Plane endpoint, set
MESH_WORK_REQUEST_DISPATCH_URL and ALLOW_REAL_MESH_DISPATCH_SMOKE=1.
Set MESH_POSTGRES_DSN or CONTROL_PLANE_POSTGRES_DSN to verify the row landed in
Control Plane tasks with the expected capture_session_id and context handoff.
Set REQUIRE_MESH_DISPATCH_DB_VERIFY=1 to fail when that verification is
unavailable or missing.
Real Control Plane smoke defaults Mesh auto_dispatch to false so the task row is
created but not routed to an agent. Set CAPTURE_DISPATCH_SMOKE_AUTO_DISPATCH=1
to allow auto-dispatch.
Set SITELAYER_API_URL to replay the scoped callback token back into Sitelayer.
Set REQUIRE_CAPTURE_CALLBACK_REPLAY=1 to fail when callback replay is skipped
or rejected.

This mutates the selected work item and outbox. It refuses non-local DATABASE_URL
values unless ALLOW_CAPTURE_DISPATCH_SMOKE=1 is set.`)
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

function parseJsonMaybe(value: string): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
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
    connectionTimeoutMillis: Number(process.env.MESH_DISPATCH_DB_CONNECT_TIMEOUT_MS ?? '2000') || 2000,
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

function contextWorkDispatchAutoDispatchEnabled(): boolean {
  const raw = process.env.CONTEXT_WORK_DISPATCH_AUTO_DISPATCH?.trim().toLowerCase()
  return raw === undefined || !['0', 'false', 'no'].includes(raw)
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key.toLowerCase() === 'token' ? '[redacted]' : redactSensitive(entry),
    ]),
  )
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  throw new Error(`Expected ${label} to be an object`)
}

function expectEqual(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`Expected ${label}=${String(expected)}, got ${String(value)}`)
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function isProductionSitelayerUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.hostname === 'sitelayer.sandolab.xyz'
  } catch {
    return false
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function startFakeMeshServer(): Promise<{
  url: string
  requests: MeshRequest[]
  close: () => Promise<void>
}> {
  const requests: MeshRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ task_id: `capture-dispatch-smoke-${requests.length}` }))
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
  if (!address || typeof address === 'string') throw new Error('Fake Mesh server did not bind to a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/mesh/work-requests`,
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

async function markWorkItemRoutable(pool: Pool, companyId: string, workItemId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const gate = await client.query<WorkItemRow>(
      `select id::text, status, lane
         from context_work_items
        where company_id = $1 and id = $2::uuid
        for update`,
      [companyId, workItemId],
    )
    const row = gate.rows[0]
    if (!row) throw new Error(`Context work item not found: ${workItemId}`)
    if (['resolved', 'wont_do', 'reversed'].includes(row.status)) {
      throw new Error(`Refusing to dispatch terminal work item ${workItemId} with status ${row.status}`)
    }
    await client.query(
      `update context_work_items
          set lane = 'agent',
              metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                'capture_auto_dispatch', 'true',
                'capture_dispatch_smoke',
                jsonb_build_object('marked_at', now(), 'previous_lane', $3::text, 'previous_status', $4::text)
              ),
              updated_at = now()
        where company_id = $1 and id = $2::uuid`,
      [companyId, workItemId, row.lane, row.status],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function loadControlPlaneTask(pool: Pool, idempotencyKey: string): Promise<ControlPlaneTaskRow | null> {
  const result = await pool.query<ControlPlaneTaskRow>(
    `select id::text,
            state,
            subject,
            source,
            task_type,
            tags,
            coalesce(properties_json, '{}'::jsonb) as properties_json,
            coalesce(execution_json, '{}'::jsonb) as execution_json,
            created_at::text,
            updated_at::text
       from tasks
      where properties_json ->> 'idempotency_key' = $1
      order by created_at desc nulls last, id desc
      limit 1`,
    [idempotencyKey],
  )
  return result.rows[0] ?? null
}

async function loadDispatchCallback(pool: Pool, companyId: string, workItemId: string): Promise<CallbackRow | null> {
  const result = await pool.query<CallbackRow>(
    `select coalesce(payload -> 'callback' ->> 'url', '') as url,
            coalesce(payload -> 'callback' ->> 'path', '') as path,
            coalesce(payload -> 'callback' ->> 'token', '') as token,
            coalesce(payload -> 'callback' ->> 'token_type', '') as token_type,
            coalesce(payload -> 'callback' ->> 'expires_at', '') as expires_at
       from mutation_outbox
      where company_id = $1
        and entity_type = 'context_work_item'
        and entity_id = $2
        and mutation_type = 'dispatch_mesh_work_request'
      order by created_at desc
      limit 1`,
    [companyId, workItemId],
  )
  const row = result.rows[0]
  return row?.token ? row : null
}

async function loadDispatchAcknowledgement(
  pool: Pool,
  companyId: string,
  workItemId: string,
): Promise<DispatchAckRow | null> {
  const result = await pool.query<DispatchAckRow>(
    `select coalesce(payload, '{}'::jsonb) as payload,
            recorded_at::text
       from context_handoff_events
      where company_id = $1
        and work_item_id = $2::uuid
        and event_type = 'agent.dispatch_acknowledged'
      order by recorded_at desc
      limit 1`,
    [companyId, workItemId],
  )
  return result.rows[0] ?? null
}

async function replayCallback(args: {
  apiUrl: string
  companySlug: string
  workItemId: string
  callback: CallbackRow | null
}): Promise<{
  attempted: boolean
  accepted: boolean
  status: number | null
  url: string | null
  work_item_status: string | null
  event_id: string | null
  reason?: string
}> {
  if (!args.callback?.token) {
    return {
      attempted: false,
      accepted: false,
      status: null,
      url: null,
      work_item_status: null,
      event_id: null,
      reason: 'callback token not found in mutation_outbox',
    }
  }
  const fallbackPath = args.callback.path || `/api/work-requests/${args.workItemId}/agent-callback`
  const callbackUrl = `${normalizeBaseUrl(args.apiUrl)}${fallbackPath}`
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.callback.token}`,
      'content-type': 'application/json',
      'x-sitelayer-company-slug': args.companySlug,
    },
    body: JSON.stringify({
      event_type: 'agent.message_received',
      agent_ref: 'scripts/dispatch-capture-session-smoke.ts',
      message: 'Synthetic callback replay proving the capture dispatch return path accepts the scoped token.',
      status: 'agent_running',
      lane: 'agent',
      metadata: {
        smoke: true,
        source: 'capture_dispatch_smoke',
        callback_expires_at: args.callback.expires_at || null,
      },
      idempotency_key: `capture-dispatch-callback-smoke:${args.workItemId}:${Date.now()}`,
    }),
  })
  const text = await response.text().catch(() => '')
  const parsed = parseJsonMaybe(text)
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  const workItem = readRecord(body.work_item)
  const event = readRecord(body.event)
  return {
    attempted: true,
    accepted: response.status === 202,
    status: response.status,
    url: callbackUrl,
    work_item_status: typeof workItem.status === 'string' ? workItem.status : null,
    event_id: typeof event.id === 'string' ? event.id : null,
    ...(response.status === 202 ? {} : { reason: text.slice(0, 500) }),
  }
}

async function verifyControlPlaneDispatch(args: {
  idempotencyKey: string
  captureSessionId: string
  workItemId: string
  timeoutMs: number
}): Promise<{
  checked: boolean
  found: boolean
  idempotency_key: string
  task: ControlPlaneTaskRow | null
  reason?: string
}> {
  const dsn = controlPlaneDsn()
  if (!dsn) {
    return {
      checked: false,
      found: false,
      idempotency_key: args.idempotencyKey,
      task: null,
      reason: 'MESH_POSTGRES_DSN or CONTROL_PLANE_POSTGRES_DSN not set',
    }
  }

  const pool = new Pool(controlPlanePoolConfig(dsn))
  const deadline = Date.now() + args.timeoutMs
  try {
    while (true) {
      const task = await loadControlPlaneTask(pool, args.idempotencyKey)
      if (task) {
        verifyControlPlaneTask(task, args)
        return {
          checked: true,
          found: true,
          idempotency_key: args.idempotencyKey,
          task,
        }
      }
      if (Date.now() >= deadline) {
        return {
          checked: true,
          found: false,
          idempotency_key: args.idempotencyKey,
          task: null,
          reason: 'task idempotency_key not found before timeout',
        }
      }
      await sleep(500)
    }
  } finally {
    await pool.end()
  }
}

function verifyControlPlaneTask(
  task: ControlPlaneTaskRow,
  args: { idempotencyKey: string; captureSessionId: string; workItemId: string },
): void {
  expectEqual(task.properties_json.idempotency_key, args.idempotencyKey, 'control_plane.properties.idempotency_key')
  expectEqual(
    task.properties_json.capture_session_id,
    args.captureSessionId,
    'control_plane.properties.capture_session_id',
  )
  expectEqual(task.properties_json.work_item_id, args.workItemId, 'control_plane.properties.work_item_id')
  expectEqual(task.properties_json.context_handoff_ref, args.workItemId, 'control_plane.properties.context_handoff_ref')
  expectEqual(task.properties_json.dispatch_mode, 'steerer', 'control_plane.properties.dispatch_mode')
  expectEqual(task.properties_json.claim_mode, 'steerer', 'control_plane.properties.claim_mode')
  expectEqual(
    task.properties_json.context_handoff_payload_version,
    CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION,
    'control_plane.properties.context_handoff_payload_version',
  )

  const context = readRecord(task.execution_json.context)
  expectEqual(
    context.payload_version,
    CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION,
    'control_plane.execution_context.payload_version',
  )
  expectEqual(context.capture_session_id, args.captureSessionId, 'control_plane.execution_context.capture_session_id')
  const contextHandoff = readRecord(context.context_handoff)
  expectEqual(
    contextHandoff.payload_version,
    CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION,
    'control_plane.execution_context.context_handoff.payload_version',
  )
  const callback = readRecord(contextHandoff.callback)
  expectEqual(
    callback.token_type,
    'scoped_bearer',
    'control_plane.execution_context.context_handoff.callback.token_type',
  )
  expectEqual(
    contextHandoff.capture_session_id,
    args.captureSessionId,
    'control_plane.execution_context.context_handoff.capture_session_id',
  )
  expectEqual(
    contextHandoff.work_item_id,
    args.workItemId,
    'control_plane.execution_context.context_handoff.work_item_id',
  )
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage()
    return
  }

  const captureSessionId = requiredEnv('CAPTURE_SESSION_ID')
  const databaseUrl = requiredEnv('DATABASE_URL')
  if (!isLocalDatabaseUrl(databaseUrl) && process.env.ALLOW_CAPTURE_DISPATCH_SMOKE !== '1') {
    throw new Error('Refusing non-local DATABASE_URL without ALLOW_CAPTURE_DISPATCH_SMOKE=1')
  }

  const useRealMeshEndpoint = Boolean(process.env.MESH_WORK_REQUEST_DISPATCH_URL?.trim())
  if (useRealMeshEndpoint && process.env.ALLOW_REAL_MESH_DISPATCH_SMOKE !== '1') {
    throw new Error('Refusing real MESH_WORK_REQUEST_DISPATCH_URL without ALLOW_REAL_MESH_DISPATCH_SMOKE=1')
  }
  const sitelayerApiUrl = process.env.SITELAYER_API_URL?.trim() ?? ''
  if (
    sitelayerApiUrl &&
    isProductionSitelayerUrl(sitelayerApiUrl) &&
    process.env.ALLOW_CAPTURE_CALLBACK_SMOKE !== '1'
  ) {
    throw new Error('Refusing production callback replay without ALLOW_CAPTURE_CALLBACK_SMOKE=1')
  }

  const pool = new Pool({ connectionString: databaseUrl })
  const fakeMesh = useRealMeshEndpoint ? null : await startFakeMeshServer()
  const previousAutoDispatch = process.env.CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH
  const previousContextWorkAutoDispatch = process.env.CONTEXT_WORK_DISPATCH_AUTO_DISPATCH
  const previousDispatchUrl = fakeMesh ? process.env.MESH_WORK_REQUEST_DISPATCH_URL : undefined
  const previousDispatchToken = fakeMesh ? process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN : undefined
  try {
    const session = await pool.query<SessionRow>(
      `select s.company_id::text as company_id,
              c.slug as company_slug
         from capture_sessions s
         join companies c on c.id = s.company_id
        where s.id = $1::uuid`,
      [captureSessionId],
    )
    const companyId = session.rows[0]?.company_id
    const companySlug = session.rows[0]?.company_slug
    if (!companyId) throw new Error(`Capture session not found: ${captureSessionId}`)
    if (!companySlug) throw new Error(`Company slug not found for capture session ${captureSessionId}`)

    const workItems = await pool.query<WorkItemRow>(
      `select id::text, status, lane
         from context_work_items
        where company_id = $1
          and capture_session_id = $2::uuid
          and metadata ->> 'source' = 'capture_session_finalize'
        order by created_at asc
        limit 1`,
      [companyId, captureSessionId],
    )
    const workItem = workItems.rows[0]
    if (!workItem) throw new Error(`No finalized context work item found for capture session ${captureSessionId}`)

    await markWorkItemRoutable(pool, companyId, workItem.id)

    process.env.CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH = '1'
    if (useRealMeshEndpoint) {
      process.env.CONTEXT_WORK_DISPATCH_AUTO_DISPATCH =
        process.env.CAPTURE_DISPATCH_SMOKE_AUTO_DISPATCH === '1' ? '1' : '0'
    }
    if (fakeMesh) {
      process.env.MESH_WORK_REQUEST_DISPATCH_URL = fakeMesh.url
      delete process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN
    }

    const storage = await createBlueprintStorageGcClient()
    if (!storage) throw new Error('Object storage is not configured for capture artifact analysis')

    const analyzer = createCaptureArtifactAnalysisRunner({ pool, storage })
    const analyzerSummary = await analyzer.forceAnalyze(companyId)
    const dispatch = createContextWorkDispatchRunner({ pool })
    const dispatchSummary = await dispatch(companyId)
    const idempotencyKey = `sitelayer:context_work_item:${workItem.id}`

    const outbox = await pool.query<OutboxRow>(
      `select status, attempt_count, error
         from mutation_outbox
        where company_id = $1
          and entity_type = 'context_work_item'
          and entity_id = $2
          and mutation_type = 'dispatch_mesh_work_request'
        order by created_at desc
        limit 1`,
      [companyId, workItem.id],
    )
    const eventCounts = await pool.query<CountRow>(
      `select count(*)::int as count
         from context_handoff_events
        where company_id = $1
          and work_item_id = $2::uuid
          and event_type in ('agent.dispatch_queued', 'agent.dispatch_acknowledged')`,
      [companyId, workItem.id],
    )
    const updated = await pool.query<WorkItemRow>(
      `select id::text, status, lane
         from context_work_items
        where company_id = $1 and id = $2::uuid`,
      [companyId, workItem.id],
    )
    const controlPlaneVerification = useRealMeshEndpoint
      ? await verifyControlPlaneDispatch({
          idempotencyKey,
          captureSessionId,
          workItemId: workItem.id,
          timeoutMs: Number(process.env.MESH_DISPATCH_DB_VERIFY_TIMEOUT_MS ?? '5000') || 5000,
        })
      : null
    const callback = await loadDispatchCallback(pool, companyId, workItem.id)
    const dispatchAcknowledgement = await loadDispatchAcknowledgement(pool, companyId, workItem.id)
    const callbackReplay = sitelayerApiUrl
      ? await replayCallback({
          apiUrl: sitelayerApiUrl,
          companySlug,
          workItemId: workItem.id,
          callback,
        })
      : {
          attempted: false,
          accepted: false,
          status: null,
          url: null,
          work_item_status: null,
          event_id: null,
          reason: 'SITELAYER_API_URL not set',
        }
    const outboxRow = outbox.rows[0]
    const firstMeshBody = fakeMesh ? parseJsonMaybe(fakeMesh.requests[0]?.body ?? '') : null
    const output = {
      capture_session_id: captureSessionId,
      company_id: companyId,
      work_item_id: workItem.id,
      analyzer_summary: analyzerSummary,
      dispatch_summary: dispatchSummary,
      dispatch_endpoint: fakeMesh ? 'fake' : 'real',
      dispatch_auto_dispatch: contextWorkDispatchAutoDispatchEnabled(),
      fake_mesh_request_count: fakeMesh?.requests.length ?? null,
      fake_mesh_request: fakeMesh?.requests[0]
        ? {
            method: fakeMesh.requests[0]?.method,
            url: fakeMesh.requests[0]?.url,
            body: redactSensitive(firstMeshBody),
          }
        : null,
      outbox: outboxRow ?? null,
      dispatch_event_count: eventCounts.rows[0]?.count ?? 0,
      dispatch_acknowledgement: dispatchAcknowledgement ? redactSensitive(dispatchAcknowledgement) : null,
      work_item: updated.rows[0] ?? null,
      expected_control_plane_idempotency_key: useRealMeshEndpoint ? idempotencyKey : null,
      control_plane_task: controlPlaneVerification,
      callback_replay: callbackReplay,
    }
    console.log(JSON.stringify(output, null, 2))

    if (!outboxRow) throw new Error('Expected dispatch_mesh_work_request outbox row')
    if (outboxRow.status !== 'applied') throw new Error(`Expected applied outbox row, got ${outboxRow.status}`)
    if (dispatchSummary.failed !== 0) throw new Error(`Dispatch drain failed ${dispatchSummary.failed} row(s)`)
    if (fakeMesh) {
      if (fakeMesh.requests.length < 1) throw new Error('Expected fake Mesh endpoint to receive a dispatch request')
      const meshBody = expectRecord(firstMeshBody, 'fake Mesh request body')
      const properties = expectRecord(meshBody.properties, 'fake Mesh properties')
      const executionContext = expectRecord(meshBody.execution_context, 'fake Mesh execution_context')
      const contextHandoff = expectRecord(executionContext.context_handoff, 'fake Mesh context_handoff')
      const workRequestBrief = expectRecord(executionContext.work_request_brief, 'fake Mesh work_request_brief')
      const captureExport = expectRecord(workRequestBrief.capture_export, 'fake Mesh capture_export')
      const captureExportEnv = expectRecord(captureExport.env, 'fake Mesh capture_export.env')
      const callback = expectRecord(contextHandoff.callback, 'fake Mesh context_handoff.callback')
      expectEqual(meshBody.payload_version, CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION, 'fake Mesh payload_version')
      expectEqual(
        properties.context_handoff_payload_version,
        CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION,
        'fake Mesh properties.context_handoff_payload_version',
      )
      expectEqual(
        executionContext.payload_version,
        CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION,
        'fake Mesh execution_context.payload_version',
      )
      expectEqual(
        contextHandoff.payload_version,
        CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION,
        'fake Mesh context_handoff.payload_version',
      )
      expectEqual(properties.capture_session_id, captureSessionId, 'properties.capture_session_id')
      expectEqual(executionContext.capture_session_id, captureSessionId, 'execution_context.capture_session_id')
      expectEqual(contextHandoff.capture_session_id, captureSessionId, 'context_handoff.capture_session_id')
      expectEqual(workRequestBrief.capture_session_id, captureSessionId, 'work_request_brief.capture_session_id')
      expectEqual(captureExport.command, 'npm run capture:export', 'capture_export.command')
      expectEqual(
        JSON.stringify(captureExport.args),
        JSON.stringify(['--', '--include-artifact-files']),
        'capture_export.args',
      )
      expectEqual(captureExportEnv.CAPTURE_SESSION_ID, captureSessionId, 'capture_export.env.CAPTURE_SESSION_ID')
      if (!callback.token) {
        throw new Error('Expected dispatched Mesh context handoff to include a scoped callback token')
      }
      expectEqual(callback.token_type, 'scoped_bearer', 'fake Mesh context_handoff.callback.token_type')
    }
    if ((eventCounts.rows[0]?.count ?? 0) < 2) {
      throw new Error('Expected both dispatch queued and acknowledged handoff events')
    }
    if (process.env.REQUIRE_MESH_DISPATCH_DB_VERIFY === '1' && !controlPlaneVerification?.found) {
      throw new Error(`Control Plane task verification failed: ${controlPlaneVerification?.reason}`)
    }
    if (process.env.REQUIRE_CAPTURE_CALLBACK_REPLAY === '1' && !callbackReplay.accepted) {
      throw new Error(`Capture callback replay failed: ${callbackReplay.reason ?? 'not accepted'}`)
    }
  } finally {
    restoreEnv('CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH', previousAutoDispatch)
    restoreEnv('CONTEXT_WORK_DISPATCH_AUTO_DISPATCH', previousContextWorkAutoDispatch)
    if (fakeMesh) {
      restoreEnv('MESH_WORK_REQUEST_DISPATCH_URL', previousDispatchUrl)
      restoreEnv('MESH_WORK_REQUEST_DISPATCH_TOKEN', previousDispatchToken)
      await fakeMesh.close().catch(() => undefined)
    }
    await pool.end()
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
