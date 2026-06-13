/**
 * runDryRunCapture — the deterministic blueprint-vision DRY-RUN as a reusable,
 * server-free function (Track B / SIM-2).
 *
 * This is the SAME deterministic `TakeoffResult` the synchronous capture
 * endpoint persists when no live provider is configured
 * (`POST /api/projects/:id/takeoff-drafts/capture` with provenance
 * `stub-dry-run`). The endpoint's synchronous half
 * (`apps/api/src/takeoff-capture-pipelines/blueprint-vision.ts`) builds it by
 * relabelling the package's generic dry-run skeleton onto a believable
 * EIFS/stucco row set; this module lifts that exact construction out of the API
 * so it can be called IN-PROCESS — no HTTP server, no DB, no provider key — by
 * `scripts/simulate-takeoff.ts` and any seed-time scenario step that wants the
 * stub's real output instead of a hand-authored `result_json` fixture.
 *
 * Determinism: `buildDryRunSkeleton` is the fixture-driven mock (no model call,
 * no network), and the relabel + review-floor are pure, so a fixed `projectId`
 * always yields the same quantities/values/units/provenance. (The skeleton does
 * stamp a random `takeoffId` + `producedAt`; pass `stableIds: true` to pin them
 * for byte-stable snapshots.)
 */

import { PIPELINE_VERSION } from './extract.js'
import { buildDryRunSkeleton, relabelQuantities } from './live-capture.js'
import { applyReviewFloor, type TakeoffResult } from '@sitelayer/capture-schema'

/** Provenance discriminator the synchronous dry-run path stamps. Mirrors
 *  `CaptureProvenance` in apps/api/src/routes/takeoff-drafts.ts. */
export type DryRunProvenance = 'stub-dry-run'

/** One believable demo takeoff row. Same shape the API's `DEMO_ROWS` use. */
export interface DryRunDemoRow {
  description: string
  value: number
  unit: 'sqft' | 'lft' | 'ea'
  confidence: number
}

/**
 * Believable EIFS/stucco rows for the DETERMINISTIC DRY-RUN. Kept byte-identical
 * to `DEMO_ROWS` in apps/api/src/takeoff-capture-pipelines/blueprint-vision.ts so
 * the in-process simulation produces the SAME quantities the live capture
 * endpoint would persist for a stub run. NEVER a fallback for a failed live
 * provider call — `runLiveBlueprintCapture` throws instead.
 */
export const DRY_RUN_DEMO_ROWS: ReadonlyArray<DryRunDemoRow> = [
  { description: 'Exterior wall — EPS board insulation, 2"', value: 4820, unit: 'sqft', confidence: 0.94 },
  { description: 'Basecoat + reinforcing mesh over EPS', value: 4820, unit: 'sqft', confidence: 0.9 },
  { description: 'Sealant — control & perimeter joints', value: 540, unit: 'lft', confidence: 0.63 },
  { description: 'Window / door openings — verify & deduct', value: 18, unit: 'ea', confidence: 0.57 },
]

export interface RunDryRunCaptureOptions {
  /** Override the demo rows relabelled onto the skeleton. Defaults to the
   *  EIFS/stucco `DRY_RUN_DEMO_ROWS` (what the API stub persists). */
  rows?: ReadonlyArray<DryRunDemoRow>
  /** Pin the skeleton's otherwise-random `takeoffId`/`producedAt` so the whole
   *  result is byte-stable across runs (useful for golden snapshots / a
   *  scenario that persists the output as a deterministic fixture). */
  stableIds?: boolean
}

export interface DryRunCaptureOutcome {
  /** The deterministic, review-floored `TakeoffResult` (the draft's result_json). */
  result: TakeoffResult
  pipelineVersion: string
  provenance: DryRunProvenance
}

/**
 * Build the deterministic dry-run `TakeoffResult` for a project, in-process.
 * The result is shaped exactly like what `captureBlueprintVisionDraft` persists
 * for a stub run, so promote / recompute / scope-vs-bid behave identically to
 * the live capture path. Throws nothing under normal use (no network / no key).
 */
export async function runDryRunCapture(
  projectId: string,
  opts: RunDryRunCaptureOptions = {},
): Promise<DryRunCaptureOutcome> {
  const skeleton = await buildDryRunSkeleton(projectId)
  relabelQuantities(skeleton, opts.rows ?? DRY_RUN_DEMO_ROWS)
  if (opts.stableIds) {
    skeleton.takeoffId = `dryrun_${projectId}`
    skeleton.producedAt = '1970-01-01T00:00:00.000Z'
    skeleton.capturedAt = '1970-01-01T00:00:00.000Z'
  }
  return {
    result: applyReviewFloor(skeleton),
    pipelineVersion: PIPELINE_VERSION,
    provenance: 'stub-dry-run',
  }
}
