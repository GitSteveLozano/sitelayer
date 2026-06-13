import type { Pool, PoolClient } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { captureWithEntityContext } from '../instrument.js'
import { setCompanyGuc } from '../runner-utils.js'

export const OPS_DIAGNOSTIC_CAPTURE_ROUTE_MUTATION_TYPE = 'ops_diagnostic_capture_route'
export const OPS_DIAGNOSTIC_CAPTURE_ROUTE_MAX_ATTEMPTS = 5

const DEFAULT_CAPTURE_ROUTER_URL = 'http://127.0.0.1:8814'
const DEFAULT_TIMEOUT_MS = 900

export interface OpsDiagnosticCaptureRoutePayload {
  schema?: string
  ops_diagnostic_session_id?: string
  action_event_id?: string
  action_key?: string
  request_ref?: string
  delivery_id?: string
  envelope?: unknown
  last_result?: unknown
}

export interface OpsDiagnosticCaptureRouteResult {
  request_ref: string
  delivery_id: string
  outbox_id: string
  status: 'accepted' | 'failed' | 'not_configured'
  http_status: number | null
  routed: boolean | null
  accepted: number | null
  error: string | null
}

export interface OpsDiagnosticCaptureRouteSummary {
  processed: number
  delivered: number
  failed: number
  skipped: number
}

type ClaimedRouteRow = {
  id: string
  payload: OpsDiagnosticCaptureRoutePayload
  attempt_count: number
}

type DeliveryOutcome = {
  result: OpsDiagnosticCaptureRouteResult
  retryable: boolean
  permanent: boolean
}

export type OpsDiagnosticCaptureRouteRunnerDeps = {
  pool: Pool
  logger: Logger
  fetchImpl?: typeof fetch
  captureRouterUrl?: string | null
  timeoutMs?: number
  maxAttempts?: number
  batchSize?: number
}

