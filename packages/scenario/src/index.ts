/**
 * @sitelayer/scenario — the scenario engine.
 *
 * A scenario doc (YAML) is a declarative list of fixtures + workflow timelines.
 * `parseScenario` validates it, `planScenario` resolves it into a deterministic,
 * side-effect-free `ApplyOp[]`, and `applyScenario`/`applyPlan` run those ops —
 * replaying every `*_event_log` through the SAME `@sitelayer/workflows` reducers
 * production uses, so a seeded scenario is indistinguishable from real history.
 *
 * See docs/SCENARIO_HARNESS_AND_ADMIN_PLAN.md.
 */

export { COMPANY_SLUG_PATTERN, ScenarioDoc } from './schema.js'
export { refUuid } from './ids.js'
export {
  parseScenario,
  planScenario,
  type ApplyOp,
  type PlanContext,
  type ScenarioEvent,
  type ScenarioPlan,
  type SeedSummary,
} from './plan.js'
export { applyPlan, applyScenario, ensureCompanyRow, type ApplyContext, type DryRunCaptureFn } from './apply.js'
export {
  runFragments,
  type AggregatedRefs,
  type FragmentContext,
  type PartialScenario,
  type RunFragmentsOptions,
  type RunFragmentsResult,
  type ScenarioFragment,
} from './fragments.js'
