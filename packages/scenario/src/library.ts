import type { PartialScenario } from './fragments.js'

/**
 * Reusable scenario fragments (P1).
 *
 * Small, parameterized factories that each return a company-less
 * `PartialScenario`. They mirror the proven event shapes in `scenarios/*.yaml`,
 * so the timelines they emit replay through the real `@sitelayer/workflows`
 * reducers exactly like the hand-written fixtures.
 *
 * Compose them with `composeScenario(...)` into one doc, then hand the result to
 * `planScenario`/`applyScenario`; or feed them to `runFragments` for the
 * apply-in-sequence path. Because reducers are pure and ids are ref-hashed, any
 * composition is deterministic and idempotent.
 *
 *   const doc = {
 *     company: { slug: 'acme', name: 'Acme' },
 *     ...composeScenario(
 *       starterFixtures(),
 *       projectInProgress('alpha', { customerRef: 'cust-1' }),
 *       rentalStuckPosting('r1', { projectRef: 'alpha', inventoryRef: 'scaffold' }),
 *       estimatePushPendingReview('e1', { projectRef: 'alpha' }),
 *     ),
 *   }
 */

const T0 = '2026-01-15T10:00:00.000Z'
const T1 = '2026-01-15T11:00:00.000Z'
const T2 = '2026-01-15T11:05:00.000Z'

// ---------- Atoms ----------

export function member(clerkUserId: string, role: string): PartialScenario {
  return { members: [{ clerk_user_id: clerkUserId, role }] }
}

export function customer(ref: string, name?: string): PartialScenario {
  return { customers: [{ ref, name: name ?? ref }] }
}

export function worker(
  ref: string,
  opts: { name?: string; role?: string; clerkUserId?: string } = {},
): PartialScenario {
  return {
    workers: [
      {
        ref,
        name: opts.name ?? ref,
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        ...(opts.clerkUserId !== undefined ? { clerk_user_id: opts.clerkUserId } : {}),
      },
    ],
  }
}

export function inventoryItem(
  ref: string,
  opts: { code?: string; defaultRentalRate?: number; replacementValue?: number } = {},
): PartialScenario {
  return {
    inventory: [
      {
        ref,
        code: opts.code ?? ref.toUpperCase(),
        default_rental_rate: opts.defaultRentalRate ?? 1.5,
        replacement_value: opts.replacementValue ?? 250,
      },
    ],
  }
}

/** The common base every demo/test company wants: a customer, a foreman, and a
 *  scaffold inventory item. */
export function starterFixtures(): PartialScenario {
  return composeScenario(
    customer('cust-1', 'Acme Customer'),
    worker('foreman-1', { name: 'Foreman One', role: 'foreman' }),
    inventoryItem('scaffold', { code: 'SCAF-001' }),
  )
}

// ---------- Projects (project_lifecycle) ----------

function projectAt(
  ref: string,
  lifecycleState: string,
  lifecycleStateVersion: number,
  opts: { name?: string; customerRef?: string; divisionCode?: string; bidTotal?: number } = {},
): PartialScenario {
  return {
    projects: [
      {
        ref,
        name: opts.name ?? ref,
        status: 'active',
        division_code: opts.divisionCode ?? 'D4',
        lifecycle_state: lifecycleState,
        lifecycle_state_version: lifecycleStateVersion,
        ...(opts.customerRef !== undefined ? { customer_ref: opts.customerRef } : {}),
        ...(opts.bidTotal !== undefined ? { bid_total: opts.bidTotal } : {}),
      },
    ],
  }
}

export function projectAtEstimating(ref: string, opts?: Parameters<typeof projectAt>[3]): PartialScenario {
  return projectAt(ref, 'estimating', 2, opts)
}

export function projectInProgress(ref: string, opts?: Parameters<typeof projectAt>[3]): PartialScenario {
  return projectAt(ref, 'in_progress', 4, opts)
}

// ---------- Rentals (rental_billing_run) ----------

interface RentalOpts {
  projectRef: string
  inventoryRef: string
  customerRef?: string
  quantity?: number
  subtotal?: number
}

function rental(ref: string, opts: RentalOpts, billingEventLog: Array<Record<string, unknown>>): PartialScenario {
  return {
    rentals: [
      {
        ref,
        project_ref: opts.projectRef,
        inventory_ref: opts.inventoryRef,
        quantity: opts.quantity ?? 10,
        subtotal: opts.subtotal ?? 1000,
        ...(opts.customerRef !== undefined ? { customer_ref: opts.customerRef } : {}),
        billing_event_log: billingEventLog,
      },
    ],
  }
}

