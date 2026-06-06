// live-workflow-anchor.ts — a tiny module-level holder for the MOST RECENT
// workflow-transition anchor (`workflow_event:<name>:<digest>:<version>`) the
// SPA committed. It exists so the headless trace-mode auto-filer (STEP4) can
// stamp the workflow event_ref the user was last touching when a client error
// fired, WITHOUT each error path having to re-derive it.
//
// The headless workflow machines already emit a recorder mark on every
// transition (`markWorkflowTransition`); they also push the same anchor here so
// it's readable synchronously. Best-effort + bounded: we keep only the last
// anchor and forget it after a short TTL so a stale transition from minutes ago
// never mis-attributes an unrelated crash.

export type LiveWorkflowAnchor = {
  /** The transition-anchor string. */
  eventRef: string
  /** Canonical backend workflow_name. */
  workflowName: string
  /** Entity the transition acted on. */
  entityId: string
  /** Wall-clock ms the anchor was recorded. */
  recordedAtMs: number
}

// After this long with no new transition we treat the last anchor as stale and
// stop attributing errors to it. 2 minutes is long enough to cover an
// in-progress multi-step flow but short enough that an idle tab's last action
// doesn't poison an unrelated later crash.
const ANCHOR_TTL_MS = 2 * 60_000

let lastAnchor: LiveWorkflowAnchor | null = null

/** Called by the headless workflow machines on every committed transition. */
export function recordLiveWorkflowAnchor(input: {
  eventRef: string
  workflowName: string
  entityId: string
  now?: () => number
}): void {
  if (!input.eventRef) return
  lastAnchor = {
    eventRef: input.eventRef,
    workflowName: input.workflowName,
    entityId: input.entityId,
    recordedAtMs: (input.now ?? Date.now)(),
  }
}

/**
 * Read the most recent workflow anchor if it's still within the freshness
 * window. Returns null when nothing has been recorded or the last anchor is
 * older than the TTL.
 */
export function readLiveWorkflowAnchor(now: () => number = Date.now): LiveWorkflowAnchor | null {
  if (!lastAnchor) return null
  if (now() - lastAnchor.recordedAtMs > ANCHOR_TTL_MS) return null
  return lastAnchor
}

/** Test-only — clear the latched anchor so each test starts clean. */
export function __resetLiveWorkflowAnchorForTests(): void {
  lastAnchor = null
}
