import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_NAME,
  damageChargeSettlementWorkflow,
  nextDamageChargeSettlementEvents,
  parseDamageChargeSettlementEventRequest,
  type DamageChargeSettlementHumanEventType,
  type DamageChargeSettlementWorkflowEvent,
  type DamageChargeSettlementWorkflowSnapshot,
  type DamageChargeSettlementWorkflowState,
  type WorkflowSnapshot,
} from '@sitelayer/workflows'
import { z } from 'zod'
import { HttpError, parseJsonBody } from '../http-utils.js'

// POST /api/projects/:id/damage-charges wire-format. Mirrors the existing
// inline helpers (`s()`, `num()`) — every text field is a string (or
// null), every numeric is string-or-number. Schema rejects malformed
// shapes up front; the helpers continue to trim / coerce defensively.
const StringOrNullSchema = z.union([z.string(), z.null()])
const NumericInputSchema = z.union([z.number(), z.string()])

const DamageChargeCreateBodySchema = z
  .object({
    kind: z.string().optional(),
    description: z.string().optional(),
    quantity: NumericInputSchema.nullish(),
    unit_amount: NumericInputSchema.nullish(),
    total_amount: NumericInputSchema.nullish(),
    customer_id: StringOrNullSchema.optional(),
    shipment_id: StringOrNullSchema.optional(),
    shipment_line_id: StringOrNullSchema.optional(),
    inventory_item_id: StringOrNullSchema.optional(),
    catalog_part_id: StringOrNullSchema.optional(),
    taxable: z.boolean().nullish(),
    notes: z.string().nullish(),
  })
  .loose()

const DamageChargeWaiveBodySchema = z
  .object({
    waive_reason: z.string().nullish(),
  })
  .loose()
import { observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { recordMutationOutbox, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { dispatchWorkflowEvent } from '../workflow-dispatch.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

/**
 * Damage / loss / late-return / cleanup charges.
 *
 * A charge is created when a shipment return comes up short, a unit is
 * flagged damaged, or a project closeout finds an unbilled exception.
 * Invoicing it enqueues a single mutation_outbox row keyed by the charge
 * id; the existing worker drain reuses the QBO push idempotency surface.
 */
export type DamageChargeRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const COLUMNS = `
  id, company_id, project_id, customer_id, shipment_id, shipment_line_id,
  inventory_item_id, catalog_part_id, kind, quantity, unit_amount,
  total_amount, description, taxable, status, state_version, qbo_invoice_id,
  invoiced_at, invoiced_by, waived_at, waived_by, waive_reason, notes,
  version, deleted_at, created_at, updated_at
`

function s(v: unknown): string | null {
  if (v == null) return null
  const text = String(v).trim()
  return text ? text : null
}
function num(v: unknown): number {
  if (v == null || v === '') return 0
  const parsed = Number(v)
  return Number.isFinite(parsed) ? parsed : 0
}

type DamageChargeRow = {
  id: string
  status: DamageChargeSettlementWorkflowState
  state_version: number
  invoiced_at: string | null
  invoiced_by: string | null
  waived_at: string | null
  waived_by: string | null
  waive_reason: string | null
  version: number
} & Record<string, unknown>

/**
 * WorkflowSnapshot context for a damage charge. Carries the descriptive
 * row columns the detail UI renders (amounts, kind, refs) plus the
 * settlement trail (invoiced / waived stamps). `state` / `state_version`
 * / `next_events` live on the envelope so screens never reinvent the
 * vocabulary — same shape as `billingRunWorkflowSnapshotResponse`.
 */
type DamageChargeWorkflowContext = {
  id: string
  project_id: unknown
  customer_id: unknown
  shipment_id: unknown
  shipment_line_id: unknown
  inventory_item_id: unknown
  catalog_part_id: unknown
  kind: unknown
  quantity: unknown
  unit_amount: unknown
  total_amount: unknown
  description: unknown
  taxable: unknown
  qbo_invoice_id: unknown
  invoiced_at: string | null
  invoiced_by: string | null
  waived_at: string | null
  waived_by: string | null
  waive_reason: string | null
  notes: unknown
  created_at: unknown
  updated_at: unknown
}

function damageChargeWorkflowSnapshotResponse(
  row: DamageChargeRow,
): WorkflowSnapshot<
  DamageChargeSettlementWorkflowState,
  DamageChargeSettlementHumanEventType,
  DamageChargeWorkflowContext
> {
  const state = (row.status as DamageChargeSettlementWorkflowState) ?? 'open'
  return {
    state,
    state_version: row.state_version ?? 1,
    context: {
      id: row.id,
      project_id: row.project_id,
      customer_id: row.customer_id,
      shipment_id: row.shipment_id,
      shipment_line_id: row.shipment_line_id,
      inventory_item_id: row.inventory_item_id,
      catalog_part_id: row.catalog_part_id,
      kind: row.kind,
      quantity: row.quantity,
      unit_amount: row.unit_amount,
      total_amount: row.total_amount,
      description: row.description,
      taxable: row.taxable,
      qbo_invoice_id: row.qbo_invoice_id,
      invoiced_at: row.invoiced_at,
      invoiced_by: row.invoiced_by,
      waived_at: row.waived_at,
      waived_by: row.waived_by,
      waive_reason: row.waive_reason,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    next_events: nextDamageChargeSettlementEvents(state),
  }
}

/**
 * Build a reducer-ready event from a human-issued event type. Mirrors
 * `buildReducerEvent` in rental-billing-state.ts — the route stays
 * focused on transactional persistence and the reducer owns semantics.
 */
function buildDamageChargeReducerEvent(
  eventType: DamageChargeSettlementHumanEventType,
  actorUserId: string,
  waiveReason: string | null,
): DamageChargeSettlementWorkflowEvent {
  const nowIso = new Date().toISOString()
  if (eventType === 'INVOICE') {
    return { type: 'INVOICE', invoiced_at: nowIso, invoiced_by: actorUserId }
  }
  return { type: 'WAIVE', waived_at: nowIso, waived_by: actorUserId, waive_reason: waiveReason }
}

function rowToSettlementSnapshot(row: DamageChargeRow): DamageChargeSettlementWorkflowSnapshot {
  return {
    state: (row.status as DamageChargeSettlementWorkflowState) ?? 'open',
    state_version: row.state_version ?? 1,
    invoiced_at: row.invoiced_at ?? null,
    invoiced_by: row.invoiced_by ?? null,
    waived_at: row.waived_at ?? null,
    waived_by: row.waived_by ?? null,
    waive_reason: row.waive_reason ?? null,
  }
}

/**
 * Dispatch a damage_charge_settlement workflow event in the same tx as
 * the row mutation, through the generic `dispatchWorkflowEvent`
 * primitive: FOR UPDATE lock + post-lock state_version check + pure
 * reduce + the single UPDATE + the always-appended workflow_event_log
 * row keyed on (entity_id, prior_state_version). Shared by the
 * canonical `/events` route and the legacy `/invoice` / `/waive`
 * aliases so the surfaces cannot drift.
 *
 * Replaces the direct `status='invoiced' / 'waived'` writes that
 * previously bypassed the reducer (the original PR #325 left these
 * untouched — caught in the 2026-05-16 verification audit).
 */
function dispatchDamageChargeSettlementEvent(
  client: PoolClient,
  ctx: DamageChargeRouteCtx,
  chargeId: string,
  buildEvent: () => DamageChargeSettlementWorkflowEvent,
  /**
   * The workflow state_version the caller is acting on. `null` disables
   * the optimistic check (the legacy /invoice and /waive aliases, which
   * never carried one). We capture the resolved value so the primitive's
   * post-lock compare is satisfied with the row's own state_version when
   * the caller opts out.
   */
  expectedStateVersion: number | null,
) {
  let resolvedExpected = expectedStateVersion ?? -1
  return dispatchWorkflowEvent<
    DamageChargeRow,
    DamageChargeSettlementWorkflowSnapshot,
    DamageChargeSettlementWorkflowEvent
  >(client, {
    definition: damageChargeSettlementWorkflow,
    companyId: ctx.company.id,
    entityType: 'damage_charge',
    entityId: chargeId,
    get expectedStateVersion() {
      return resolvedExpected
    },
    actorUserId: ctx.currentUserId,
    loadSnapshot: async (c) => {
      const locked = await c.query<DamageChargeRow>(
        `select ${COLUMNS}
             from damage_charges
             where company_id = $1 and id = $2 and deleted_at is null
             for update`,
        [ctx.company.id, chargeId],
      )
      const row = locked.rows[0]
      if (!row) return null
      const snapshot = rowToSettlementSnapshot(row)
      if (expectedStateVersion === null) resolvedExpected = snapshot.state_version
      return { row, snapshot }
    },
    buildEvent,
    persist: async (c, next) => {
      const updated = await c.query<DamageChargeRow>(
        `update damage_charges
             set status = $3,
                 state_version = $4,
                 invoiced_at = $5,
                 invoiced_by = $6,
                 waived_at = $7,
                 waived_by = $8,
                 waive_reason = $9,
                 version = version + 1,
                 updated_at = now()
           where company_id = $1 and id = $2
           returning ${COLUMNS}`,
        [
          ctx.company.id,
          chargeId,
          next.state,
          next.state_version,
          next.invoiced_at ?? null,
          next.invoiced_by ?? null,
          next.waived_at ?? null,
          next.waived_by ?? null,
          next.waive_reason ?? null,
        ],
      )
      const updatedRow = updated.rows[0]
      if (!updatedRow) throw new HttpError(500, 'damage charge update returned no row')
      return updatedRow
    },
    sideEffects: async (_c, _next, _row, event) => {
      const outcome = workflowEventOutcome(event.type)
      if (outcome) observeWorkflowEvent(DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_NAME, outcome)
    },
  })
}

export async function handleDamageChargeRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: DamageChargeRouteCtx,
): Promise<boolean> {
  // List per project.
  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/damage-charges$/)
  if (req.method === 'GET' && listMatch) {
    const projectId = listMatch[1]!
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${COLUMNS} from damage_charges
       where company_id = $1 and project_id = $2 and deleted_at is null
       order by created_at desc`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { charges: result.rows })
    return true
  }
  if (req.method === 'POST' && listMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = listMatch[1]!
    const parsed = parseJsonBody(DamageChargeCreateBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const body = parsed.value
    const kind = s(body.kind)
    const description = s(body.description)
    if (!kind || !['damage', 'loss', 'late_return', 'cleanup'].includes(kind)) {
      ctx.sendJson(400, { error: 'kind must be damage|loss|late_return|cleanup' })
      return true
    }
    if (!description) {
      ctx.sendJson(400, { error: 'description is required' })
      return true
    }
    const quantity = num(body.quantity)
    const unitAmount = num(body.unit_amount)
    const totalAmount =
      body.total_amount != null ? num(body.total_amount) : Math.round(quantity * unitAmount * 100) / 100
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into damage_charges (
        company_id, project_id, customer_id, shipment_id, shipment_line_id,
        inventory_item_id, catalog_part_id, kind, quantity, unit_amount,
        total_amount, description, taxable, notes
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13,true),$14)
      returning ${COLUMNS}`,
        [
          ctx.company.id,
          projectId,
          s(body.customer_id),
          s(body.shipment_id),
          s(body.shipment_line_id),
          s(body.inventory_item_id),
          s(body.catalog_part_id),
          kind,
          quantity,
          unitAmount,
          totalAmount,
          description,
          body.taxable,
          s(body.notes),
        ],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  // WorkflowSnapshot for a single charge — `{ state, state_version,
  // context, next_events }`. Entry surface for the headless settlement
  // detail UI; mirrors GET /api/rental-billing-runs/:id. The `/events`
  // and `/invoice` / `/waive` suffix routes below are matched first by
  // their own regexes, so this bare-id GET only catches the snapshot.
  const snapshotMatch = url.pathname.match(/^\/api\/damage-charges\/([^/]+)$/)
  if (req.method === 'GET' && snapshotMatch) {
    const id = snapshotMatch[1]!
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<DamageChargeRow>(
        `select ${COLUMNS} from damage_charges
         where company_id = $1 and id = $2 and deleted_at is null
         limit 1`,
        [ctx.company.id, id],
      ),
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'charge not found' })
      return true
    }
    ctx.sendJson(200, damageChargeWorkflowSnapshotResponse(row))
    return true
  }

  // Generic workflow event surface — `{ event, state_version }`. Applies
  // the damage_charge_settlement reducer in one tx with an optimistic
  // post-lock state_version check (409 on stale or illegal transition).
  // Mirrors POST /api/rental-billing-runs/:id/events. INVOICE additionally
  // enqueues the stable-keyed `damage_charge_invoice_push` outbox row that
  // the existing QBO push worker drains. The legacy `/invoice` and
  // `/waive` routes below remain for back-compat callers.
  const eventMatch = url.pathname.match(/^\/api\/damage-charges\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = eventMatch[1]!
    const parsed = parseDamageChargeSettlementEventRequest(await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion, waive_reason: waiveReason } = parsed.value
    const result = await withMutationTx(async (client: PoolClient) => {
      // Post-lock optimistic version check lives in the primitive —
      // concurrent POSTs with the same state_version serialize on the
      // row lock; the loser sees the bumped version and 409s instead of
      // re-running the reducer.
      const transition = await dispatchDamageChargeSettlementEvent(
        client,
        ctx,
        id,
        () =>
          buildDamageChargeReducerEvent(
            eventType as DamageChargeSettlementHumanEventType,
            ctx.currentUserId,
            waiveReason ?? null,
          ),
        stateVersion,
      )
      // INVOICE side effect: enqueue the existing QBO push outbox row with
      // the stable per-charge idempotency key — same key as the legacy
      // /invoice route so retries collapse onto one outbox row.
      if (transition.kind === 'ok' && eventType === 'INVOICE') {
        await recordMutationOutbox(
          ctx.company.id,
          'damage_charge',
          id,
          'damage_charge_invoice_push',
          transition.row,
          `damage_charge_invoice:${id}`,
          'server',
          ctx.currentUserId,
          client,
        )
      }
      return transition
    })
    if (result.kind === 'not_found') {
      ctx.sendJson(404, { error: 'charge not found' })
      return true
    }
    if (result.kind === 'version_conflict') {
      ctx.sendJson(409, {
        error: 'state_version mismatch — reload and retry',
        snapshot: damageChargeWorkflowSnapshotResponse(result.row),
      })
      return true
    }
    if (result.kind === 'illegal_transition') {
      ctx.sendJson(409, {
        error: result.message,
        snapshot: damageChargeWorkflowSnapshotResponse(result.row),
      })
      return true
    }
    ctx.sendJson(200, damageChargeWorkflowSnapshotResponse(result.row))
    return true
  }

  // Invoice the charge — dispatch INVOICE through the
  // damage_charge_settlement reducer in the same tx as the row mutation
  // and enqueue the existing outbox row for the QBO push worker. The
  // reducer is the single source of truth for the open → invoiced
  // transition; the outbox row remains the side-effect channel.
  const invoiceMatch = url.pathname.match(/^\/api\/damage-charges\/([^/]+)\/invoice$/)
  if (req.method === 'POST' && invoiceMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = invoiceMatch[1]!
    const result = await withMutationTx(async (client: PoolClient) => {
      const transition = await dispatchDamageChargeSettlementEvent(
        client,
        ctx,
        id,
        () => ({ type: 'INVOICE', invoiced_at: new Date().toISOString(), invoiced_by: ctx.currentUserId }),
        null,
      )
      if (transition.kind === 'not_found') return { error: 'charge not found' as const, code: 404 as const }
      if (transition.kind === 'illegal_transition') {
        return { error: transition.message, code: 409 as const }
      }
      await recordMutationOutbox(
        ctx.company.id,
        'damage_charge',
        id,
        'damage_charge_invoice_push',
        transition.row,
        `damage_charge_invoice:${id}`,
        'server',
        ctx.currentUserId,
        client,
      )
      return { charge: transition.row }
    })
    if ('error' in result) {
      ctx.sendJson(result.code ?? 400, { error: result.error })
      return true
    }
    ctx.sendJson(200, result.charge)
    return true
  }

  // Waive the charge — dispatch WAIVE through the reducer in the same tx.
  const waiveMatch = url.pathname.match(/^\/api\/damage-charges\/([^/]+)\/waive$/)
  if (req.method === 'POST' && waiveMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = waiveMatch[1]!
    const parsedWaive = parseJsonBody(DamageChargeWaiveBodySchema, await ctx.readBody())
    if (!parsedWaive.ok) {
      ctx.sendJson(400, { error: parsedWaive.error })
      return true
    }
    const waiveReason = s(parsedWaive.value.waive_reason)
    const result = await withMutationTx(async (client: PoolClient) => {
      const transition = await dispatchDamageChargeSettlementEvent(
        client,
        ctx,
        id,
        () => ({
          type: 'WAIVE',
          waived_at: new Date().toISOString(),
          waived_by: ctx.currentUserId,
          waive_reason: waiveReason,
        }),
        null,
      )
      return transition
    })
    if (result.kind === 'not_found') {
      ctx.sendJson(404, { error: 'charge not found' })
      return true
    }
    if (result.kind === 'illegal_transition') {
      ctx.sendJson(409, { error: result.message })
      return true
    }
    ctx.sendJson(200, result.row)
    return true
  }

  return false
}
