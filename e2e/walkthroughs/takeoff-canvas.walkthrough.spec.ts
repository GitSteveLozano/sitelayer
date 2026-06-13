import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth'

/**
 * A walkthrough of the REAL takeoff canvas (`/desktop/canvas/:id`) + the
 * on-canvas AI review, recorded against the SEEDED `takeoff-canvas-states`
 * tenant — NOT the public client-side 3D demo.
 *
 * Where `takeoff-demo.walkthrough.spec.ts` records the public, backend-free
 * `/demo/takeoff-preview-3d` fixtures, this records the actual command-center
 * takeoff editor (`screens/desktop/est-canvas`) loading real seeded DB rows so
 * an operator can SEE the live canvas + AI-review surface on data, not a demo.
 *
 * Auth: the `adminPage` fixture from `e2e/fixtures/auth.ts` builds an
 * `e2e-admin` page via `buildRolePage` (imported, not edited). That fixture
 * pins the `e2e-fixtures` company; the `takeoff-canvas-states` scenario lives
 * under `takeoff-lab`, so we repoint the SAME two act-as channels the fixture
 * uses (default outbound headers + the `sitelayer.active-company-slug` init
 * script Playwright re-runs on every navigation) at `takeoff-lab`.
 *
 * Determinism — the two composable layers the canvas testability is built on
 * (see docs/TAKEOFF_TESTING.md):
 *   1. DB DATA state — the `takeoff-lab` tenant from
 *      `scenarios/takeoff-canvas-states.yaml`, seeded once via
 *      `npx tsx scripts/seed-scenario.ts scenarios/takeoff-canvas-states.yaml`
 *      against the target tier. Its `manual` project lands the canvas on a real
 *      blueprint underlay with a drawn manual polygon (area + cutout + lineal +
 *      count); its `ai` project carries a `review_required` blueprint_vision
 *      draft with mixed-confidence quantities.
 *   2. UI POSTURE — the dev-only `?seed=ai-reviewing` affordance
 *      (`apps/web/src/machines/takeoff-session-seeds.ts`) boots the
 *      takeoff-session machine straight into `capturing.reviewing`, so the
 *      editable AI-review overlay (HIGH/MED/LOW proposals + Accept/Reject/
 *      Promote) renders with no click-pathing. The seed is hard-gated OFF in
 *      production (`import.meta.env.MODE === 'production'`).
 *
 * Same seed + same event sequence ⇒ same states ⇒ same video ⇒ a stable
 * gemini-video verdict.
 *
 * PREREQUISITE: the `takeoff-canvas-states` scenario must be seeded into the
 * tier this runs against (dev by default). If it isn't, the canvas loads with
 * no blueprint (grid only) — the AI-review step still records because that
 * posture comes from the machine seed, but the manual-canvas step won't show
 * the real sheet. Seed once with the command above before recording.
 */

const TAKEOFF_LAB_SLUG = process.env.E2E_TAKEOFF_LAB_SLUG ?? 'takeoff-lab'
// Deterministic ids for the `takeoff-canvas-states.yaml` tenant — each is
// `refUuid('project', '<ref>')` (sha256 of `sitelayer:scenario:project:<ref>`,
// see packages/scenario/src/ids.ts), so the seeded rows key on the SAME ids
// every run. Overridable via env in case a tier re-namespaces the scenario.
const MANUAL_PROJECT_ID = process.env.E2E_TAKEOFF_MANUAL_PROJECT_ID ?? '230b03a8-2d31-4ea2-8ef3-f6edbfb1d056'
const AI_PROJECT_ID = process.env.E2E_TAKEOFF_AI_PROJECT_ID ?? '377a91c7-1506-42d0-b5af-0562e3f84caf'

export const WALKTHROUGH_STEPS = [
  {
    n: 1,
    action: "Open the seeded 'manual' project's real takeoff canvas (/desktop/canvas/:id) as admin",
    expect:
      "the command-center takeoff editor: a 'Takeoff · Manual takeoff v1' top strip with a Total qty, the TOOL palette (POLY / RECT / SCALE / SEL), and a drawn measurement over the seeded blueprint",
  },
  {
    n: 2,
    action: "Open the seeded 'ai' project's canvas booted into AI review (?seed=ai-reviewing)",
    expect:
      "the on-canvas 'AI Review' overlay listing proposals (HIGH EPS, MED Basecoat) with Accept / Reject buttons and a disabled 'Promote accepted (0)' footer",
  },
  {
    n: 3,
    action: 'Accept the HIGH-confidence EPS proposal and Reject the MED Basecoat proposal',
    expect:
      "the EPS row shows ACCEPTED, the Basecoat row shows REJECTED, and the footer enables 'Promote accepted (1)'",
  },
  {
    n: 4,
    action: 'Reveal the low-confidence tier, then Promote the accepted proposal onto the plan',
    expect:
      'the hidden LOW proposal appears after the disclosure toggle, and Promote commits the accepted set (the overlay clears back to the canvas)',
  },
] as const

