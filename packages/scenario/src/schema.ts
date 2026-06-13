import { z } from 'zod'

/**
 * Scenario document schema.
 *
 * This is a 1:1 lift of the hand-written `interface ScenarioYaml` that used to
 * live in `scripts/seed-scenario.ts`. Field names are IDENTICAL so every
 * existing `scenarios/*.yaml` validates unchanged — the only behavioural change
 * is that a malformed doc now fails fast with a Zod error instead of throwing
 * deep inside a seeder. Unknown keys are stripped (Zod default), which matches
 * the old TS behaviour where extra keys were simply never read.
 *
 * Keep this schema complete: the engine reads the parsed doc through the
 * `ScenarioDoc` type, so `tsc` flags any field a seeder reads that is not
 * modeled here. A stripped-but-read field would silently change seed output.
 */

/** Mirrors `apps/api/src/onboarding.ts:COMPANY_SLUG_PATTERN`. Duplicated (not
 *  imported) so this package does not depend on `apps/api` — keep in sync. */
export const COMPANY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/

const ref = z.string().min(1)
/** Arbitrary JSON object (payloads, metadata, result_json, …). */
const json = z.record(z.string(), z.unknown())
/** Ordered workflow events → fed to `applyEventSequence` through the registered
 *  reducer. Loose by design (each reducer validates its own event shape). */
const eventLog = z.array(json)

const member = z.object({
  clerk_user_id: z.string(),
  role: z.string(),
})

const customer = z.object({
  ref,
  name: z.string(),
})

const worker = z.object({
  ref,
  name: z.string(),
  role: z.string().optional(),
  clerk_user_id: z.string().optional(),
})

const inventoryItem = z.object({
  ref,
  code: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().optional(),
  default_rental_rate: z.number().optional(),
  replacement_value: z.number().optional(),
  tracking_mode: z.string().optional(),
})

const project = z.object({
  ref,
  name: z.string(),
  customer_ref: z.string().optional(),
  customer_name: z.string().optional(),
  division_code: z.string().optional(),
  status: z.string().optional(),
  bid_total: z.number().optional(),
  labor_rate: z.number().optional(),
  target_sqft_per_hr: z.number().optional(),
  bonus_pool: z.number().optional(),
  lifecycle_state: z.string().optional(),
  lifecycle_state_version: z.number().int().optional(),
  lifecycle_event_log: eventLog.optional(),
})

const rental = z.object({
  ref,
  project_ref: z.string(),
  customer_ref: z.string().optional(),
  inventory_ref: z.string(),
  quantity: z.number(),
  billing_cycle_days: z.number().optional(),
  billing_mode: z.string().optional(),
  agreed_rate: z.number().optional(),
  rate_unit: z.string().optional(),
  on_rent_date: z.string().optional(),
  billing_start_date: z.string().optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  subtotal: z.number().optional(),
  billing_event_log: eventLog.optional(),
  outbox_next_attempt_offset_minutes: z.number().optional(),
})

const estimate = z.object({
  ref,
  project_ref: z.string(),
  customer_ref: z.string().optional(),
  subtotal: z.number().optional(),
  push_event_log: eventLog.optional(),
})

const workerIssue = z.object({
  ref,
  project_ref: z.string().optional(),
  worker_ref: z.string().optional(),
  reporter_clerk_user_id: z.string(),
  kind: z.string(),
  message: z.string(),
  severity: z.string().optional(),
  created_offset_minutes: z.number().optional(),
  issue_event_log: eventLog.optional(),
})

const clockEvent = z.object({
  worker_ref: z.string().optional(),
  project_ref: z.string().optional(),
  clerk_user_id: z.string().optional(),
  event_type: z.string(),
  occurred_at: z.string().optional(),
  occurred_at_offset_minutes: z.number().optional(),
  inside_geofence: z.boolean().optional(),
})

/** A board-space point ({x,y} in 0..100). */
const boardPoint = z.object({ x: z.number(), y: z.number() })

