import {
  PIPELINE_VERSION as PHOTOGRAMMETRY_PIPELINE_VERSION,
  buildTakeoffFromLabeledMesh,
  parseLabeledMesh,
} from '@sitelayer/pipe-photogrammetry'
import { applyReviewFloor, type TakeoffResult } from '@sitelayer/capture-schema'
import { compact } from './shared.js'

export async function capturePhotogrammetryDraft(
  payload: Record<string, unknown>,
  projectId: string,
): Promise<{ result: TakeoffResult; pipelineVersion: string }> {
  const labeledMesh = parseLabeledMesh(payload.labeledMesh)
  const result = buildTakeoffFromLabeledMesh(
    compact({
      labeledMesh,
      projectId,
      meshId: typeof payload.meshId === 'string' ? payload.meshId : undefined,
      vendorJobId: typeof payload.vendorJobId === 'string' ? payload.vendorJobId : undefined,
    }),
  )
  return { result: applyReviewFloor(result), pipelineVersion: PHOTOGRAMMETRY_PIPELINE_VERSION }
}