/** generated → approved → posting. Enqueues a mutation_outbox row (the worker
 *  picks it up). `outboxOffsetMinutes` backdates it so it claims immediately. */
export function rentalStuckPosting(ref: string, opts: RentalOpts & { outboxOffsetMinutes?: number }): PartialScenario {
  const frag = rental(ref, opts, [
    { type: 'APPROVE', approved_at: T0, approved_by: 'e2e-office' },
    { type: 'POST_REQUESTED' },
  ])
  if (opts.outboxOffsetMinutes !== undefined)
    frag.rentals![0]!.outbox_next_attempt_offset_minutes = opts.outboxOffsetMinutes
  return frag
}

/** generated → approved → posting → posted (terminal, with a QBO invoice id). */
export function rentalPostedInvoice(ref: string, opts: RentalOpts & { qboInvoiceId?: string }): PartialScenario {
  return rental(ref, opts, [
    { type: 'APPROVE', approved_at: T0, approved_by: 'e2e-office' },
    { type: 'POST_REQUESTED' },
    { type: 'POST_SUCCEEDED', posted_at: T1, qbo_invoice_id: opts.qboInvoiceId ?? `INV-${ref}` },
  ])
}

/** generated → approved → posting → failed (a billing dispute / QBO error). */
export function rentalBillingFailed(ref: string, opts: RentalOpts & { error?: string }): PartialScenario {
  return rental(ref, opts, [
    { type: 'APPROVE', approved_at: T0, approved_by: 'e2e-office' },
    { type: 'POST_REQUESTED' },
    { type: 'POST_FAILED', failed_at: T2, error: opts.error ?? 'QBO 402: invoice rejected' },
  ])
}

// ---------- Estimates (estimate_push) ----------

interface EstimateOpts {
  projectRef: string
  customerRef?: string
  subtotal?: number
}

function estimate(ref: string, opts: EstimateOpts, pushEventLog: Array<Record<string, unknown>>): PartialScenario {
  return {
    estimates: [
      {
        ref,
        project_ref: opts.projectRef,
        subtotal: opts.subtotal ?? 25000,
        ...(opts.customerRef !== undefined ? { customer_ref: opts.customerRef } : {}),
        push_event_log: pushEventLog,
      },
    ],
  }
}

/** drafted → reviewed (sits in the approval queue awaiting APPROVE). */
export function estimatePushPendingReview(ref: string, opts: EstimateOpts): PartialScenario {
  return estimate(ref, opts, [{ type: 'REVIEW', reviewed_at: T0, reviewed_by: 'e2e-office' }])
}

/** drafted → reviewed → approved → posting → failed. */
export function estimatePushFailed(ref: string, opts: EstimateOpts & { error?: string }): PartialScenario {
  return estimate(ref, opts, [
    { type: 'REVIEW', reviewed_at: T0, reviewed_by: 'e2e-office' },
    { type: 'APPROVE', approved_at: T1, approved_by: 'e2e-admin' },
    { type: 'POST_REQUESTED' },
    { type: 'POST_FAILED', failed_at: T2, error: opts.error ?? 'QBO 402: estimate rejected' },
  ])
}

// ---------- Damage charges (damage_charge_settlement) ----------

interface DamageOpts {
  projectRef: string
  customerRef?: string
  amount?: number
  description?: string
}

/** An open damage charge awaiting settlement. */
export function damageChargeOpen(ref: string, opts: DamageOpts): PartialScenario {
  const amount = opts.amount ?? 500
  return {
    damage_charges: [
      {
        ref,
        project_ref: opts.projectRef,
        kind: 'damage',
        quantity: 1,
        unit_amount: amount,
        total_amount: amount,
        description: opts.description ?? 'Damage on return',
        ...(opts.customerRef !== undefined ? { customer_ref: opts.customerRef } : {}),
      },
    ],
  }
}

/** open → invoiced (terminal happy path). */
export function damageChargeInvoiced(ref: string, opts: DamageOpts): PartialScenario {
  const frag = damageChargeOpen(ref, opts)
  frag.damage_charges![0]!.settlement_event_log = [{ type: 'INVOICE', invoiced_at: T0, invoiced_by: 'e2e-office' }]
  return frag
}

// ---------- Other approvals ----------

