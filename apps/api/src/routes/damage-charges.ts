import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_NAME,
  DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_SCHEMA_VERSION,
  transitionDamageChargeSettlementWorkflow,
  type DamageChargeSettlementWorkflowEvent,
  type DamageChargeSettlementWorkflowSnapshot,
  type DamageChargeSettlementWorkflowState,
} from '@sitelayer/workflows'
import { recordMutationOutbox, recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
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
 * Dispatch a damage_charge_settlement workflow event in the same tx as
 * the row mutation. Mirrors the rentals.ts pattern (Phase 2 wiring):
 *   1. Lock the damage_charges row.
 *   2. Run the pure reducer against the persisted snapshot.
 *   3. UPDATE the row with the reducer output, including state_version.
 *   4. Append workflow_event_log row keyed on (entity_id, prior_state_version).
 *
 * Replaces the direct `status='invoiced' / 'waived'` writes that
 * previously bypassed the reducer (the original PR #325 left these
 * untouched — caught in the 2026-05-16 verification audit).
 */
async function applyDamageChargeSettlementTransition(
  client: PoolClient,
  args: {
    companyId: string
    chargeId: string
    event: DamageChargeSettlementWorkflowEvent
    eventType: string
    actorUserId: string
  },
): Promise<
  | { kind: 'ok'; row: DamageChargeRow; nextSnapshot: DamageChargeSettlementWorkflowSnapshot }
  | { kind: 'not_found' }
  | { kind: 'illegal_transition'; message: string }
> {
  const locked = await client.query<DamageChargeRow>(
    `select ${COLUMNS}
       from damage_charges
       where company_id = $1 and id = $2 and deleted_at is null
       for update`,
    [args.companyId, args.chargeId],
  )
  const current = locked.rows[0]
  if (!current) return { kind: 'not_found' as const }
  const currentSnapshot: DamageChargeSettlementWorkflowSnapshot = {
    state: (current.status as DamageChargeSettlementWorkflowState) ?? 'open',
    state_version: current.state_version ?? 1,
    invoiced_at: current.invoiced_at ?? null,
    invoiced_by: current.invoiced_by ?? null,
    waived_at: current.waived_at ?? null,
    waived_by: current.waived_by ?? null,
    waive_reason: current.waive_reason ?? null,
  }
  let nextSnapshot: DamageChargeSettlementWorkflowSnapshot
  try {
    nextSnapshot = transitionDamageChargeSettlementWorkflow(currentSnapshot, args.event)
  } catch (err) {
    return {
      kind: 'illegal_transition' as const,
      message: err instanceof Error ? err.message : String(err),
    }
  }
  const updated = await client.query<DamageChargeRow>(
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
      args.companyId,
      args.chargeId,
      nextSnapshot.state,
      nextSnapshot.state_version,
      nextSnapshot.invoiced_at ?? null,
      nextSnapshot.invoiced_by ?? null,
      nextSnapshot.waived_at ?? null,
      nextSnapshot.waived_by ?? null,
      nextSnapshot.waive_reason ?? null,
    ],
  )
  await recordWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_NAME,
    schemaVersion: DAMAGE_CHARGE_SETTLEMENT_WORKFLOW_SCHEMA_VERSION,
    entityType: 'damage_charge',
    entityId: args.chargeId,
    stateVersion: currentSnapshot.state_version,
    eventType: args.eventType,
    eventPayload: args.event as unknown as Record<string, unknown>,
    snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
    actorUserId: args.actorUserId,
  })
  return { kind: 'ok' as const, row: updated.rows[0]!, nextSnapshot }
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
    const body = await ctx.readBody()
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
      const nowIso = new Date().toISOString()
      const transition = await applyDamageChargeSettlementTransition(client, {
        companyId: ctx.company.id,
        chargeId: id,
        event: { type: 'INVOICE', invoiced_at: nowIso, invoiced_by: ctx.currentUserId },
        eventType: 'INVOICE',
        actorUserId: ctx.currentUserId,
      })
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
    const body = await ctx.readBody()
    const waiveReason = s(body.waive_reason)
    const result = await withMutationTx(async (client: PoolClient) => {
      const nowIso = new Date().toISOString()
      const transition = await applyDamageChargeSettlementTransition(client, {
        companyId: ctx.company.id,
        chargeId: id,
        event: {
          type: 'WAIVE',
          waived_at: nowIso,
          waived_by: ctx.currentUserId,
          waive_reason: waiveReason,
        },
        eventType: 'WAIVE',
        actorUserId: ctx.currentUserId,
      })
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
