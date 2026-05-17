import { PIPELINE_VERSION as BLUEPRINT_PIPELINE_VERSION, buildBlueprintTakeoff } from '@sitelayer/pipe-blueprint'
import { applyReviewFloor, type TakeoffResult } from '@sitelayer/capture-schema'
import { compact } from './shared.js'

/**
 * Optional inputs the dispatcher hands to the `blueprint_vision` pipeline
 * after the request handler has already streamed the PDF to object
 * storage. Other pipelines ignore these.
 */
export interface BlueprintLiveInputs {
  pdfBytes: Buffer
  /** Spaces / local-fs storage key the bytes were just persisted under.
   *  Used as the artifact's `sourcePdfPath` for provenance. */
  storagePath: string
}

/**
 * Resolve the blueprint_vision capture mode from env.
 *   - "live" + ANTHROPIC_API_KEY set ⇒ call Claude vision.
 *   - any other combination ⇒ dry-run stub.
 *
 * Read at request time (not module-init) so tests can flip the env per
 * case without re-importing the module. The dispatcher cost-cap rule
 * (control-plane/CLAUDE.md #3) still applies: prefer dry-run unless the
 * caller explicitly asked for live and the key is present.
 */
export function resolveBlueprintVisionMode(): 'live' | 'dry-run' {
  const mode = (process.env.BLUEPRINT_VISION_MODE ?? 'dry-run').trim().toLowerCase()
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim())
  if (mode === 'live' && hasKey) return 'live'
  return 'dry-run'
}

export async function captureBlueprintVisionDraft(
  payload: Record<string, unknown>,
  projectId: string,
  blueprintLive?: BlueprintLiveInputs,
): Promise<{ result: TakeoffResult; pipelineVersion: string }> {
  // Three sub-paths:
  //   a) caller passed dryRun explicitly ⇒ always dry-run stub.
  //   b) live multipart upload streamed PDF bytes in (blueprintLive set)
  //      AND env is configured for live ⇒ real Anthropic call.
  //   c) anything else ⇒ dry-run stub (safe default; matches the
  //      cost-cap rule until the operator opts in).
  const explicitDryRun = payload.dryRun === true
  const envMode = resolveBlueprintVisionMode()
  const useLive = !explicitDryRun && envMode === 'live' && blueprintLive != null

  if (useLive) {
    const result = await buildBlueprintTakeoff(
      compact({
        pdfPath: blueprintLive!.storagePath,
        pdfBytes: blueprintLive!.pdfBytes,
        projectId,
        knownDimensionFt: typeof payload.knownDimensionFt === 'number' ? payload.knownDimensionFt : undefined,
        wallHeightFt: typeof payload.wallHeightFt === 'number' ? payload.wallHeightFt : undefined,
        model: typeof payload.model === 'string' ? payload.model : undefined,
      }),
    )
    return { result: applyReviewFloor(result), pipelineVersion: BLUEPRINT_PIPELINE_VERSION }
  }

  // Dry-run path. Tolerates a missing pdfPath since we never touch disk.
  const pdfPath = typeof payload.pdfPath === 'string' ? payload.pdfPath : ''
  const result = await buildBlueprintTakeoff(
    compact({
      pdfPath: pdfPath || '/dev/null',
      projectId,
      dryRun: true,
      knownDimensionFt: typeof payload.knownDimensionFt === 'number' ? payload.knownDimensionFt : undefined,
      wallHeightFt: typeof payload.wallHeightFt === 'number' ? payload.wallHeightFt : undefined,
      model: typeof payload.model === 'string' ? payload.model : undefined,
    }),
  )
  return { result: applyReviewFloor(result), pipelineVersion: BLUEPRINT_PIPELINE_VERSION }
}
