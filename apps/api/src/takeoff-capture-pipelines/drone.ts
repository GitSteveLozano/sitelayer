import {
  PIPELINE_VERSION as DRONE_PIPELINE_VERSION,
  takeoffFromSidecar,
  DroneSidecarSchema,
} from '@sitelayer/pipe-drone'
import { applyReviewFloor, type TakeoffResult } from '@sitelayer/capture-schema'
import { compact } from './shared.js'

export async function captureDroneDraft(
  payload: Record<string, unknown>,
  projectId: string,
): Promise<{ result: TakeoffResult; pipelineVersion: string }> {
  const sidecar = DroneSidecarSchema.parse(payload.sidecar)
  const result = takeoffFromSidecar(
    sidecar,
    compact({
      projectId,
      sidecarPath: typeof payload.sidecarPath === 'string' ? payload.sidecarPath : 'inline',
    }),
  )
  return { result: applyReviewFloor(result), pipelineVersion: DRONE_PIPELINE_VERSION }
}