/** Permissive seed geometry. The planner normalizes this through
 *  `buildGeometry` (src/geometry-fixtures.ts) into a canonical 0–100
 *  board-space JSON the API's `normalizeGeometry` would accept. A `polygon`
 *  needs ≥3 points, a `lineal` ≥2, a `count` ≥1, a `volume` positive l/w/h. */
const geometryInput = z.object({
  kind: z.enum(['polygon', 'lineal', 'count', 'volume']).optional(),
  points: z.array(boardPoint).optional(),
  length: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  unit: z.string().optional(),
})

/** Optional renderable-geometry fields shared by both measurement sections.
 *  ALL optional + additive: a measurement that omits every field keeps the
 *  exact legacy insert shape (geometry defaults to `{}`, no extra columns). */
const measurementGeometryFields = {
  geometry_kind: z.enum(['polygon', 'lineal', 'count', 'volume']).optional(),
  geometry: geometryInput.optional(),
  page_ref: z.string().optional(),
  blueprint_ref: z.string().optional(),
  condition_ref: z.string().optional(),
  is_deduction: z.boolean().optional(),
  elevation: z.string().optional(),
  unit_canonical: z.string().optional(),
  division_code: z.string().optional(),
}

const takeoffMeasurements = z.object({
  project_ref: z.string(),
  count: z.number(),
  service_item_code: z.string().optional(),
  unit: z.string().optional(),
  ...measurementGeometryFields,
})

const blueprintPage = z.object({
  ref,
  page_number: z.number().int().optional(),
  storage_path: z.string().optional(),
  calibration: z
    .object({
      world_distance: z.number(),
      world_unit: z.string(),
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      verified: z.boolean().optional(),
    })
    .optional(),
})

const blueprint = z.object({
  ref,
  project_ref: z.string(),
  file_name: z.string().optional(),
  preview_type: z.string().optional(),
  // Optional repo-relative path to a real PDF (e.g. `blueprints_sample/foo.pdf`).
  // When set, the seeder reads the bytes and stores them at the blueprint's
  // deterministic storage_path so the canvas renders the real plan instead of
  // the empty grid. Metadata-only blueprints (no source_file) keep the old
  // placeholder behaviour.
  source_file: z.string().optional(),
  pages: z.array(blueprintPage),
})

const takeoffCondition = z.object({
  ref,
  name: z.string(),
  color: z.string().optional(),
  measurement_kind: z.enum(['area', 'linear', 'count', 'volume']).optional(),
  emit_linear: z.boolean().optional(),
  emit_area: z.boolean().optional(),
  emit_volume: z.boolean().optional(),
  height_value: z.number().optional(),
  thickness_value: z.number().optional(),
  sides: z.number().int().optional(),
  slope_value: z.number().optional(),
  default_assembly_ref: z.string().optional(),
  created_by: z.string().optional(),
})

const damageCharge = z.object({
  ref,
  project_ref: z.string(),
  customer_ref: z.string().optional(),
  kind: z.string().optional(),
  quantity: z.number().optional(),
  unit_amount: z.number().optional(),
  total_amount: z.number().optional(),
  description: z.string(),
  settlement_event_log: eventLog.optional(),
})

const rentalRequest = z.object({
  ref,
  customer_ref: z.string().optional(),
  contact_name: z.string().optional(),
  contact_email: z.string().optional(),
  contact_phone: z.string().optional(),
  requested_start: z.string().optional(),
  requested_end: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(json).optional(),
  approval_event_log: eventLog.optional(),
})

const qboSyncRun = z.object({
  ref,
  provider: z.string().optional(),
  triggered_by: z.string().optional(),
  sync_event_log: eventLog.optional(),
})

const bom = z.object({
  ref,
  project_ref: z.string(),
  name: z.string(),
  source: z.string().optional(),
  source_ref: z.string().optional(),
  notes: z.string().optional(),
  total_weight_kg: z.number().optional(),
  total_lines: z.number().optional(),
  approval_event_log: eventLog.optional(),
})

