import { PIPELINE_VERSION as ROOMPLAN_PIPELINE_VERSION, parseCapturedRoom } from '@sitelayer/pipe-roomplan'
import { applyReviewFloor, type TakeoffResult } from '@sitelayer/capture-schema'
import { compact } from './shared.js'

export async function captureRoomplanDraft(
  payload: Record<string, unknown>,
  projectId: string,
): Promise<{ result: TakeoffResult; pipelineVersion: string }> {
  const capturedRoomJsonUri = String(payload.capturedRoomJsonUri ?? '').trim()
  if (!capturedRoomJsonUri) {
    throw new Error('roomplan payload requires capturedRoomJsonUri')
  }
  const result = parseCapturedRoom(
    compact({
      capturedRoomJson: payload.capturedRoomJson,
      projectId,
      capturedRoomJsonUri,
      deviceModel: typeof payload.deviceModel === 'string' ? payload.deviceModel : undefined,
      capturedAt: typeof payload.capturedAt === 'string' ? payload.capturedAt : undefined,
    }),
  )
  return { result: applyReviewFloor(result), pipelineVersion: ROOMPLAN_PIPELINE_VERSION }
}
