/**
 * Types for the `/api/bootstrap` and `/api/session` endpoints — the
 * one-shot payload the mobile shell loads on cold start. Screens
 * import the row types directly when they need to narrow a piece of
 * the bootstrap response without re-shaping it.
 *
 * Server contract lives in `apps/api/src/routes/system.ts`.
 */

export type ProjectAssignmentRow = {
  id: string
  project_id: string
  role: 'foreman' | 'worker'
  assigned_by_clerk_user_id: string | null
  created_at: string
}

export type ProjectRow = {
  id: string
  customer_id: string | null
  name: string
  customer_name: string
  division_code: string
  status: string
  bid_total: string
  labor_rate: string
  target_sqft_per_hr: string | null
  bonus_pool: string
  closed_at: string | null
  summary_locked_at: string | null
  site_lat?: string | null
  site_lng?: string | null
  site_radius_m?: number | null
  // project_lifecycle workflow state — the single pipeline source for all
  // state-dependent rendering (header/gates/hero/stepper). The legacy
  // `status` column above is a free-text classification label for analytics,
  // NOT a state machine. Surfaced from the list + bootstrap queries
  // (apps/api/src/projects-query.ts + routes/system.ts) so list/header
  // chrome can render per-state without a second fetch. Optional so a
  // legacy/narrowed payload that predates the column still type-checks.
  lifecycle_state?: string
  lifecycle_state_version?: number
  lifecycle_sent_at?: string | null
  lifecycle_accepted_at?: string | null
  lifecycle_declined_at?: string | null
  lifecycle_decline_reason?: string | null
  lifecycle_started_at?: string | null
  lifecycle_completed_at?: string | null
  lifecycle_archived_at?: string | null
  version: number
  created_at: string
  updated_at: string
}

export type WorkerRow = {
  id: string
  name: string
  role: string
  version: number
  deleted_at: string | null
  created_at: string
}

export type LaborRow = {
  id: string
  project_id: string
  worker_id: string | null
  service_item_code: string
  hours: string
  sqft_done: string
  status: string
  occurred_on: string
  version: number
  deleted_at: string | null
  created_at: string
}

export type MaterialBillRow = {
  id: string
  project_id: string
  vendor: string
  amount: string
  bill_type: string
  description: string | null
  occurred_on: string | null
  version: number
  deleted_at: string | null
  created_at: string
}

export type PricingProfileRow = {
  id: string
  name: string
  is_default: boolean
  config: Record<string, unknown>
  version: number
  created_at: string
}

export type BonusRuleRow = {
  id: string
  name: string
  config: Record<string, unknown>
  is_active: boolean
  version: number
  created_at: string
}

export type IntegrationMappingRow = {
  id: string
  provider: string
  entity_type: string
  local_ref: string
  external_id: string
  label: string | null
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type BootstrapResponse = {
  company: { id: string; name: string; slug: string }
  template: { slug: string; name: string; description: string }
  workflowStages: string[]
  divisions: Array<{ code: string; name: string; sort_order: number }>
  serviceItems: Array<{
    code: string
    name: string
    category: string
    unit: string
    default_rate: string | null
    source: string
  }>
  customers: Array<{
    id: string
    name: string
    external_id: string | null
    source: string
    version: number
    deleted_at: string | null
  }>
  projects: Array<ProjectRow>
  workers: Array<WorkerRow>
  pricingProfiles: Array<PricingProfileRow>
  bonusRules: Array<BonusRuleRow>
  integrations: Array<{
    id: string
    provider: string
    provider_account_id: string | null
    sync_cursor: string | null
    status: string
  }>
  integrationMappings: Array<IntegrationMappingRow>
  laborEntries: Array<LaborRow>
  materialBills: Array<MaterialBillRow>
  schedules: Array<{
    id: string
    project_id: string
    scheduled_for: string
    crew: unknown[]
    status: string
    version: number
    deleted_at: string | null
    created_at?: string
  }>
  // Caller's own active project assignments. Drives the contextual
  // mobile shell — see apps/web/src/lib/active-context.ts.
  projectAssignments?: Array<ProjectAssignmentRow>
  // Per-company labor-payroll auto-post policy (migration 116). Drives the
  // "THIS WEEK PAYROLL · AUTO" sub-label on the owner Money tiles. `enabled`
  // is false for every company by default; weekday is ISO (1=Mon..7=Sun);
  // after is 'HH:MM' local. Optional so an older API build still type-checks.
  laborPayrollAutoPost?: {
    enabled: boolean
    weekday: number | null
    after: string | null
  }
}

export type SessionResponse = {
  user: { id: string; role: string }
  activeCompany: { id: string; name: string; slug: string }
  memberships: Array<{
    id: string
    company_id: string
    clerk_user_id: string
    role: string
    created_at: string
    slug: string
    name: string
    // Set once the member finishes their role-specific first-run priming
    // (migration 007). NULL = first-run not yet completed → the invite/first-run
    // flow should run. Optional so an older API build still type-checks.
    first_run_completed_at?: string | null
  }>
  // PLATFORM app_issue.* capabilities the caller effectively holds (superadmin ∪
  // platform_admin_grants over a verified Clerk session). Drives the internal
  // /issues board entry. Empty/absent for a non-platform-admin or non-Clerk
  // session; optional so an older API build still type-checks.
  app_issue_capabilities?: string[]
}

export type ProjectSummary = {
  project: ProjectRow
  metrics: {
    totalMeasurementQuantity: number
    estimateTotal: number
    laborCost: number
    materialCost: number
    subCost: number
    totalCost: number
    margin: { revenue: number; cost: number; profit: number; margin: number }
    bonus: { eligible: boolean; payoutPercent: number; payout: number }
  }
  measurements: Array<{ service_item_code: string; quantity: string; unit: string; notes: string | null }>
  estimateLines: Array<{ service_item_code: string; quantity: string; unit: string; rate: string; amount: string }>
  laborEntries: LaborRow[]
}
