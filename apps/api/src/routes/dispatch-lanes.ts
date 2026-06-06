// Dispatch lanes admin API. Backs the operator UI for the kill-switch
// primitive (Wedge 5 of the proving-ground plan). Lanes are a global
// runtime concern, not per-company — see migration 094 for the table
// definition and the worker-side dispatch-lanes.ts for the runtime gate.
//
// All endpoints are admin-only. POST writes a `dispatch_lane_decisions`
// row so the audit trail is recoverable independent of the lane's
// current state.

import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { parseJsonBody } from '../http-utils.js'

export type DispatchLaneRouteCtx = {
  pool: Pool
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  getCurrentUserId: () => string
}

const LaneState = z.enum(['active', 'paused', 'degraded'])

const PauseBodySchema = z
  .object({
    reason: z.string(),
    resume_after: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

const ResumeBodySchema = z
  .object({
    reason: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

interface LaneRow {
  name: string
  state: 'active' | 'paused' | 'degraded'
  pause_reason: string
  paused_at: string | null
  resume_after: string | null
  last_decided_by: string
  last_decided_at: string
  metadata: Record<string, unknown>
}

async function listLanes(pool: Pool): Promise<LaneRow[]> {
  const result = await pool.query<LaneRow>(
    `select name, state, pause_reason, paused_at, resume_after,
            last_decided_by, last_decided_at, metadata
       from dispatch_lanes
      order by name asc`,
  )
  return result.rows
}

async function applyLaneTransition(
  pool: Pool,
  args: {
    name: string
    to_state: 'active' | 'paused' | 'degraded'
    reason: string
    decided_by: string
    resume_after: Date | null
    metadata: Record<string, unknown> | null
  },
): Promise<{ ok: true; lane: LaneRow } | { ok: false; status: number; error: string }> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('begin')
    const current = await client.query<{ state: 'active' | 'paused' | 'degraded' }>(
      `select state from dispatch_lanes where name = $1 for update`,
      [args.name],
    )
    const row = current.rows[0]
    if (!row) {
      await client.query('rollback')
      return { ok: false, status: 404, error: `lane not found: ${args.name}` }
    }
    const fromState = row.state
    const pausedAt = args.to_state === 'paused' || args.to_state === 'degraded' ? new Date() : null
    const update = await client.query<LaneRow>(
      `update dispatch_lanes
          set state = $2,
              pause_reason = $3,
              paused_at = $4,
              resume_after = $5,
              last_decided_by = $6,
              last_decided_at = now(),
              metadata = coalesce($7::jsonb, metadata),
              updated_at = now()
        where name = $1
        returning name, state, pause_reason, paused_at, resume_after,
                  last_decided_by, last_decided_at, metadata`,
      [
        args.name,
        args.to_state,
        args.reason,
        pausedAt,
        args.resume_after,
        args.decided_by,
        args.metadata ? JSON.stringify(args.metadata) : null,
      ],
    )
    // Always record a decision row, even on no-op transitions — operator
    // intent is auditable separate from the resulting state diff.
    await client.query(
      `insert into dispatch_lane_decisions
         (lane_name, from_state, to_state, reason, decided_by, metadata)
       values ($1, $2, $3, $4, $5, coalesce($6::jsonb, '{}'::jsonb))`,
      [
        args.name,
        fromState,
        args.to_state,
        args.reason,
        args.decided_by,
        args.metadata ? JSON.stringify(args.metadata) : null,
      ],
    )
    await client.query('commit')
    const updatedRow = update.rows[0]
    if (!updatedRow) {
      // Defensive — UPDATE returning should always produce a row when the
      // SELECT ... FOR UPDATE found one. If it doesn't, something is very
      // wrong; surface as 500 rather than silently coercing.
      return { ok: false, status: 500, error: 'lane row vanished mid-transaction' }
    }
    return { ok: true, lane: updatedRow }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function parseResumeAfter(raw: string | null | undefined): Date | null | { error: string } {
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return { error: 'invalid resume_after ISO timestamp' }
  return date
}

/**
 * Handle dispatch-lanes routes. Mounted under /api/admin/dispatch-lanes
 * because the table is admin-only.
 */
export async function handleDispatchLaneRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: DispatchLaneRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/admin/dispatch-lanes') {
    if (!ctx.requireRole(['admin'])) return true
    const lanes = await listLanes(ctx.pool)
    ctx.sendJson(200, { lanes })
    return true
  }

  const pauseMatch = url.pathname.match(/^\/api\/admin\/dispatch-lanes\/([A-Za-z0-9_-]+)\/pause$/)
  if (req.method === 'POST' && pauseMatch) {
    if (!ctx.requireRole(['admin'])) return true
    const name = pauseMatch[1] ?? ''
    if (!name) {
      ctx.sendJson(400, { error: 'lane name required' })
      return true
    }
    const parsed = parseJsonBody(PauseBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const reason = parsed.value.reason.trim()
    if (!reason) {
      ctx.sendJson(400, { error: 'reason is required' })
      return true
    }
    const resumeAfter = parseResumeAfter(parsed.value.resume_after ?? null)
    if (resumeAfter && typeof resumeAfter === 'object' && 'error' in resumeAfter) {
      ctx.sendJson(400, { error: resumeAfter.error })
      return true
    }
    const result = await applyLaneTransition(ctx.pool, {
      name,
      to_state: 'paused',
      reason,
      decided_by: ctx.getCurrentUserId() || 'unknown',
      resume_after: resumeAfter as Date | null,
      metadata: parsed.value.metadata ?? null,
    })
    if (!result.ok) {
      ctx.sendJson(result.status, { error: result.error })
      return true
    }
    ctx.sendJson(200, { lane: result.lane })
    return true
  }

  const resumeMatch = url.pathname.match(/^\/api\/admin\/dispatch-lanes\/([A-Za-z0-9_-]+)\/resume$/)
  if (req.method === 'POST' && resumeMatch) {
    if (!ctx.requireRole(['admin'])) return true
    const name = resumeMatch[1] ?? ''
    if (!name) {
      ctx.sendJson(400, { error: 'lane name required' })
      return true
    }
    const parsed = parseJsonBody(ResumeBodySchema, await ctx.readBody())
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const reason = parsed.value.reason.trim()
    if (!reason) {
      ctx.sendJson(400, { error: 'reason is required' })
      return true
    }
    const result = await applyLaneTransition(ctx.pool, {
      name,
      to_state: 'active',
      reason,
      decided_by: ctx.getCurrentUserId() || 'unknown',
      resume_after: null,
      metadata: parsed.value.metadata ?? null,
    })
    if (!result.ok) {
      ctx.sendJson(result.status, { error: result.error })
      return true
    }
    ctx.sendJson(200, { lane: result.lane })
    return true
  }

  return false
}

export { LaneState as DispatchLaneStateSchema }
