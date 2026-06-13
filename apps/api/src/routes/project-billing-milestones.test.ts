import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import type pino from 'pino'
import type http from 'node:http'
import { attachMutationTx } from '../mutation-tx.js'
import {
  handleProjectBillingMilestoneRoutes,
  type ProjectBillingMilestoneRouteCtx,
} from './project-billing-milestones.js'

// ---------------------------------------------------------------------------
// AR payment-realization: the milestone `status` is a closed 3-value domain
// (`not_yet | invoiced | paid`). These tests pin that an out-of-domain status
// is rejected at PARSE time (→ 400) on the PATCH path — before any DB write —
// and that a valid status is accepted and applied. The create path is covered
// by the same `MilestoneStatusSchema.optional()` shared between both bodies.
// ---------------------------------------------------------------------------

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const MILESTONE_ID = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'

type Captured = { status: number; body: unknown }

/**
 * Minimal pg double for the PATCH happy path. Records every SQL it is asked to
 * run so a test can assert that the parse-rejection path never touched the DB.
 * The PATCH update path issues: begin / set_config / select … for update /
 * update … returning / audit insert / commit.
 */
class FakePool {
  queries: string[] = []
  milestone = {
    id: MILESTONE_ID,
    company_id: COMPANY_ID,
    project_id: PROJECT_ID,
    label: 'Deposit',
    pct: '30',
    amount: '1000',
    sort_order: 0,
    status: 'not_yet',
    estimate_push_id: null,
    invoiced_at: null,
    paid_at: null,
    tier_origin: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    } as unknown as PoolClient
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  private dispatch(sqlRaw: string, _params: unknown[]) {
    const sql = sqlRaw.trim()
    this.queries.push(sql)
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }
    // select … for update (the locked read)
    if (/from project_billing_milestones/i.test(sql) && /for update/i.test(sql)) {
      return { rows: [{ ...this.milestone }], rowCount: 1 }
    }
    // update … returning (apply the status transition)
    if (/^update project_billing_milestones/i.test(sql)) {
      const next = { ...this.milestone, status: 'paid' }
      return { rows: [next], rowCount: 1 }
    }
    // audit insert
    if (/^insert into audit_events/i.test(sql)) {
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in FakePool: ${sql}`)
  }
}

function makeCtx(pool: FakePool, body: Record<string, unknown>, captured: Captured[]): ProjectBillingMilestoneRouteCtx {
  return {
    pool: pool as unknown as Pool,
    company: { id: COMPANY_ID } as ProjectBillingMilestoneRouteCtx['company'],
    currentUserId: 'user-1',
    requireRole: () => true,
    readBody: async () => body,
    sendJson: (status, b) => {
      captured.push({ status, body: b })
    },
  }
}

function patchReq(): http.IncomingMessage {
  return { method: 'PATCH' } as http.IncomingMessage
}

describe('project-billing-milestones — status is the closed 3-value domain', () => {
  it('rejects an out-of-domain status at parse time with 400 and never writes', async () => {
    const pool = new FakePool()
    pool.attach()
    const captured: Captured[] = []
    const ctx = makeCtx(pool, { status: 'paid_in_full' }, captured)
    const url = new URL(`http://x/api/billing-milestones/${MILESTONE_ID}`)

    const handled = await handleProjectBillingMilestoneRoutes(patchReq(), url, ctx)

    expect(handled).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.status).toBe(400)
    // Parse rejection must short-circuit before any DB statement runs.
    expect(pool.queries).toHaveLength(0)
  })

  it('accepts a valid status (paid) and applies the transition', async () => {
    const pool = new FakePool()
    pool.attach()
    const captured: Captured[] = []
    const ctx = makeCtx(pool, { status: 'paid' }, captured)
    const url = new URL(`http://x/api/billing-milestones/${MILESTONE_ID}`)

    const handled = await handleProjectBillingMilestoneRoutes(patchReq(), url, ctx)

    expect(handled).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.status).toBe(200)
    const body = captured[0]!.body as { billing_milestone: { status: string } }
    expect(body.billing_milestone.status).toBe('paid')
    // The happy path did reach the DB.
    expect(pool.queries.some((q) => /^update project_billing_milestones/i.test(q))).toBe(true)
  })
})
