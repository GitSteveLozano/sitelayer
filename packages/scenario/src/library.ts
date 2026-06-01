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
