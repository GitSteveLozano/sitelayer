import type { QueryExecutor } from '@sitelayer/workflows'
import { applyPlan, ensureCompanyRow, type ApplyContext } from './apply.js'
import { planScenario, type SeedSummary } from './plan.js'
import type { ScenarioDoc } from './schema.js'

/**
 * Fragment chaining (design §11c).
 *
 * A scenario can be composed from named, reusable *fragments* that all share
 * one company. Because reducers are pure and ids are ref-hashed, the resolved
 * end-state of fragment N is deterministic, so fragment N+1 can be a function of
 * the ids fragment N produced.
 *
 * Each fragment is a company-less partial scenario; `runFragments` injects the
 * shared `{ company }` and applies each in order against the caller's client.
 * Cross-fragment fixtures should be self-contained (re-declare by `ref` — the
 * inserts are idempotent), and the function form receives the accumulated,
 * already-applied refs so a later fragment can embed a real id when it needs to.
 *
 *   const out = await runFragments(
 *     [
 *       companyAtEstimating,                              // partial doc
 *       (ctx) => rentalMidDispute(ctx.refs.projects),     // function of prior refs
 *     ],
 *     { slug: 'test-co', client, seedCompanyDefaults },
 *   )
 *
 * The caller owns the surrounding transaction (BEGIN / COMMIT or ROLLBACK).
 */

/** A scenario doc minus its `company` block (the shared company is injected). */
export type PartialScenario = Omit<ScenarioDoc, 'company'>

export type ScenarioFragment = PartialScenario | ((ctx: FragmentContext) => PartialScenario)

export interface AggregatedRefs {
  customers: Map<string, string>
  workers: Map<string, string>
  inventory: Map<string, string>
  projects: Map<string, string>
  estimates: Map<string, string>
  workerIssues: Map<string, string>
  damageCharges: Map<string, string>
  rentalRequests: Map<string, string>
  qboSyncRuns: Map<string, string>
  boms: Map<string, string>
  changeOrders: Map<string, string>
  crewSchedules: Map<string, string>
  takeoffDrafts: Map<string, string>
  captureSessions: Map<string, string>
  rentals: Map<string, { contract_id: string; billing_run_id: string }>
}

export interface FragmentContext {
  companyId: string
  slug: string
  now: Date
  /** Summaries of every fragment applied so far, in order. */
  summaries: SeedSummary[]
  /** ref → id maps aggregated across all applied fragments. */
  refs: AggregatedRefs
}

export interface RunFragmentsOptions<C extends QueryExecutor = QueryExecutor> extends ApplyContext<C> {
  slug: string
  name?: string
  client: C
}

export interface RunFragmentsResult {
  companyId: string
  summaries: SeedSummary[]
  refs: AggregatedRefs
}

function newAggregatedRefs(): AggregatedRefs {
  return {
    customers: new Map(),
    workers: new Map(),
    inventory: new Map(),
    projects: new Map(),
    estimates: new Map(),
    workerIssues: new Map(),
    damageCharges: new Map(),
    rentalRequests: new Map(),
    qboSyncRuns: new Map(),
    boms: new Map(),
    changeOrders: new Map(),
    crewSchedules: new Map(),
    takeoffDrafts: new Map(),
    captureSessions: new Map(),
    rentals: new Map(),
  }
}

function mergeSummary(refs: AggregatedRefs, summary: SeedSummary): void {
  const merge = (map: Map<string, string>, entries: Array<{ ref: string; id: string }>) => {
    for (const e of entries) map.set(e.ref, e.id)
  }
  merge(refs.customers, summary.customers)
  merge(refs.workers, summary.workers)
  merge(refs.inventory, summary.inventory)
  merge(refs.projects, summary.projects)
  merge(refs.estimates, summary.estimates)
  merge(refs.workerIssues, summary.worker_issues)
  merge(refs.damageCharges, summary.damage_charges)
  merge(refs.rentalRequests, summary.rental_requests)
  merge(refs.qboSyncRuns, summary.qbo_sync_runs)
  merge(refs.boms, summary.boms)
  merge(refs.changeOrders, summary.change_orders)
  merge(refs.crewSchedules, summary.crew_schedules)
  merge(refs.takeoffDrafts, summary.takeoff_drafts)
  merge(refs.captureSessions, summary.capture_sessions)
  for (const r of summary.rentals) {
    refs.rentals.set(r.ref, { contract_id: r.contract_id, billing_run_id: r.billing_run_id })
  }
}

export async function runFragments<C extends QueryExecutor>(
  fragments: ScenarioFragment[],
  options: RunFragmentsOptions<C>,
): Promise<RunFragmentsResult> {
  const { slug, name, client, seedCompanyDefaults } = options
  const now = options.now ?? new Date()
  const company = { slug, name: name ?? slug }

  const companyId = await ensureCompanyRow(client, { company } as ScenarioDoc)

  const summaries: SeedSummary[] = []
  const refs = newAggregatedRefs()
  const applyCtx: ApplyContext<C> = { seedCompanyDefaults, now }

  for (const fragment of fragments) {
    const ctx: FragmentContext = { companyId, slug, now, summaries, refs }
    const partial = typeof fragment === 'function' ? fragment(ctx) : fragment
    const doc: ScenarioDoc = { company, ...partial }
    const plan = planScenario(doc, { companyId, now })
    await applyPlan(client, plan, applyCtx)
    summaries.push(plan.summary)
    mergeSummary(refs, plan.summary)
  }

  return { companyId, summaries, refs }
}
