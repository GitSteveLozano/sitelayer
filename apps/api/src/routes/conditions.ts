import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidUuid, parseJsonBody } from '../http-utils.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

// Wire-format for the takeoff-condition CRUD bodies. Both create and PATCH
// keep their own field-level coercion (parseOptionalDriver, Number(...),
// HEX_COLOR_RE, etc.) — these schemas only reject malformed shapes up front
// and stay fully permissive: every field optional/nullish, drivers
// string-or-number to match parseOptionalDriver's "5" alongside 5 acceptance,
// no unknown-key rejection.
const NumericInputSchema = z.union([z.number(), z.string()])

const ConditionBodySchema = z
  .object({
    name: z.string().nullish(),
    measurement_kind: z.string().nullish(),
    color: z.string().nullish(),
    height_value: NumericInputSchema.nullish(),
    thickness_value: NumericInputSchema.nullish(),
    slope_value: NumericInputSchema.nullish(),
    sides: NumericInputSchema.nullish(),
    default_assembly_id: z.union([z.string(), z.null()]).optional(),
    emit_linear: z.boolean().nullish(),
    emit_area: z.boolean().nullish(),
    emit_volume: z.boolean().nullish(),
  })
  .loose()

export type ConditionRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const CONDITION_COLUMNS = `id, company_id, name, color, measurement_kind,
  height_value, thickness_value, sides, slope_value, default_assembly_id,
  emit_linear, emit_area, emit_volume, deleted_at, created_at, updated_at`

const MEASUREMENT_KINDS = new Set(['area', 'linear', 'count', 'volume'])

interface ConditionRow {
  id: string
  company_id: string
  name: string
  color: string
  measurement_kind: string
  height_value: string | null
  thickness_value: string | null
  sides: number | null
  slope_value: string | null
  default_assembly_id: string | null
  emit_linear: boolean
  emit_area: boolean
  emit_volume: boolean
  deleted_at: string | null
  created_at: string
  updated_at: string
}

// Default hex green matches the migration default; the picker offers a small
// curated palette but any well-formed #RGB / #RRGGBB hex is accepted.
const DEFAULT_COLOR = '#2f7d32'
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

// Optional non-negative numeric driver (height / thickness / slope). Returns
// `undefined` when the field is absent (leave unchanged on PATCH) and `null`
// when explicitly cleared. Throws HttpError(400) on a malformed value.
function parseOptionalDriver(raw: unknown, label: string): number | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpError(400, `${label} must be a non-negative number`)
  }
  return n
}

/**
 * Condition layer (Takeoff Deep Dive H1) — company-scoped CRUD for reusable
 * typed takeoff templates. A Condition fixes the measurement kind + drivers
 * (height / thickness / sides / slope) + an optional default assembly so an
 * estimator draws condition-first instead of re-specifying scope per polygon.
 *
 * Endpoints (all company-scoped via withCompanyClient / withMutationTx):
 *   GET    /api/takeoff/conditions            — list live (non-deleted) conditions
 *   POST   /api/takeoff/conditions            — create
 *   PATCH  /api/takeoff/conditions/:id        — partial update
 *   DELETE /api/takeoff/conditions/:id        — soft-delete (sets deleted_at)
 *
 * Additive: this is a NEW resource. Existing tag-based measurements are
 * untouched; `takeoff_measurements.condition_id` is nullable and the tag flow
 * remains the fallback (migration 137, deep-dive §7 risk #2).
 */
