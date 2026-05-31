import { applyEventSequence, type QueryExecutor } from '@sitelayer/workflows'
import { planScenario, type ApplyOp, type PlanContext, type ScenarioPlan, type SeedSummary } from './plan.js'
import type { ScenarioDoc } from './schema.js'

/**
 * Apply-time dependencies the pure plan can't carry.
 *
 * `seedCompanyDefaults` is the canonical onboarding seed (divisions / service
 * items / pricing / bonus / yard) that lives in `apps/api/src/onboarding.ts`.
 * It is INJECTED rather than imported so this package never depends on `apps/*`
 * (which would invert the package→app dependency graph and break the build).
 * The CLI and tests pass the real implementation.
 *
 * The client type `C` is threaded through so the injected `seedCompanyDefaults`
 * can keep its concrete `PoolClient` signature while the engine itself only
 * relies on the structural `QueryExecutor` (`{ query(text, values?) }`).
 */
export interface ApplyContext<C extends QueryExecutor = QueryExecutor> {
  seedCompanyDefaults: (client: C, companyId: string) => Promise<void>
  /** Single clock instant for relative-time resolution. Defaults to `new Date()`. */
  now?: Date
}

interface CompanyRow {
  id: string
}

/**
 * Upsert the company row and return its (DB-generated) id. This is the one
 * step that must run before planning, because `companies.id` is not derivable
 * from the scenario (it defaults to `gen_random_uuid()` and re-seeds keep the
 * pre-existing id via `on conflict (slug) do nothing`).
 */
export async function ensureCompanyRow(client: QueryExecutor, doc: ScenarioDoc): Promise<string> {
  await client.query(`insert into companies (slug, name) values ($1, $2) on conflict (slug) do nothing`, [
    doc.company.slug,
    doc.company.name,
  ])
  const result = (await client.query(`select id from companies where slug = $1 limit 1`, [doc.company.slug])) as {
    rows?: CompanyRow[]
  }
  const id = result.rows?.[0]?.id
  if (!id) throw new Error(`failed to upsert company ${doc.company.slug}`)
  return id
}

async function runOp<C extends QueryExecutor>(client: C, op: ApplyOp, ctx: ApplyContext<C>): Promise<void> {
  switch (op.kind) {
    case 'query':
      await client.query(op.text, op.values)
      return
    case 'event_log':
      await applyEventSequence(client, op.args)
      return
    case 'company_defaults':
      await ctx.seedCompanyDefaults(client, op.companyId)
      return
  }
}

/**
 * Execute a pre-built plan's ops in order against `client`. The caller owns the
 * surrounding transaction (mirrors `applyEventSequence`). This is the brief's
 * `applyScenario(client, plan)`.
 */
export async function applyPlan<C extends QueryExecutor>(
  client: C,
  plan: ScenarioPlan,
  ctx: ApplyContext<C>,
): Promise<void> {
  for (const op of plan.ops) {
    await runOp(client, op, ctx)
  }
}

/**
 * One-shot: upsert the company, plan the rest, apply it, and return the summary.
 * The caller owns the surrounding transaction (BEGIN/COMMIT) — see the CLI in
 * `scripts/seed-scenario.ts`.
 */
export async function applyScenario<C extends QueryExecutor>(
  client: C,
  doc: ScenarioDoc,
  ctx: ApplyContext<C>,
): Promise<SeedSummary> {
  const companyId = await ensureCompanyRow(client, doc)
  const planCtx: PlanContext = ctx.now !== undefined ? { companyId, now: ctx.now } : { companyId }
  const plan = planScenario(doc, planCtx)
  await applyPlan(client, plan, ctx)
  return plan.summary
}
