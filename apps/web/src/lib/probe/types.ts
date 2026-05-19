/**
 * Page-context dispatch contract — TypeScript types.
 *
 * Implements ADR-0019 §4 (dispatcher slot table). The `Capture` is the
 * point-in-time payload a per-app Probe produces when the operator opens
 * the chat widget on a page. Slot meanings (verbatim from the ADR):
 *
 *   - `page_state`   — live business state the app already knows (xstate
 *                      context, fetched WorkflowSnapshot, etc.)
 *   - `path`         — entity identity + the event-log tail that explains
 *                      how we got here (route, entity_type, entity_id,
 *                      workflow_event_log_tail)
 *   - `principal`    — app-side authenticated identity (Clerk user +
 *                      active company role). NB: distinct from mesh's
 *                      `principals` table.
 *   - `acting_as`    — declared operator override (optional). When the
 *                      operator wants the runner to treat them as a
 *                      foreman / customer / etc., this is where the
 *                      override lives. Renamed from Persona per ADR.
 *   - `trace`        — `sentry-trace` + `span_id` so the dispatched
 *                      conversation joins the same trace tree as the
 *                      page that produced it.
 *   - `deploy`       — `app_build_sha` + tier env so the runner knows
 *                      which code shipped this state.
 *   - `feature_flags`— optional flag map; v1 includes anything that
 *                      changes the page's behaviour (e.g. live vs
 *                      stub QBO push).
 *
 * Keep the union small + serialisable — the wire payload must stay
 * <2KB JSON for a typical page (ADR consequence: ~10x cheaper than a
 * screenshot+DOM dump). Anything large goes in `ambient` (reserved for
 * v1.1 — not part of v1) or behind a follow-up fetch keyed off `path`.
 */

/** ISO-8601 timestamp string. */
export type Iso8601 = string

/**
 * One row from the workflow_event_log tail. The Probe sends the last
 * N rows (typically 3) so the runner can answer causality questions
 * ("why is this stuck?") without round-tripping the API.
 *
 * The server-side row shape lives in `mesh/postgres/migrations/...`
 * (workflow_event_log table). We mirror only the columns useful to a
 * reader; large blob columns (event_payload) are JSON-encoded.
 */
export interface WorkflowEventLogRow {
  /** Row primary key. */
  id: string
  /** Workflow name e.g. "estimate_push". */
  workflow_name: string
  /** Entity primary key the row is anchored to. */
  entity_id: string
  /** Event type that fired this transition (REVIEW, APPROVE, ...). */
  event_type: string
  /** Previous state (pre-transition). */
  from_state: string | null
  /** New state (post-transition). */
  to_state: string
  /** Pre-transition state_version. */
  from_state_version: number
  /** Post-transition state_version (== from_state_version + 1). */
  to_state_version: number
  /** Actor — Clerk user id or worker name where applicable. */
  actor_user_id: string | null
  /** When the row landed in the DB. */
  created_at: Iso8601
  /** Optional inline event payload (kept small; large bodies elided). */
  event_payload?: Record<string, unknown> | null
}

/** App-side authenticated identity at the moment of capture. */
export interface CapturePrincipal {
  /** Source of the principal — Clerk in prod, dev-fallback in local. */
  source: 'clerk' | 'dev-fallback' | 'anonymous'
  /** Clerk user id (e.g. `user_abc123`); null when anonymous. */
  user_id: string | null
  /** Primary email if known (Clerk users always carry one). */
  email: string | null
  /** Full name as Clerk reports it; null when not set. */
  display_name: string | null
  /** Active company slug from localStorage / default. */
  active_company_slug: string | null
  /**
   * Active company role for THIS user in THIS company (admin / foreman
   * / office / member / bookkeeper). Sourced from the same place
   * `useRole` reads from. May be null when the role can't be resolved
   * from the SPA alone (Phase 0 substrate; see lib/role.ts).
   */
  active_company_role: string | null
}

/** Operator-declared override identity. v1: optional, hand-passed. */
export interface CaptureActingAs {
  /** Free-form role name e.g. "foreman", "customer". */
  role: string
  /** Optional company slug if the override scopes to another tenant. */
  company_slug?: string | null
  /** Free-form note the operator wants the runner to read. */
  note?: string | null
}

/**
 * Path slot — entity identity + the event-log tail. The shape is shared
 * across all Probes; "Thin" Probes only fill `route` + `entity_id`
 * (per the NHL example in ADR-0019). SiteLayer is the Thick archetype
 * and fills the workflow_event_log_tail too.
 */
export interface CapturePath {
  /** Window location pathname (e.g. `/financial/estimate-pushes/123`). */
  route: string
  /** Workflow-bound entity type (e.g. `estimate_push`). */
  entity_type: string
  /** Entity primary key. */
  entity_id: string
  /**
   * Last N rows from workflow_event_log for this entity, newest-first.
   * Empty array when the endpoint isn't wired (the Probe leaves a
   * `TODO` in the row and ships an empty tail rather than failing).
   */
  workflow_event_log_tail: WorkflowEventLogRow[]
  /**
   * When the tail couldn't be fetched (e.g. endpoint not deployed),
   * the Probe records the reason here. Runners can fall back to a
   * full API query keyed on `entity_id` when this is set.
   */
  tail_error?: string | null
}

/** W3C trace context the runner uses to join the SPA's Sentry trace. */
export interface CaptureTrace {
  /** Full `sentry-trace` header value (`<trace_id>-<span_id>-<sampled>`). */
  sentry_trace: string
  /** Parsed parent span id, when extractable. */
  span_id: string | null
  /** W3C baggage header, kept verbatim. */
  baggage: string | null
}

/** Deploy slot — which code shipped this state. */
export interface CaptureDeploy {
  /** Build SHA, sourced from /api/version (cached). */
  app_build_sha: string | null
  /** Tier name (`local` / `dev` / `preview` / `prod`). */
  env: string | null
}

/** Feature-flag map; values stay simple to keep payload small. */
export type CaptureFeatureFlags = Record<string, boolean | number | string | null>

/**
 * Top-level Capture — the dispatcher serializes this to JSON and stuffs
 * it into `mesh.execution_context` (ADR-0019 §"Wire seam"). v1 omits
 * `ambient` (reserved for v1.1 attachments / DOM tail).
 *
 * Slot inventory matches ADR-0019 §4 verbatim. Any new top-level key
 * must update both this type AND the dispatcher prose to stay in sync;
 * the contract is intentionally small.
 */
export interface Capture {
  /**
   * Probe schema version. v1 = the ADR-0019 contract as-shipped. Bump
   * when a slot's shape changes incompatibly so the dispatcher can
   * route by version.
   */
  capture_version: 1
  /** Probe identifier (`sitelayer.estimate_push`, etc.). */
  probe_id: string
  /** When the capture was assembled (client clock). */
  captured_at: Iso8601
  /** Live app state for the page. */
  page_state: Record<string, unknown>
  /** Entity path + event-log tail. */
  path: CapturePath
  /** App-side authenticated identity. */
  principal: CapturePrincipal
  /** Optional operator override. */
  acting_as?: CaptureActingAs | null
  /** Optional W3C trace context. */
  trace?: CaptureTrace | null
  /** Optional deploy fingerprint. */
  deploy?: CaptureDeploy | null
  /** Optional feature-flag snapshot. */
  feature_flags?: CaptureFeatureFlags | null
  /**
   * Free-form per-probe notes; the v1 Probes use this to thread TODO
   * markers ("workflow_event_log GET endpoint TBD") through to the
   * runner without dropping the whole capture.
   */
  notes?: string[]
}
