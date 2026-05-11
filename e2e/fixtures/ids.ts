/**
 * Stable fixture entity ids seeded by
 * `apps/api/scripts/seed-e2e-fixtures.ts` (parallel PR). One ready-state
 * row per workflow lives under the `e2e-fixtures` company so each spec
 * has a known starting point.
 *
 * Tests reference these via env-var override so the parallel seed PR can
 * pin different UUIDs without editing each spec. The defaults are the
 * placeholders the seed script is expected to emit — once the PR lands
 * the constants here line up with the migration's `INSERT` statements.
 */

function envOr(key: string, fallback: string): string {
  return (process.env[key] ?? fallback).trim()
}

export const FIXTURE_IDS = {
  // Project in `draft` state — admin walks it through the full lifecycle.
  lifecycleProjectId: envOr('E2E_LIFECYCLE_PROJECT_ID', '00000000-0000-4000-8000-000000000001'),

  // Estimate push in `drafted` state — admin advances through reviewed → approved → posted.
  estimatePushId: envOr('E2E_ESTIMATE_PUSH_ID', '00000000-0000-4000-8000-000000000002'),

  // Worker-issue ("blocker") created by e2e-member, ready for foreman to RESOLVE.
  fieldEventIssueId: envOr('E2E_FIELD_EVENT_ISSUE_ID', '00000000-0000-4000-8000-000000000003'),

  // Time-review run in `pending` state — admin approves to lock labor.
  timeReviewRunId: envOr('E2E_TIME_REVIEW_RUN_ID', '00000000-0000-4000-8000-000000000004'),

  // Labor-payroll run in `generated` (or seed-equivalent) state — admin
  // approves and posts. The seed creates it pre-locked from the time
  // review above so the chain can run in one pass.
  laborPayrollRunId: envOr('E2E_LABOR_PAYROLL_RUN_ID', '00000000-0000-4000-8000-000000000005'),

  // Rental-billing run in `generated` state — office user approves + posts.
  billingRunId: envOr('E2E_BILLING_RUN_ID', '00000000-0000-4000-8000-000000000006'),

  // Project with finalized labor + bills so the closeout-summary card has
  // bid/actual/margin numbers to render. Distinct from the lifecycle
  // project so the lifecycle spec doesn't pollute its rollup.
  closeoutProjectId: envOr('E2E_CLOSEOUT_PROJECT_ID', '00000000-0000-4000-8000-000000000007'),
} as const