export function createOpsDiagnosticCaptureRouteRunner(deps: OpsDiagnosticCaptureRouteRunnerDeps) {
  const {
    pool,
    logger,
    fetchImpl = fetch,
    maxAttempts = OPS_DIAGNOSTIC_CAPTURE_ROUTE_MAX_ATTEMPTS,
    batchSize = 5,
  } = deps

  return async function drainOpsDiagnosticCaptureRoutes(companyId: string): Promise<OpsDiagnosticCaptureRouteSummary> {
    const summary: OpsDiagnosticCaptureRouteSummary = { processed: 0, delivered: 0, failed: 0, skipped: 0 }
    const client = await pool.connect()
    try {
      await client.query('begin')
      await setCompanyGuc(client, companyId)
      const claimed = await client.query<ClaimedRouteRow>(
        `update mutation_outbox
           set status = 'processing',
               attempt_count = attempt_count + 1,
               next_attempt_at = now() + interval '5 minutes',
               error = null,
               updated_at = now()
         where id in (
           select id
             from mutation_outbox
            where company_id = $1
              and mutation_type = $2
              and (
                (status = 'pending' and next_attempt_at <= now())
                or (status = 'processing' and next_attempt_at <= now())
              )
            order by next_attempt_at asc, created_at asc
            limit $3
            for update skip locked
         )
         returning id::text as id, payload, attempt_count`,
        [companyId, OPS_DIAGNOSTIC_CAPTURE_ROUTE_MUTATION_TYPE, batchSize],
      )
      await client.query('commit')

      for (const row of claimed.rows) {
        summary.processed++
        const outcome = await deliverRoute(row, {
          fetchImpl,
          routerUrl: resolveCaptureRouterUrl(deps.captureRouterUrl),
          timeoutMs: resolveTimeoutMs(deps.timeoutMs),
        })
        await client.query('begin')
        await setCompanyGuc(client, companyId)
        try {
          if (outcome.result.status === 'accepted') {
            await markRouteApplied(client, row.id, outcome.result)
            await client.query('commit')
            summary.delivered++
            continue
          }

          const terminal = outcome.permanent || !outcome.retryable || row.attempt_count >= maxAttempts
          await markRouteFailedOrPending(client, row.id, outcome.result, terminal)
          await client.query('commit')
          summary.failed++
          if (terminal) {
            captureWithEntityContext(new Error(outcome.result.error ?? 'ops diagnostic capture route failed'), {
              scope: 'ops_diagnostic_capture_route',
              company_id: companyId,
              extra_tags: { outbox_id: row.id, mutation_type: OPS_DIAGNOSTIC_CAPTURE_ROUTE_MUTATION_TYPE },
            })
          }
        } catch (err) {
          await client.query('rollback').catch(() => {})
          summary.failed++
          logger.error({ err, outbox_id: row.id }, '[ops-diagnostic-capture-route] failed to update outbox row')
          captureWithEntityContext(err, {
            scope: 'ops_diagnostic_capture_route',
            company_id: companyId,
            extra_tags: { outbox_id: row.id, mutation_type: OPS_DIAGNOSTIC_CAPTURE_ROUTE_MUTATION_TYPE },
          })
        }
      }
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    return summary
  }
}

async function deliverRoute(
  row: ClaimedRouteRow,
  opts: { fetchImpl: typeof fetch; routerUrl: string; timeoutMs: number },
): Promise<DeliveryOutcome> {
  const payload = row.payload ?? {}
  const payloadSchema = cleanString(payload.schema)
  const envelope = objectValue(payload.envelope)
  const envelopeDeliveryId = cleanString(envelope?.delivery_id)
  const requestRef =
    cleanString(payload.request_ref) ?? `opsdiag:${cleanString(payload.ops_diagnostic_session_id) ?? 'unknown'}`
  const deliveryId = cleanString(payload.delivery_id) ?? envelopeDeliveryId

  if (payloadSchema && payloadSchema !== 'sitelayer.ops_diagnostic_capture_route.v1') {
    return permanentFailure(
      row.id,
      requestRef,
      deliveryId ?? requestRef,
      `unsupported capture route schema: ${payloadSchema}`,
    )
  }
  if (!deliveryId || !envelope) {
    return permanentFailure(
      row.id,
      requestRef,
      deliveryId ?? requestRef,
      'capture route payload missing delivery_id or envelope',
    )
  }
  if (!opts.routerUrl) {
    return {
      result: {
        request_ref: requestRef,
        delivery_id: deliveryId,
        outbox_id: row.id,
        status: 'not_configured',
        http_status: null,
        routed: null,
        accepted: null,
        error: 'capture router is not configured',
      },
      retryable: true,
      permanent: false,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const response = await opts.fetchImpl(`${opts.routerUrl}/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': deliveryId,
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null)
    const bodyObject = objectValue(body)
    const routed = booleanValue(bodyObject?.routed)
    const accepted = numberValue(bodyObject?.accepted)
    const error = cleanString(bodyObject?.error) ?? cleanString(bodyObject?.reason)
    const result: OpsDiagnosticCaptureRouteResult = {
      request_ref: requestRef,
      delivery_id: deliveryId,
      outbox_id: row.id,
      status: response.ok && routed !== false ? 'accepted' : 'failed',
      http_status: response.status,
      routed,
      accepted,
      error: response.ok ? error : (error ?? `HTTP ${response.status}`),
    }
    return { result, retryable: isRetryableRouteResult(result), permanent: isPermanentRouteResult(result) }
  } catch (err) {
    const error =
      err instanceof Error && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof Error
          ? err.message
          : 'capture router delivery failed'
    return {
      result: {
        request_ref: requestRef,
        delivery_id: deliveryId,
        outbox_id: row.id,
        status: 'failed',
        http_status: null,
        routed: null,
        accepted: null,
        error,
      },
      retryable: true,
      permanent: false,
    }
  } finally {
    clearTimeout(timer)
  }
}

function permanentFailure(
  outboxId: string,
  requestRef: string,
  deliveryId: string,
  error: string,
): DeliveryOutcome {
  return {
    result: {
      request_ref: requestRef,
      delivery_id: deliveryId,
      outbox_id: outboxId,
      status: 'failed',
      http_status: null,
      routed: null,
      accepted: null,
      error,
    },
    retryable: false,
    permanent: true,
  }
}

async function markRouteApplied(
  client: PoolClient,
  outboxId: string,
  result: OpsDiagnosticCaptureRouteResult,
): Promise<void> {
  await client.query(
    `update mutation_outbox
        set status = 'applied',
            applied_at = now(),
            error = null,
            payload = payload || jsonb_build_object('last_result', $2::jsonb),
            updated_at = now()
      where id = $1`,
    [outboxId, JSON.stringify(result)],
  )
}

async function markRouteFailedOrPending(
  client: PoolClient,
  outboxId: string,
  result: OpsDiagnosticCaptureRouteResult,
  terminal: boolean,
): Promise<void> {
  await client.query(
    `update mutation_outbox
        set status = case when $3 then 'failed' else 'pending' end,
            error = $4,
            payload = payload || jsonb_build_object('last_result', $2::jsonb),
            next_attempt_at = case when $3 then now() else now() + interval '2 minutes' end,
            updated_at = now()
      where id = $1`,
    [outboxId, JSON.stringify(result), terminal, result.error],
  )
}

function isRetryableRouteResult(result: OpsDiagnosticCaptureRouteResult): boolean {
  if (result.status === 'accepted') return false
  if (result.status === 'not_configured') return true
  if (result.http_status == null) return true
  return result.http_status === 408 || result.http_status === 429 || result.http_status >= 500
}

function isPermanentRouteResult(result: OpsDiagnosticCaptureRouteResult): boolean {
  if (result.http_status == null) return false
  return result.http_status >= 400 && result.http_status < 500 && result.http_status !== 408 && result.http_status !== 429
}

function resolveCaptureRouterUrl(override: string | null | undefined): string {
  return trimTrailingSlash(
    cleanString(override) ?? cleanString(process.env.SITELAYER_OPS_CAPTURE_ROUTER_URL) ?? DEFAULT_CAPTURE_ROUTER_URL,
  )
}

function resolveTimeoutMs(override: number | undefined): number {
  if (Number.isFinite(override)) return Math.max(250, Math.min(5000, Math.floor(override as number)))
  const parsed = Number(process.env.SITELAYER_OPS_DIAGNOSTICS_TIMEOUT_MS)
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.max(250, Math.min(5000, Math.floor(parsed)))
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}