/** pending → approved portal rental request. */
export function rentalRequestApproved(
  ref: string,
  opts: { customerRef?: string; contactEmail?: string } = {},
): PartialScenario {
  return {
    rental_requests: [
      {
        ref,
        contact_email: opts.contactEmail ?? 'portal@example.com',
        ...(opts.customerRef !== undefined ? { customer_ref: opts.customerRef } : {}),
        approval_event_log: [{ type: 'APPROVE', approved_at: T0, approved_by: 'e2e-admin' }],
      },
    ],
  }
}

/** pending → syncing → failed QBO sync run. */
export function qboSyncRunFailed(ref: string, opts: { error?: string } = {}): PartialScenario {
  return {
    qbo_sync_runs: [
      {
        ref,
        triggered_by: 'e2e-admin',
        sync_event_log: [
          { type: 'START_SYNC', started_at: T0, triggered_by: 'e2e-admin' },
          { type: 'SYNC_FAILED', failed_at: T1, error: opts.error ?? 'Intuit 503 Service Unavailable' },
        ],
      },
    ],
  }
}

/** draft → approved scaffold BOM. */
export function bomApproved(ref: string, opts: { projectRef: string; name?: string }): PartialScenario {
  return {
    boms: [
      {
        ref,
        project_ref: opts.projectRef,
        name: opts.name ?? 'Scaffold BOM',
        approval_event_log: [{ type: 'APPROVE', approved_at: T0, approved_by: 'e2e-admin' }],
      },
    ],
  }
}

// ---------- Renderable takeoff (blueprints + geometry) ----------

/**
 * A blueprint document with one calibrated page — the minimum a seeded takeoff
 * needs so the canvas opens to a real sheet + scale instead of a blank board.
 * The calibration defaults describe a horizontal 60ft scale bar across the page;
 * pass `verified: true` (default) to also stamp `scale_verified_at`.
 */
export function blueprintWithCalibratedPage(
  ref: string,
  opts: {
    projectRef: string
    pageRef?: string
    fileName?: string
    worldDistance?: number
    worldUnit?: string
    verified?: boolean
  },
): PartialScenario {
  return {
    blueprints: [
      {
        ref,
        project_ref: opts.projectRef,
        file_name: opts.fileName ?? `${ref}.pdf`,
        pages: [
          {
            ref: opts.pageRef ?? `${ref}-p1`,
            page_number: 1,
            calibration: {
              world_distance: opts.worldDistance ?? 60,
              world_unit: opts.worldUnit ?? 'ft',
              x1: 18,
              y1: 82,
              x2: 82,
              y2: 82,
              verified: opts.verified ?? true,
            },
          },
        ],
      },
    ],
  }
}

/**
 * A manual takeoff draft carrying a few real-geometry measurements (a wall-area
 * polygon, an insulation lineal run, and a window count), all pinned to a
 * calibrated blueprint page so they render on the canvas. Mirrors the shapes in
 * `apps/web/.../takeoff-preview-demo-fixtures.ts` but DB-seeds them.
 */
export function takeoffDraftWithGeometry(
  ref: string,
  opts: { projectRef: string; blueprintRef: string; pageRef: string; name?: string },
): PartialScenario {
  return {
    takeoff_drafts: [
      {
        ref,
        project_ref: opts.projectRef,
        name: opts.name ?? 'Renderable takeoff',
        source: 'manual',
        review_required: false,
        measurements: [
          {
            service_item_code: '09 29 00',
            quantity: 240,
            unit: 'sqft',
            unit_canonical: 'SQFT',
            geometry_kind: 'polygon',
            elevation: 'south',
            blueprint_ref: opts.blueprintRef,
            page_ref: opts.pageRef,
            geometry: {
              kind: 'polygon',
              points: [
                { x: 20, y: 24 },
                { x: 76, y: 24 },
                { x: 76, y: 38 },
                { x: 20, y: 38 },
              ],
            },
          },
          {
            service_item_code: '07 21 00',
            quantity: 52,
            unit: 'lf',
            unit_canonical: 'LF',
            geometry_kind: 'lineal',
            elevation: 'east',
            blueprint_ref: opts.blueprintRef,
            page_ref: opts.pageRef,
            geometry: {
              kind: 'lineal',
              points: [
                { x: 20, y: 70 },
                { x: 42, y: 76 },
                { x: 66, y: 72 },
                { x: 80, y: 62 },
              ],
            },
          },
          {
            service_item_code: '08 50 00',
            quantity: 3,
            unit: 'ea',
            unit_canonical: 'EA',
            geometry_kind: 'count',
            blueprint_ref: opts.blueprintRef,
            page_ref: opts.pageRef,
            geometry: {
              kind: 'count',
              points: [
                { x: 30, y: 48 },
                { x: 52, y: 48 },
                { x: 74, y: 48 },
              ],
            },
          },
        ],
      },
    ],
  }
}

