import { test, expect, runJourney } from '../fixtures/auth'

/**
 * Spec — pilot-loop journey (WF-2, HTTP-tier terminal-snapshot proof).
 *
 * Rides ONE role (admin) through the pilot's three deterministic
 * financial workflows back-to-back, asserting the TERMINAL snapshot of
 * each leg over real HTTP:
 *
 *   project_lifecycle : draft → estimating → sent → accepted → in_progress → done → archived
 *   estimate_push     : drafted → reviewed → approved → posting
 *   rental_billing    : generated → approved → posting
 *
 * This is the e2e/HTTP twin of the reducer-tier proof in
 * `packages/workflows/src/replay.ts:applyEventLog` (and its golden
 * `project-lifecycle.golden.test.ts`): `runJourney` asserts each
 * transition lands the expected snapshot AND `state_version` bumps by
 * exactly 1 (no gaps), step-by-step, then the terminal — exactly the
 * contract `applyEventLog` checks one tier down against a persisted
 * `workflow_event_log`. The cross-workflow loop's terminal proof
 * previously existed ONLY at the reducer/DB tier; this lifts it to the
 * live API.
 *
 * ISOLATION (why not reuse the shared pilot-journey fixture). The
 * existing `pilot-journey.spec.ts` rides the SHARED estimate-push row
 * (...208) that `admin-estimate-push.spec.ts` also drives and the e2e
 * worker auto-advances — so its click-through leg is conditional/flaky.
 * This journey instead reads DEDICATED, env-overridable ids so the
 * parallel seed lane can pin SEPARATE rows (each one this spec, and only
 * this spec, walks to its terminal). The defaults below resolve to the
 * standing per-workflow fixture rows so the spec is runnable today;
 * override the `E2E_PILOT_LOOP_*` vars to point at isolated rows once the
 * seed lane provisions them. (Mirrors the `envOr` pattern in
 * `e2e/fixtures/ids.ts`.)
 *
 * NOTE on the human-reachable terminals: estimate_push and rental_billing
 * stop at `posting` — `POST_SUCCEEDED` → `posted` is worker-only and
 * intentionally rejected at the human event endpoint (see the sibling
 * admin-estimate-push / office-rental-billing specs). The synchronous
 * POST_REQUESTED response is `posting`; this journey asserts that
 * deterministic human terminal, not the worker-driven `posted`.
 */

function envOr(key: string, fallback: string): string {
  return (process.env[key] ?? fallback).trim()
}

// Dedicated, isolated ids for THIS journey. Defaults point at the standing
// per-workflow fixture rows; the seed lane overrides them to pin separate
// rows so the lifecycle walk-to-archived here never collides with the
// admin-project-lifecycle spec walking the same project.
const PILOT_LOOP_IDS = {
  lifecycleProjectId: envOr('E2E_PILOT_LOOP_PROJECT_ID', '00000000-0000-4000-8000-000000000201'),
  estimatePushId: envOr('E2E_PILOT_LOOP_ESTIMATE_PUSH_ID', '00000000-0000-4000-8000-000000000208'),
  billingRunId: envOr('E2E_PILOT_LOOP_BILLING_RUN_ID', '00000000-0000-4000-8000-000000000207'),
} as const

// Gate consistently with the sibling workflow specs (admin-*, office-*,
// pilot-journey): skip-by-default until the seed + act-as PRs land; CI
// sets E2E_RUN=1 once they're merged.
const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec(
  'pilot loop: admin rides lifecycle → estimate push → rental billing to each terminal',
  { tag: '@journey' },
  async ({ adminPage }) => {
    // --- Leg 1: project_lifecycle → archived (all human transitions) --------
    const lifecyclePath = `/api/projects/${PILOT_LOOP_IDS.lifecycleProjectId}/lifecycle`
    const lifecycle = await runJourney(
      adminPage,
      { snapshotPath: lifecyclePath, eventsPath: `${lifecyclePath}/events` },
      [
        { event: 'START_ESTIMATING', expectedState: 'estimating' },
        { event: 'SEND', expectedState: 'sent' },
        { event: 'ACCEPT', expectedState: 'accepted' },
        { event: 'START_WORK', expectedState: 'in_progress' },
        { event: 'COMPLETE', expectedState: 'done' },
        { event: 'ARCHIVE', expectedState: 'archived' },
      ],
    )
    expect(lifecycle.initial.state).toBe('draft')
    expect(lifecycle.terminal.state).toBe('archived')

    // --- Leg 2: estimate_push → posting (human terminal; posted is worker-only)
    const pushPath = `/api/estimate-pushes/${PILOT_LOOP_IDS.estimatePushId}`
    const push = await runJourney(adminPage, { snapshotPath: pushPath, eventsPath: `${pushPath}/events` }, [
      { event: 'REVIEW', expectedState: 'reviewed' },
      { event: 'APPROVE', expectedState: 'approved' },
      { event: 'POST_REQUESTED', expectedState: 'posting' },
    ])
    expect(push.initial.state).toBe('drafted')
    expect(push.terminal.state).toBe('posting')

    // --- Leg 3: rental_billing → posting (human terminal; posted is worker-only)
    const billingPath = `/api/rental-billing-runs/${PILOT_LOOP_IDS.billingRunId}`
    const billing = await runJourney(adminPage, { snapshotPath: billingPath, eventsPath: `${billingPath}/events` }, [
      { event: 'APPROVE', expectedState: 'approved' },
      { event: 'POST_REQUESTED', expectedState: 'posting' },
    ])
    expect(billing.initial.state).toBe('generated')
    expect(billing.terminal.state).toBe('posting')
  },
)