/**
 * Repoint an already-built role page at the seeded `takeoff-lab` tenant. The
 * `adminPage` fixture pinned `e2e-fixtures` on both channels; override the same
 * two so the canvas resolves `takeoff-lab` rows. The init script runs AFTER the
 * fixture's on the next navigation, so its `active-company-slug` wins.
 */
async function pointAtTakeoffLab(page: Page): Promise<void> {
  await page.context().setExtraHTTPHeaders({
    'x-sitelayer-act-as': 'e2e-admin',
    'x-sitelayer-company-slug': TAKEOFF_LAB_SLUG,
    'x-sitelayer-user-id': 'e2e-admin',
  })
  await page.context().addInitScript((slug) => {
    try {
      window.localStorage.setItem('sitelayer.act-as', 'e2e-admin')
      window.localStorage.setItem('sitelayer.active-company-slug', slug)
    } catch {
      // storage-disabled browsers: nothing to recover; the canvas just won't
      // resolve the tenant — surfaced by the spec's visibility assertions.
    }
  }, TAKEOFF_LAB_SLUG)
}

test(
  'takeoff canvas (seeded) — real canvas + AI review walkthrough',
  { tag: '@walkthrough' },
  async ({ adminPage }, testInfo) => {
    await pointAtTakeoffLab(adminPage)

    // Step 1 — the REAL command-center takeoff canvas on seeded data.
    await adminPage.goto(`/desktop/canvas/${MANUAL_PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
    // The TOOL palette + top strip only render once the canvas body is past its
    // loading gate (drafts/blueprints fetched) — wait on a stable chrome label.
    await expect(adminPage.getByText('Total qty')).toBeVisible({ timeout: 30_000 })
    await expect(adminPage.getByText('Takeoff ·')).toBeVisible()
    await expect(adminPage.getByRole('button', { name: 'POLY' })).toBeVisible()
    await expect(adminPage.getByRole('button', { name: 'SEL' })).toBeVisible()
    await adminPage.waitForTimeout(3000)

    // Step 2 — the SAME real canvas, AI-review posture via the machine seed.
    await adminPage.goto(`/desktop/canvas/${AI_PROJECT_ID}?seed=ai-reviewing`, { waitUntil: 'domcontentloaded' })
    const overlay = adminPage.getByTestId('ai-review-overlay')
    await expect(overlay).toBeVisible({ timeout: 30_000 })
    // The two non-low proposals (EPS @0.93 HIGH, Basecoat @0.71 MED) render up
    // front; the LOW Finish-Coat row (q3 @0.42) is behind the disclosure.
    await expect(adminPage.getByTestId('ai-review-accept-q1')).toBeVisible()
    await expect(adminPage.getByTestId('ai-review-accept-q2')).toBeVisible()
    await expect(adminPage.getByTestId('ai-review-promote')).toContainText('Promote accepted (0)')
    await adminPage.waitForTimeout(2500)

    // Step 3 — Accept the HIGH proposal, Reject the MED one (in place).
    await adminPage.getByTestId('ai-review-accept-q1').click()
    await expect(adminPage.getByTestId('ai-review-row-q1')).toContainText('ACCEPTED')
    await adminPage.getByTestId('ai-review-reject-q2').click()
    await expect(adminPage.getByTestId('ai-review-row-q2')).toContainText('REJECTED')
    await expect(adminPage.getByTestId('ai-review-promote')).toContainText('Promote accepted (1)')
    await adminPage.waitForTimeout(2500)

    // Step 4 — reveal the low-confidence tier, then promote the accepted set.
    await adminPage.getByTestId('ai-review-toggle-low').click()
    await expect(adminPage.getByTestId('ai-review-accept-q3')).toBeVisible()
    await adminPage.waitForTimeout(1500)
    await adminPage.getByTestId('ai-review-promote').click()
    // PROMOTE runs the wired promote actor; the machine leaves `reviewing`, so
    // the overlay unmounts back to the plain canvas — the visible end state.
    await expect(overlay).toBeHidden({ timeout: 15_000 })
    await adminPage.waitForTimeout(3000)

    // Emit the expected-step narrative next to the recorded video so
    // gemini-video knows what the walkthrough should show. The video isn't
    // flushed until teardown, so the per-test dir may not exist yet.
    mkdirSync(testInfo.outputDir, { recursive: true })
    writeFileSync(
      path.join(testInfo.outputDir, 'walkthrough-steps.json'),
      JSON.stringify({ title: 'seeded takeoff canvas + AI review walkthrough', steps: WALKTHROUGH_STEPS }, null, 2),
    )
  },
)
