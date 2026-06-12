import type { QueryClient } from '@tanstack/react-query'
import {
  captureTakeoffDraft,
  DRAFT_RESULT_PROCESSING_POLL_MS,
  draftResultStatus,
  fetchTakeoffDraftResult,
  isLiveProvenance,
  promoteCapturedQuantities,
  type CaptureRequestBody,
  type CaptureResponse,
  type DraftResultResponse,
  type PromoteRequestBody,
  type PromoteResponse,
} from '@/lib/api/takeoff-drafts'
import { unwiredTakeoffSessionDeps, type TakeoffCaptureRunOutput, type TakeoffSessionDeps } from './takeoff-session'

/**
 * `takeoff-session-deps` — the REAL lib/api-backed capture/promote actors for
 * the takeoff-session machine (wave-3 est-canvas review convergence).
 *
 * This is the bridge that makes the machine the single orchestrator of the
 * capture → review → promote loop:
 *
 *   - `runCapture` speaks the REAL async capture contract (wave 2,
 *     2026-06-12): POST /capture creates a NEW draft; a live provider read
 *     answers 202 with `result_summary.status='processing'` and NO inline
 *     result, so we poll GET /takeoff-drafts/:id/result until the status
 *     leaves 'processing'. 'failed' REJECTS with the provider error (provider
 *     errors never produce stub rows). The resolved output carries the
 *     SERVER-side honesty mode (from `capture_provenance`) and the new draft
 *     id, which the machine assigns into `capture.mode` / `capture.draftId` —
 *     the overlay's LIVE/DEMO chip reflects what actually ran.
 *   - `promoteCaptured` POSTs the accepted quantity ids to the real promote
 *     endpoint against the capture-created draft.
 *
 * Both call the SAME plain functions the TanStack-Query hooks use
 * (`captureTakeoffDraft` / `fetchTakeoffDraftResult` /
 * `promoteCapturedQuantities` in lib/api/takeoff-drafts.ts), so the machine
 * path and the panel mutation path can never drift apart at the wire.
 *
 * The remaining actors (loadSession / commitMeasurement / calibratePage)
 * intentionally stay on `unwiredTakeoffSessionDeps`: the est-canvas bodies
 * persist those through their existing hybrid TanStack-Query mutations and
 * never dispatch the machine's COMMIT / APPLY_CALIBRATION invoke paths.
 */

/** Injectable wire seam so tests drive the deps without fetch/timers. */
export interface TakeoffCaptureApi {
  capture: (projectId: string, body: CaptureRequestBody) => Promise<CaptureResponse>
  fetchResult: (draftId: string) => Promise<DraftResultResponse>
  promote: (projectId: string, draftId: string, body: PromoteRequestBody) => Promise<PromoteResponse>
  sleep: (ms: number) => Promise<void>
}

const realApi: TakeoffCaptureApi = {
  capture: captureTakeoffDraft,
  fetchResult: fetchTakeoffDraftResult,
  promote: promoteCapturedQuantities,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface CreateTakeoffSessionApiDepsOptions {
  /** When provided, capture/promote invalidate the same query keys the
   *  mutation hooks do, so panels rendering off TanStack Query stay fresh. */
  queryClient?: QueryClient | null
  /** Wire seam override for tests. */
  api?: Partial<TakeoffCaptureApi>
  /** Poll cadence while a live capture is processing (worker-side). */
  pollIntervalMs?: number
  /** Hard ceiling on the poll loop. The draft keeps processing server-side
   *  past this — the drafts list / AgentSuggestionsPanel can still pick it up
   *  later — but the machine surfaces an error instead of spinning forever. */
  maxPollMs?: number
}

/** Resolve the honest post-run mode from the final draft result. Server
 *  convention (CaptureResultSummary.mode): only a REAL provider read is
 *  'live'; stub/demo AND deterministic real-input parses read 'dry-run'
 *  (the demo-badge-conservative bucket). Falls back to the capture
 *  response's queue-time `mode`, then conservatively to 'dry-run' (an
 *  older API that reports neither must never show a LIVE chip). */
function resolveMode(finalResult: DraftResultResponse, captureResponse: CaptureResponse): 'live' | 'dry-run' {
  const live = isLiveProvenance(finalResult.provenance)
  if (live !== null) return live ? 'live' : 'dry-run'
  return captureResponse.result_summary.mode ?? 'dry-run'
}

/**
 * Build the real `TakeoffSessionDeps` for the est-canvas bodies. Stable per
 * `queryClient` — memoize at the call site so `useTakeoffSession`'s machine
 * memo doesn't churn.
 */
export function createTakeoffSessionApiDeps(options: CreateTakeoffSessionApiDepsOptions = {}): TakeoffSessionDeps {
  const api: TakeoffCaptureApi = { ...realApi, ...(options.api ?? {}) }
  const queryClient = options.queryClient ?? null
  const pollIntervalMs = options.pollIntervalMs ?? DRAFT_RESULT_PROCESSING_POLL_MS
  const maxPollMs = options.maxPollMs ?? 5 * 60_000

  return {
    ...unwiredTakeoffSessionDeps,

    async runCapture({ projectId, kind, mode }): Promise<TakeoffCaptureRunOutput> {
      // Dry-run pins the deterministic stub (no provider spend); a live run
      // sends the bare JSON body — the server picks Gemini/Anthropic when the
      // live env is present (202) or falls back to the synchronous stub (201).
      const body: CaptureRequestBody = {
        kind,
        payload: mode === 'dry-run' ? { dryRun: true } : {},
      }
      const captureResponse = await api.capture(projectId, body)
      const captureDraftId = captureResponse.draft.id
      // A new draft now exists either way — let draft lists refetch.
      queryClient?.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] })

      // The capture response never carries the quantities inline; the result
      // endpoint is the single read path (201 ⇒ ready immediately, 202 ⇒
      // poll until the worker settles it).
      const deadline = Date.now() + maxPollMs
      let result = await api.fetchResult(captureDraftId)
      while (draftResultStatus(result) === 'processing') {
        if (Date.now() >= deadline) {
          throw new Error(
            'AI read is still running on the server — it will keep going; check the draft list for the finished result.',
          )
        }
        await api.sleep(pollIntervalMs)
        result = await api.fetchResult(captureDraftId)
      }
      // Draft status flipped — refresh lists/badges that show capture_status.
      queryClient?.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] })

      if (draftResultStatus(result) === 'failed') {
        // Provider errors never produce stub rows — surface them honestly.
        throw new Error(result.error ?? 'The AI provider returned an error. No quantities were produced.')
      }

      return {
        result: result.takeoff_result,
        mode: resolveMode(result, captureResponse),
        draftId: captureDraftId,
      }
    },

    async promoteCaptured({ projectId, draftId, quantityIds }): Promise<void> {
      if (!draftId) {
        throw new Error('takeoff-session: no capture draft to promote (run a capture first)')
      }
      await api.promote(projectId, draftId, { quantity_ids: quantityIds })
      // Same invalidations as usePromoteCapturedQuantities: promoted rows are
      // new measurements on the active draft, and the estimate recomputes.
      queryClient?.invalidateQueries({ queryKey: ['takeoff'] })
      queryClient?.invalidateQueries({ queryKey: ['estimate'] })
      queryClient?.invalidateQueries({ queryKey: ['takeoff-drafts', 'by-project', projectId] })
    },
  }
}