/**
 * An AI-capture draft sitting in the review queue: `source != manual`,
 * `review_required = true`, and a `result_json` carrying mixed-confidence
 * captured quantities (the shape the promote screen reads). Geometry is pinned
 * to the supplied blueprint page so the review canvas renders.
 */
export function aiCaptureDraftPendingReview(
  ref: string,
  opts: {
    projectRef: string
    blueprintRef: string
    pageRef: string
    source?: 'blueprint_vision' | 'roomplan' | 'photogrammetry' | 'drone'
    name?: string
  },
): PartialScenario {
  const source = opts.source ?? 'blueprint_vision'
  return {
    takeoff_drafts: [
      {
        ref,
        project_ref: opts.projectRef,
        name: opts.name ?? 'AI capture (pending review)',
        source,
        kind: 'takeoff',
        review_required: true,
        result_json: {
          pipeline: source,
          generated_at: T0,
          quantities: [
            {
              service_item_code: '09 29 00',
              quantity: 512,
              unit: 'sqft',
              confidence: 0.93,
              label: 'great room wall area',
            },
            {
              service_item_code: '12 30 00',
              quantity: 168,
              unit: 'sqft',
              confidence: 0.71,
              label: 'kitchen footprint',
            },
            {
              service_item_code: '08 50 00',
              quantity: 8,
              unit: 'ea',
              confidence: 0.42,
              label: 'window openings (low confidence)',
            },
          ],
        },
        measurements: [
          {
            service_item_code: '09 29 00',
            quantity: 512,
            unit: 'sqft',
            unit_canonical: 'SQFT',
            geometry_kind: 'polygon',
            blueprint_ref: opts.blueprintRef,
            page_ref: opts.pageRef,
            geometry: {
              kind: 'polygon',
              points: [
                { x: 16, y: 18 },
                { x: 56, y: 18 },
                { x: 56, y: 54 },
                { x: 16, y: 54 },
              ],
            },
          },
          {
            service_item_code: '08 50 00',
            quantity: 8,
            unit: 'ea',
            unit_canonical: 'EA',
            geometry_kind: 'count',
            blueprint_ref: opts.blueprintRef,
            page_ref: opts.pageRef,
            geometry: {
              kind: 'count',
              points: [
                { x: 24, y: 18 },
                { x: 40, y: 18 },
                { x: 68, y: 18 },
                { x: 82, y: 30 },
                { x: 82, y: 40 },
                { x: 34, y: 82 },
                { x: 18, y: 66 },
                { x: 16, y: 36 },
              ],
            },
          },
        ],
      },
    ],
  }
}

// ---------- Composition ----------

const ARRAY_SECTIONS = [
  'members',
  'customers',
  'workers',
  'inventory',
  'projects',
  'rentals',
  'estimates',
  'worker_issues',
  'clock_events',
  'blueprints',
  'takeoff_conditions',
  'damage_charges',
  'rental_requests',
  'qbo_sync_runs',
  'boms',
  'estimate_lines',
  'material_bills',
  'labor_entries',
  'change_orders',
  'crew_schedules',
  'daily_logs',
  'takeoff_drafts',
  'capture_sessions',
] as const

/**
 * Merge fragments into one `PartialScenario` by concatenating each array
 * section in order. The singleton `takeoff_measurements` section is last-wins.
 * Fragment authors keep refs unique; duplicates are left as-is (the engine's
 * ON CONFLICT DO NOTHING makes a same-ref duplicate idempotent rather than an
 * error, but prefer unique refs for clarity).
 */
export function composeScenario(...parts: PartialScenario[]): PartialScenario {
  const out: PartialScenario = {}
  for (const part of parts) {
    for (const section of ARRAY_SECTIONS) {
      const items = part[section]
      if (!items) continue
      const existing = (out[section] ?? []) as unknown[]
      out[section] = [...existing, ...(items as unknown[])] as never
    }
    if (part.takeoff_measurements) out.takeoff_measurements = part.takeoff_measurements
  }
  return out
}