export async function handleConditionRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ConditionRouteCtx,
): Promise<boolean> {
  const collectionMatch = url.pathname === '/api/takeoff/conditions'

  if (req.method === 'GET' && collectionMatch) {
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<ConditionRow>(
        `select ${CONDITION_COLUMNS}
         from takeoff_conditions
         where company_id = $1 and deleted_at is null
         order by lower(name) asc, created_at asc`,
        [ctx.company.id],
      ),
    )
    ctx.sendJson(200, { conditions: result.rows })
    return true
  }

  if (req.method === 'POST' && collectionMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const parsedCreate = parseJsonBody(ConditionBodySchema, await ctx.readBody())
    if (!parsedCreate.ok) {
      ctx.sendJson(400, { error: parsedCreate.error })
      return true
    }
    const body = parsedCreate.value

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    if (name.length > 120) {
      ctx.sendJson(400, { error: 'name must be 120 characters or fewer' })
      return true
    }

    const measurementKind =
      typeof body.measurement_kind === 'string' && body.measurement_kind.trim() ? body.measurement_kind.trim() : 'area'
    if (!MEASUREMENT_KINDS.has(measurementKind)) {
      ctx.sendJson(400, { error: 'measurement_kind must be one of: area, linear, count, volume' })
      return true
    }

    let color = typeof body.color === 'string' && body.color.trim() ? body.color.trim() : DEFAULT_COLOR
    if (!HEX_COLOR_RE.test(color)) color = DEFAULT_COLOR

    let heightValue: number | null
    let thicknessValue: number | null
    let slopeValue: number | null
    try {
      heightValue = parseOptionalDriver(body.height_value, 'height_value') ?? null
      thicknessValue = parseOptionalDriver(body.thickness_value, 'thickness_value') ?? null
      slopeValue = parseOptionalDriver(body.slope_value, 'slope_value') ?? null
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }

    let sides: number | null = null
    if (body.sides !== undefined && body.sides !== null) {
      const s = Number(body.sides)
      if (s !== 1 && s !== 2) {
        ctx.sendJson(400, { error: 'sides must be 1 or 2' })
        return true
      }
      sides = s
    }

    const defaultAssemblyId =
      typeof body.default_assembly_id === 'string' && body.default_assembly_id.trim()
        ? body.default_assembly_id.trim()
        : null
    if (defaultAssemblyId && !isValidUuid(defaultAssemblyId)) {
      ctx.sendJson(400, { error: 'default_assembly_id must be a valid uuid' })
      return true
    }

    // Default the emit flag to the condition's own measurement_kind so a
    // freshly created condition derives the obvious result; callers override
    // explicitly to emit additional results (e.g. an area condition that also
    // emits perimeter LF). count has no derived quantity result, so it
    // defaults all-off.
    const emitLinear = body.emit_linear === undefined ? measurementKind === 'linear' : body.emit_linear === true
    const emitArea = body.emit_area === undefined ? measurementKind === 'area' : body.emit_area === true
    const emitVolume = body.emit_volume === undefined ? measurementKind === 'volume' : body.emit_volume === true

    const created = await withMutationTx(async (client: PoolClient) => {
      // Guard the default assembly belongs to this company (defense in depth —
      // the FK only checks existence, not tenancy). Skip when none supplied.
      if (defaultAssemblyId) {
        const owns = await client.query<{ exists: boolean }>(
          `select exists(
             select 1 from service_item_assemblies
             where company_id = $1 and id = $2 and deleted_at is null
           ) as exists`,
          [ctx.company.id, defaultAssemblyId],
        )
        if (!owns.rows[0]?.exists) {
          throw new HttpError(400, 'default_assembly_id does not belong to this company')
        }
      }
      const inserted = await client.query<ConditionRow>(
        `insert into takeoff_conditions
           (company_id, name, color, measurement_kind, height_value, thickness_value,
            sides, slope_value, default_assembly_id, emit_linear, emit_area, emit_volume, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning ${CONDITION_COLUMNS}`,
        [
          ctx.company.id,
          name,
          color,
          measurementKind,
          heightValue,
          thicknessValue,
          sides,
          slopeValue,
          defaultAssemblyId,
          emitLinear,
          emitArea,
          emitVolume,
          ctx.currentUserId,
        ],
      )
      const row = inserted.rows[0]
      if (!row) throw new HttpError(500, 'takeoff condition insert returned no row')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_condition',
        entityId: row.id,
        action: 'create',
        row,
        actorUserId: ctx.currentUserId,
      })
      return row
    }).catch((err) => {
      // Unique (company, lower(name)) collision → 409 instead of a raw 500.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'a condition with this name already exists')
      }
      throw err
    })
    ctx.sendJson(201, { condition: created })
    return true
  }

  const itemMatch = url.pathname.match(/^\/api\/takeoff\/conditions\/([^/]+)$/)

  if (req.method === 'PATCH' && itemMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const conditionId = itemMatch[1]!
    if (!isValidUuid(conditionId)) {
      ctx.sendJson(400, { error: 'condition id must be a valid uuid' })
      return true
    }
    const parsedPatch = parseJsonBody(ConditionBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value

    const sets: string[] = []
    const params: unknown[] = [ctx.company.id, conditionId]
    const push = (col: string, value: unknown) => {
      params.push(value)
      sets.push(`${col} = $${params.length}`)
    }

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        ctx.sendJson(400, { error: 'name must not be empty' })
        return true
      }
      if (name.length > 120) {
        ctx.sendJson(400, { error: 'name must be 120 characters or fewer' })
        return true
      }
      push('name', name)
    }
    if (body.color !== undefined) {
      const color = typeof body.color === 'string' ? body.color.trim() : ''
      if (!HEX_COLOR_RE.test(color)) {
        ctx.sendJson(400, { error: 'color must be a #RGB or #RRGGBB hex string' })
        return true
      }
      push('color', color)
    }
    if (body.measurement_kind !== undefined) {
      const kind = typeof body.measurement_kind === 'string' ? body.measurement_kind.trim() : ''
      if (!MEASUREMENT_KINDS.has(kind)) {
        ctx.sendJson(400, { error: 'measurement_kind must be one of: area, linear, count, volume' })
        return true
      }
      push('measurement_kind', kind)
    }
    try {
      const height = parseOptionalDriver(body.height_value, 'height_value')
      if (height !== undefined) push('height_value', height)
      const thickness = parseOptionalDriver(body.thickness_value, 'thickness_value')
      if (thickness !== undefined) push('thickness_value', thickness)
      const slope = parseOptionalDriver(body.slope_value, 'slope_value')
      if (slope !== undefined) push('slope_value', slope)
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    if (body.sides !== undefined) {
      if (body.sides === null) {
        push('sides', null)
      } else {
        const s = Number(body.sides)
        if (s !== 1 && s !== 2) {
          ctx.sendJson(400, { error: 'sides must be 1 or 2' })
          return true
        }
        push('sides', s)
      }
    }
    let patchAssemblyId: string | null | undefined
    if (body.default_assembly_id !== undefined) {
      if (body.default_assembly_id === null || body.default_assembly_id === '') {
        patchAssemblyId = null
        push('default_assembly_id', null)
      } else {
        const aid = String(body.default_assembly_id).trim()
        if (!isValidUuid(aid)) {
          ctx.sendJson(400, { error: 'default_assembly_id must be a valid uuid' })
          return true
        }
        patchAssemblyId = aid
        push('default_assembly_id', aid)
      }
    }
    if (body.emit_linear !== undefined) push('emit_linear', body.emit_linear === true)
    if (body.emit_area !== undefined) push('emit_area', body.emit_area === true)
    if (body.emit_volume !== undefined) push('emit_volume', body.emit_volume === true)

    if (sets.length === 0) {
      ctx.sendJson(400, { error: 'no editable fields supplied' })
      return true
    }

    const updated = await withMutationTx(async (client: PoolClient) => {
      if (patchAssemblyId) {
        const owns = await client.query<{ exists: boolean }>(
          `select exists(
             select 1 from service_item_assemblies
             where company_id = $1 and id = $2 and deleted_at is null
           ) as exists`,
          [ctx.company.id, patchAssemblyId],
        )
        if (!owns.rows[0]?.exists) {
          throw new HttpError(400, 'default_assembly_id does not belong to this company')
        }
      }
      const result = await client.query<ConditionRow>(
        `update takeoff_conditions
           set ${sets.join(', ')}, updated_at = now()
         where company_id = $1 and id = $2 and deleted_at is null
         returning ${CONDITION_COLUMNS}`,
        params,
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_condition',
        entityId: row.id,
        action: 'update',
        row,
        actorUserId: ctx.currentUserId,
      })
      return row
    }).catch((err) => {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'a condition with this name already exists')
      }
      throw err
    })
    if (!updated) {
      ctx.sendJson(404, { error: 'condition not found' })
      return true
    }
    ctx.sendJson(200, { condition: updated })
    return true
  }

  if (req.method === 'DELETE' && itemMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const conditionId = itemMatch[1]!
    if (!isValidUuid(conditionId)) {
      ctx.sendJson(400, { error: 'condition id must be a valid uuid' })
      return true
    }
    // Soft-delete only. Measurements that reference this condition keep their
    // condition_id (the FK is ON DELETE SET NULL only on a HARD delete, which
    // we never issue) so historical attribution survives; the picker simply
    // stops listing the retired condition.
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<ConditionRow>(
        `update takeoff_conditions
           set deleted_at = now(), updated_at = now()
         where company_id = $1 and id = $2 and deleted_at is null
         returning ${CONDITION_COLUMNS}`,
        [ctx.company.id, conditionId],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'takeoff_condition',
        entityId: row.id,
        action: 'delete',
        row,
        actorUserId: ctx.currentUserId,
      })
      return row
    })
    if (!deleted) {
      ctx.sendJson(404, { error: 'condition not found' })
      return true
    }
    ctx.sendJson(200, { condition: deleted })
    return true
  }

  return false
}

/**
 * Self-registered dispatch descriptor for the `conditions` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const conditionsRouteDescriptor: DispatchRouteDescriptor = {
  name: 'conditions',
  order: 350,
  handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
    handleConditionRoutes(req, url, {
      pool,
      company,
      currentUserId,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
    }),
}
