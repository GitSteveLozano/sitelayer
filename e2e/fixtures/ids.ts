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

// Aligned with `apps/api/scripts/seed-e2e-fixtures.ts` `IDS` block: 200s
// are workflow rows. A single project anchors both the lifecycle and
// closeout-summary specs (the seed only creates one). Override via env
// var if a workflow needs a separate row for an isolation test.
export const FIXTURE_IDS = {
  // Project in `draft` state — admin walks it through the full lifecycle.
  lifecycleProjectId: envOr('E2E_LIFECYCLE_PROJECT_ID', '00000000-0000-4000-8000-000000000201'),

  // Estimate push in `drafted` state — admin advances through reviewed → approved → posted.
  estimatePushId: envOr('E2E_ESTIMATE_PUSH_ID', '00000000-0000-4000-8000-000000000208'),

  // Worker-issue ("blocker") in `open` state, ready for foreman to RESOLVE.
  fieldEventIssueId: envOr('E2E_FIELD_EVENT_ISSUE_ID', '00000000-0000-4000-8000-000000000209'),

  // Time-review run in `pending` state — admin approves to lock labor.
  timeReviewRunId: envOr('E2E_TIME_REVIEW_RUN_ID', '00000000-0000-4000-8000-000000000204'),

  // Labor-payroll run in `generated` state — admin approves and posts.
  laborPayrollRunId: envOr('E2E_LABOR_PAYROLL_RUN_ID', '00000000-0000-4000-8000-000000000205'),

  // Rental-billing run in `generated` state — office user approves + posts.
  billingRunId: envOr('E2E_BILLING_RUN_ID', '00000000-0000-4000-8000-000000000207'),

  // Closeout-summary spec reads the same lifecycle project; numbers render
  // off of the seed's labor entries + zero materials/rentals (still asserts
  // bid + variance card).
  closeoutProjectId: envOr('E2E_CLOSEOUT_PROJECT_ID', '00000000-0000-4000-8000-000000000201'),
} as const