const estimateLine = z.object({
  project_ref: z.string(),
  service_item_code: z.string(),
  quantity: z.number(),
  unit: z.string().optional(),
  rate: z.number().optional(),
  amount: z.number().optional(),
})

const materialBill = z.object({
  project_ref: z.string(),
  vendor_name: z.string(),
  amount: z.number(),
  bill_type: z.string().optional(),
  description: z.string().optional(),
  occurred_on: z.string().optional(),
  occurred_on_offset_days: z.number().optional(),
})

const laborEntry = z.object({
  project_ref: z.string(),
  worker_ref: z.string().optional(),
  service_item_code: z.string(),
  hours: z.number().optional(),
  sqft_done: z.number().optional(),
  status: z.string().optional(),
  occurred_on: z.string().optional(),
  occurred_on_offset_days: z.number().optional(),
})

const changeOrder = z.object({
  ref,
  project_ref: z.string(),
  number: z.number(),
  description: z.string().optional(),
  value_delta: z.number(),
  schedule_impact_days: z.number().optional(),
  created_by: z.string().optional(),
  co_event_log: eventLog.optional(),
})

const crewSchedule = z.object({
  ref,
  project_ref: z.string(),
  scheduled_for: z.string().optional(),
  scheduled_for_offset_days: z.number().optional(),
  crew: z
    .array(
      z.object({
        worker_ref: z.string().optional(),
        clerk_user_id: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .optional(),
  status: z.string().optional(),
  confirmed_by: z.string().optional(),
})

const dailyLog = z.object({
  ref: z.string().optional(),
  project_ref: z.string(),
  foreman_user_id: z.string(),
  occurred_on: z.string().optional(),
  occurred_on_offset_days: z.number().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
  scope_progress: z.array(z.unknown()).optional(),
})

/**
 * `run_capture` directive (Track B / SIM-2). When a takeoff draft declares
 * `run_capture: { kind: blueprint_vision, mode: dry-run }` instead of (or
 * alongside) a hand-authored `result_json`, the engine runs the DETERMINISTIC
 * dry-run capture (`runDryRunCapture` from `@sitelayer/pipe-blueprint`, injected
 * via `ApplyContext`) at SEED TIME and persists ITS real output as the draft's
 * `result_json` — so the seeded AI-review state IS the stub's output, not a
 * fixture that can drift from it. Only `blueprint_vision` + `dry-run` are wired
 * today (live providers are async/keyed and out of scope for deterministic
 * seeding). A scenario omitting `run_capture` plans byte-identically to before.
 */
const runCaptureDirective = z.object({
  kind: z.literal('blueprint_vision'),
  mode: z.literal('dry-run'),
})

const takeoffDraft = z.object({
  ref,
  project_ref: z.string(),
  name: z.string(),
  type: z.string().optional(),
  source: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  review_required: z.boolean().optional(),
  result_json: json.optional(),
  run_capture: runCaptureDirective.optional(),
  measurements: z
    .array(
      z.object({
        service_item_code: z.string(),
        quantity: z.number(),
        unit: z.string().optional(),
        ...measurementGeometryFields,
      }),
    )
    .optional(),
})

const captureSessionEvent = z.object({
  event_type: z.string(),
  event_class: z.string().optional(),
  route_path: z.string().optional(),
  workflow_id: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  entity_ref: z.string().optional(),
  client_event_id: z.string().optional(),
  seq: z.number().optional(),
  request_id: z.string().optional(),
  payload: json.optional(),
  occurred_at: z.string().optional(),
  occurred_offset_minutes: z.number().optional(),
})

const captureArtifact = z.object({
  ref: z.string().optional(),
  kind: z.string(),
  storage_key: z.string().optional(),
  uri: z.string().optional(),
  content_type: z.string().optional(),
  byte_size: z.number().optional(),
  content_hash: z.string().optional(),
  duration_ms: z.number().optional(),
  pii_level: z.string().optional(),
  access_policy: z.string().optional(),
  metadata: json.optional(),
  retention_expires_at: z.string().optional(),
  retention_offset_days: z.number().optional(),
  created_at: z.string().optional(),
  created_offset_minutes: z.number().optional(),
  deleted_at: z.string().optional(),
  redaction_version: z.string().optional(),
})

const captureHandoffEvent = z.object({
  event_type: z.string(),
  actor_kind: z.string().optional(),
  actor_user_id: z.string().optional(),
  actor_ref: z.string().optional(),
  source_system: z.string().optional(),
  payload: json.optional(),
  metadata: json.optional(),
  idempotency_key: z.string().optional(),
  request_id: z.string().optional(),
  build_sha: z.string().optional(),
  redaction_version: z.string().optional(),
  occurred_at: z.string().optional(),
  occurred_offset_minutes: z.number().optional(),
})

const captureWorkItem = z.object({
  ref: z.string().optional(),
  support_packet_ref: z.string().optional(),
  title: z.string(),
  summary: z.string().optional(),
  status: z.string().optional(),
  lane: z.string().optional(),
  severity: z.string().optional(),
  route: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  entity_ref: z.string().optional(),
  assignee_user_id: z.string().optional(),
  created_by_user_id: z.string().optional(),
  metadata: json.optional(),
  reversibility_window_seconds: z.number().optional(),
  created_at: z.string().optional(),
  created_offset_minutes: z.number().optional(),
  resolved_at: z.string().optional(),
  handoff_events: z.array(captureHandoffEvent).optional(),
})

const captureSession = z.object({
  ref,
  actor_user_id: z.string().optional(),
  mode: z.string().optional(),
  status: z.string().optional(),
  route_path: z.string().optional(),
  device_kind: z.string().optional(),
  platform: z.string().optional(),
  viewport: z.string().optional(),
  app_build_sha: z.string().optional(),
  consent_version: z.string().optional(),
  consent_actor_kind: z.string().optional(),
  consent_actor_ref: z.string().optional(),
  consent_authority: z.string().optional(),
  consent_scope: json.optional(),
  metadata: json.optional(),
  started_at: z.string().optional(),
  started_offset_minutes: z.number().optional(),
  stopped_at: z.string().optional(),
  stopped_offset_minutes: z.number().optional(),
  discarded_at: z.string().optional(),
  discarded_offset_minutes: z.number().optional(),
  retention_expires_at: z.string().optional(),
  retention_offset_days: z.number().optional(),
  events: z.array(captureSessionEvent).optional(),
  artifacts: z.array(captureArtifact).optional(),
  work_item: captureWorkItem.optional(),
})

export const ScenarioDoc = z.object({
  company: z.object({
    slug: z.string().regex(COMPANY_SLUG_PATTERN),
    name: z.string(),
  }),
  members: z.array(member).optional(),
  customers: z.array(customer).optional(),
  workers: z.array(worker).optional(),
  inventory: z.array(inventoryItem).optional(),
  projects: z.array(project).optional(),
  rentals: z.array(rental).optional(),
  estimates: z.array(estimate).optional(),
  worker_issues: z.array(workerIssue).optional(),
  clock_events: z.array(clockEvent).optional(),
  blueprints: z.array(blueprint).optional(),
  takeoff_conditions: z.array(takeoffCondition).optional(),
  takeoff_measurements: takeoffMeasurements.optional(),
  damage_charges: z.array(damageCharge).optional(),
  rental_requests: z.array(rentalRequest).optional(),
  qbo_sync_runs: z.array(qboSyncRun).optional(),
  boms: z.array(bom).optional(),
  // ---- Demo-oriented sections (steve-demo.yaml) ----
  estimate_lines: z.array(estimateLine).optional(),
  material_bills: z.array(materialBill).optional(),
  labor_entries: z.array(laborEntry).optional(),
  change_orders: z.array(changeOrder).optional(),
  crew_schedules: z.array(crewSchedule).optional(),
  daily_logs: z.array(dailyLog).optional(),
  takeoff_drafts: z.array(takeoffDraft).optional(),
  capture_sessions: z.array(captureSession).optional(),
})

export type ScenarioDoc = z.infer<typeof ScenarioDoc>
