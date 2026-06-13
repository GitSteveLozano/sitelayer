import type http from 'node:http'
import type { Pool } from 'pg'
import type { AppTier } from '@sitelayer/config'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Capability, PermissionAction } from '@sitelayer/domain'
import type { Identity } from '../auth.js'
import type { BlueprintStorage } from '../storage.js'
import type { LedgerExecutor } from '../mutation-tx.js'

import type { IntegrationMappingRow } from './qbo.js'
import { handleAdminRoutes } from './admin.js'
import { handleAdminJobsRoutes } from './admin-jobs.js'
import { handlePlatformGrantRoutes } from './platform-grants.js'
import { makeScenarioApplyRunner } from '../admin-scenarios.js'
import { seedCompanyDefaults } from '../onboarding.js'

/**
 * Cross-cutting deps the route cascade needs from server.ts. Constructed
 * once per request, after auth + company resolution + rate-limiting have
 * succeeded. Keep this shape narrow so dispatch.ts doesn't grow into
 * server.ts again — every value here is supplied from server.ts and the
 * matching helper there owns its semantics.
 */
export type DispatchContext = {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  pool: Pool
  company: ActiveCompany
  identity: Identity
  tier: AppTier
  requestId: string

  // Cross-cutting helpers — all mirror the shapes used in routes/* today.
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  /**
   * LAYER 2 named-action overlay (the 9 PERMISSION_ACTIONS). Resolves the
   * caller's effective permissions from their built-in base + custom-role
   * grants. Returns true when the action is held (and, for a constrainable
   * action with a magnitude supplied via opts, within cap); on false it has
   * already sent the 403 and the handler should return true to stop the
   * cascade. Not yet called by any route — see server.ts:requirePermission.
   */
  requirePermission: (action: PermissionAction, opts?: { amountCents?: number; otHours?: number }) => boolean
  /**
   * Capability overlay for the two non-bleeding work-item domains (migration
   * 009 `context_work_items.domain`): field_request.* gates on the company
   * boundary (role defaults ∪ custom_role_grants), app_issue.* gates on the
   * platform boundary (superadmin ∪ platform_admin_grants). Returns true when
   * the capability is held; on false it has already sent the 403 and the
   * handler should return true to stop the cascade. Async because the
   * app_issue.* path may consult the DB (superadmin / platform_admin_grants).
   * Not yet called by any route — wired here next to requireRole /
   * requirePermission so the consumers can gate. See apps/api/src/capability.ts.
   */
  requireCapability: (capability: Capability) => Promise<boolean>
  /**
   * Resolve the caller's EFFECTIVE app_issue.* (platform) capabilities — for
   * surfacing on /api/session so the SPA can decide whether to render the
   * /issues board entry. Empty for a non-Clerk session. See
   * apps/api/src/capability.ts:resolveAppIssueCapabilities.
   */
  resolveAppIssueCapabilities: () => Promise<string[]>
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  sendRedirect: (location: string) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
  getCurrentUserId: () => string

  // Per-handler helpers that need access to server.ts module state
  // (storage, qbo config, response shaping for binary/PDF/redirect routes).
  storage: BlueprintStorage
  maxBlueprintUploadBytes: number
  blueprintDownloadPresigned: boolean
  qboConfig: {
    clientId: string
    clientSecret: string
    redirectUri: string
    successRedirectUri: string
    stateSecret: string
    baseUrl: string
    environment?: 'sandbox' | 'production'
  }
  estimateShareConfig: {
    secret: string
    portalBaseUrl: string
  }

  // Bridges back into server.ts helpers that own ledger / mapping writes.
  backfillCustomerMapping: (
    companyId: string,
    customer: { id: string; external_id: string | null; name: string },
    executor: LedgerExecutor,
  ) => Promise<unknown>
  listIntegrationMappings: (
    companyId: string,
    provider: string,
    entityType: string | null,
    pagination?: { limit: number; offset: number },
  ) => Promise<IntegrationMappingRow[]>
  upsertIntegrationMapping: (
    companyId: string,
    provider: string,
    values: {
      entity_type: string
      local_ref: string
      external_id: string
      label?: string | null
      status?: string | null
      notes?: string | null
    },
    executor: LedgerExecutor,
  ) => Promise<IntegrationMappingRow>
  assertBlueprintDocumentsBelongToProject: (
    companyId: string,
    projectId: string,
    blueprintDocumentIds: Array<string | null>,
  ) => Promise<void>
  assertDivisionAllowedForServiceItem: (
    companyId: string,
    serviceItemCode: string,
    divisionCode: string | null,
  ) => Promise<boolean>

  // Response-shaping callbacks for routes that emit non-JSON bodies. Defined
  // in server.ts so dispatch.ts doesn't re-derive CORS headers.
  sendPdf: (contentDisposition: string, input: unknown) => Promise<void>
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
  sendFileRedirect: (location: string) => void

  // Per-response side-channels for handlers that need to set headers
  // (cache-control, etag, www-authenticate). Header shape matches what
  // server.ts used inline.
  setHeader: (name: string, value: string) => void
  send304: (etag: string) => void
}

export type PlatformAdminDispatchContext = Pick<
  DispatchContext,
  'req' | 'url' | 'pool' | 'identity' | 'tier' | 'sendJson' | 'readBody'
>

/**
 * Per-request values the registered route descriptors receive. The raw
 * DispatchContext rides along as `ctx` for the less-common deps; the
 * fields hoisted here are the ones nearly every route consumes, plus the
 * two derived values (`currentUserId`, `requireRoleStr`) that dispatch()
 * computes once per request.
 */
export type DispatchRouteRuntime = {
  ctx: DispatchContext
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  pool: Pool
  company: ActiveCompany
  identity: Identity
  currentUserId: string
  requireRole: DispatchContext['requireRole']
  /** requireRole hoisted to the `readonly string[]` shape handlers take. */
  requireRoleStr: (allowed: readonly string[]) => boolean
  readBody: DispatchContext['readBody']
  sendJson: DispatchContext['sendJson']
  sendRedirect: DispatchContext['sendRedirect']
  checkVersion: DispatchContext['checkVersion']
}

/**
 * A registered dispatch route. ORDERING IS DATA, NOT ARRAY POSITION:
 * the dispatch table is assembled by sorting registered descriptors on
 * the explicit numeric `order` field — LOWER order runs EARLIER in the
 * cascade and therefore WINS when paths overlap. Order values are spaced
 * by 10 (10, 20, 30, …) so a future route can slot between two existing
 * ones (e.g. 15) without renumbering the world.
 *
 * The registration order/identity is locked by the conformance test in
 * dispatch.test.ts — a mis-ordered registration fails that gate loudly.
 */
export type DispatchRouteDescriptor = {
  /** Unique route name — the routes/<name>.ts module base name. */
  name: string
  /** Lower order = earlier in the cascade = wins on overlapping paths. */
  order: number
  handle: (rt: DispatchRouteRuntime) => Promise<boolean>
}

/** Platform-admin variant: tenantless, runs before company resolution. */
export type PlatformAdminRouteDescriptor = {
  name: string
  /** Lower order = earlier in the cascade = wins on overlapping paths. */
  order: number
  handle: (ctx: PlatformAdminDispatchContext) => Promise<boolean>
}

/**
 * Assemble a dispatch table from registered descriptors: a stable sort on
 * the explicit `order` field (lower order = earlier = wins). Stable, so a
 * duplicate order falls back to registration position — but duplicates are
 * an ambiguous registration and are rejected by the conformance test;
 * always pick a unique slot.
 */
export function buildDispatchTable<T extends { order: number }>(descriptors: readonly T[]): readonly T[] {
  return [...descriptors].sort((a, b) => a.order - b.order)
}

const PLATFORM_ADMIN_ROUTE_REGISTRY: readonly PlatformAdminRouteDescriptor[] = [
  // Read-only platform-admin job-fleet + queue-health (/api/admin/jobs) —
  // powers the read-only /admin/jobs page. Gated IDENTICALLY to the other
  // /api/admin/* routes (authorizePlatformAdmin on the raw identity). MUST be
  // ordered BEFORE handleAdminRoutes: that handler claims the whole /api/admin/*
  // namespace and 404s unknown subpaths, so /api/admin/jobs must reach here
  // first. Reads the GLOBAL public.job_runs + cross-tenant queue summaries
  // with the plain pool (no app.company_id GUC).
  {
    name: 'admin-jobs',
    order: 10,
    handle: ({ req, url, pool, identity, sendJson }) =>
      handleAdminJobsRoutes(req, url, {
        pool,
        identity,
        sendJson,
      }),
  },

  // Opt-in platform-admin capability grants (/api/admin/platform-grants) —
  // the app_issue.* escape hatch (migration 009 platform_admin_grants).
  // Gated IDENTICALLY to the other /api/admin/* routes (authorizePlatformAdmin
  // on the raw identity). MUST be ordered BEFORE handleAdminRoutes: that handler
  // claims the whole /api/admin/* namespace and 404s unknown subpaths, so
  // /api/admin/platform-grants must reach here first. The ONLY write path into
  // platform_admin_grants; only ever accepts app_issue.* names.
  {
    name: 'platform-grants',
    order: 20,
    handle: ({ req, url, pool, identity, sendJson, readBody }) =>
      handlePlatformGrantRoutes(req, url, {
        pool,
        identity,
        sendJson,
        readBody,
      }),
  },

  // Cross-tenant platform-admin API (/api/admin/*) — gated by requirePlatformAdmin
  // on the raw (pre-act-as) identity.
  {
    name: 'admin',
    order: 30,
    handle: ({ req, url, pool, identity, sendJson, readBody, tier }) =>
      handleAdminRoutes(req, url, {
        pool,
        identity,
        sendJson,
        readBody,
        tier,
        runScenarioApply: makeScenarioApplyRunner(pool, seedCompanyDefaults),
      }),
  },
]

/**
 * The assembled (order-sorted) platform-admin cascade. Exported for the
 * route-table-identity conformance test in dispatch.test.ts.
 */
export const PLATFORM_ADMIN_ROUTE_TABLE: readonly PlatformAdminRouteDescriptor[] =
  buildDispatchTable(PLATFORM_ADMIN_ROUTE_REGISTRY)

/**
 * Platform-admin routes are intentionally tenantless. Server calls this before
 * getCompany() so a stale active-company slug cannot block /api/admin/*.
 */
export async function dispatchPlatformAdminRoutes(ctx: PlatformAdminDispatchContext): Promise<boolean> {
  for (const route of PLATFORM_ADMIN_ROUTE_TABLE) {
    if (await route.handle(ctx)) return true
  }
  return false
}

// Per-module dispatch descriptors (Campaign E): each route module owns its
// own { name, order, handle } descriptor; the registry below is just the
// assembly point. Adding a route = a new descriptor in its module + one
// import line here. Order/identity stays locked by dispatch.test.ts.
import { companyRolesRouteDescriptor } from './company-roles.js'
import { systemRouteDescriptor, debugTraceRouteDescriptor } from './system.js'
import { opsDiagnosticsRouteDescriptor } from './ops-diagnostics.js'
import { agentToolsRouteDescriptor } from './agent-tools.js'
import { customersRouteDescriptor } from './customers.js'
import { workersRouteDescriptor } from './workers.js'
import { paymentRemindersRouteDescriptor } from './payment-reminders.js'
import { pricingProfilesRouteDescriptor } from './pricing-profiles.js'
import { pricingOverridesRouteDescriptor } from './pricing-overrides.js'
import { bonusRulesRouteDescriptor } from './bonus-rules.js'
import { auditEventsRouteDescriptor } from './audit-events.js'
import { companyExportRouteDescriptor } from './company-export.js'
import { dispatchLanesRouteDescriptor } from './dispatch-lanes.js'
import { auditEscrowRouteDescriptor } from './audit-escrow.js'
import { workerIssuesRouteDescriptor } from './worker-issues.js'
import { projectBriefsRouteDescriptor } from './project-briefs.js'
import { captureSessionsRouteDescriptor } from './capture-sessions.js'
import { supportPacketsRouteDescriptor } from './support-packets.js'
import { obstructionsRouteDescriptor } from './obstructions.js'
import { workRequestsRouteDescriptor } from './work-requests.js'
import { issuesRouteDescriptor } from './issues.js'
import { qboMappingsRouteDescriptor } from './qbo-mappings.js'
import { syncRouteDescriptor } from './sync.js'
import { qboRouteDescriptor } from './qbo.js'
import { serviceItemsRouteDescriptor } from './service-items.js'
import { costLibraryRouteDescriptor } from './cost-library.js'
import { voiceIntentRouteDescriptor } from './voice-intent.js'
import { projectsRouteDescriptor } from './projects.js'
import { projectAssignmentsRouteDescriptor } from './project-assignments.js'
import { materialBillsRouteDescriptor } from './material-bills.js'
import { takeoffDraftsRouteDescriptor } from './takeoff-drafts.js'
import { takeoffMeasurementsRouteDescriptor } from './takeoff-measurements.js'
import { takeoffTagsRouteDescriptor } from './takeoff-tags.js'
import { conditionsRouteDescriptor } from './conditions.js'
import { blueprintPagesRouteDescriptor } from './blueprint-pages.js'
import { blueprintDiffsRouteDescriptor } from './blueprint-diffs.js'
import { takeoffImportRouteDescriptor } from './takeoff-import.js'
import { assembliesRouteDescriptor } from './assemblies.js'
import { qboCustomFieldsRouteDescriptor } from './qbo-custom-fields.js'
import { inventoryUtilizationRouteDescriptor } from './inventory-utilization.js'
import { bidAccuracyRouteDescriptor } from './bid-accuracy.js'
import { aiInsightsRouteDescriptor } from './ai-insights.js'
import { aiChatRouteDescriptor } from './ai-chat.js'
import { rentalInventoryRouteDescriptor } from './rental-inventory.js'
import { scaffoldOpsRouteDescriptor } from './scaffold-ops.js'
import { scaffoldTagsRouteDescriptor } from './scaffold-tags.js'
import { damageChargesRouteDescriptor } from './damage-charges.js'
import { shipmentsRouteDescriptor } from './shipments.js'
import { payrollExportsRouteDescriptor } from './payroll-exports.js'
import { customerPortalLinksRouteDescriptor } from './customer-portal-links.js'
import { rentalSharesAdminRouteDescriptor } from './rental-shares-admin.js'
import { companycamRouteDescriptor } from './companycam.js'
import { rentalEventsRouteDescriptor } from './rental-events.js'
import { rentalsRouteDescriptor } from './rentals.js'
import { rentalRequestsRouteDescriptor } from './rental-requests.js'
import { schedulesRouteDescriptor } from './schedules.js'
import { crewScheduleEventsRouteDescriptor } from './crew-schedule-events.js'
import { laborEntriesRouteDescriptor } from './labor-entries.js'
import { clockRouteDescriptor } from './clock.js'
import { dailyLogsRouteDescriptor } from './daily-logs.js'
import { laborBurdenRouteDescriptor } from './labor-burden.js'
import { timeReviewRunsRouteDescriptor } from './time-review-runs.js'
import { projectLifecycleRouteDescriptor } from './project-lifecycle.js'
import { changeOrdersRouteDescriptor } from './change-orders.js'
import { guardrailsRouteDescriptor } from './guardrails.js'
import { inventoryServiceTicketsRouteDescriptor } from './inventory-service-tickets.js'
import { projectBillingMilestonesRouteDescriptor } from './project-billing-milestones.js'
import { projectLostReasonsRouteDescriptor } from './project-lost-reasons.js'
import { messagingRouteDescriptor } from './messaging.js'
import { laborPayrollRunsRouteDescriptor } from './labor-payroll-runs.js'
import { estimateSharesAdminRouteDescriptor } from './estimate-shares-admin.js'
import { inventoryForecastRouteDescriptor } from './inventory-forecast.js'
import { pushSubscriptionsRouteDescriptor } from './push-subscriptions.js'
import { notificationPreferencesRouteDescriptor } from './notification-preferences.js'
import { notificationsRouteDescriptor } from './notifications.js'
import { takeoffWriteRouteDescriptor } from './takeoff-write.js'
import { estimateRouteDescriptor } from './estimate.js'
import { estimatePushesRouteDescriptor } from './estimate-pushes.js'
import { budgetRouteDescriptor } from './budget.js'
import { workflowEventLogRouteDescriptor } from './workflow-event-log.js'
import { analyticsRouteDescriptor } from './analytics.js'
import { blueprintsRouteDescriptor } from './blueprints.js'
import { anchorsRouteDescriptor } from './anchors.js'

/**
 * The route registry. Every dispatchable route is a descriptor here with an
 * explicit `order` — see DispatchRouteDescriptor for the ordering contract
 * (lower order = earlier = wins; values spaced by 10 so inserts don't
 * renumber the world). The descriptors currently all live in this file;
 * per-module `{ match, handle, order }` exports can adopt this registry
 * later without changing the assembler or the conformance gate.
 */
const DISPATCH_ROUTE_REGISTRY: readonly DispatchRouteDescriptor[] = [
  {
    name: 'platform-admin',
    order: 10,
    handle: ({ req, url, pool, identity, ctx, sendJson, readBody }) =>
      dispatchPlatformAdminRoutes({ req, url, pool, identity, tier: ctx.tier, sendJson, readBody }),
  },
  companyRolesRouteDescriptor,
  systemRouteDescriptor,
  opsDiagnosticsRouteDescriptor,
  agentToolsRouteDescriptor,
  customersRouteDescriptor,
  workersRouteDescriptor,
  paymentRemindersRouteDescriptor,
  pricingProfilesRouteDescriptor,
  pricingOverridesRouteDescriptor,
  bonusRulesRouteDescriptor,
  auditEventsRouteDescriptor,
  companyExportRouteDescriptor,
  dispatchLanesRouteDescriptor,
  auditEscrowRouteDescriptor,
  workerIssuesRouteDescriptor,
  projectBriefsRouteDescriptor,
  captureSessionsRouteDescriptor,
  supportPacketsRouteDescriptor,
  obstructionsRouteDescriptor,
  workRequestsRouteDescriptor,
  issuesRouteDescriptor,
  qboMappingsRouteDescriptor,
  syncRouteDescriptor,
  qboRouteDescriptor,
  serviceItemsRouteDescriptor,
  costLibraryRouteDescriptor,
  voiceIntentRouteDescriptor,
  projectsRouteDescriptor,
  projectAssignmentsRouteDescriptor,
  materialBillsRouteDescriptor,
  takeoffDraftsRouteDescriptor,
  takeoffMeasurementsRouteDescriptor,
  takeoffTagsRouteDescriptor,
  conditionsRouteDescriptor,
  blueprintPagesRouteDescriptor,
  blueprintDiffsRouteDescriptor,
  takeoffImportRouteDescriptor,
  assembliesRouteDescriptor,
  qboCustomFieldsRouteDescriptor,
  inventoryUtilizationRouteDescriptor,
  bidAccuracyRouteDescriptor,
  aiInsightsRouteDescriptor,
  aiChatRouteDescriptor,
  rentalInventoryRouteDescriptor,
  scaffoldOpsRouteDescriptor,
  scaffoldTagsRouteDescriptor,
  damageChargesRouteDescriptor,
  shipmentsRouteDescriptor,
  payrollExportsRouteDescriptor,
  customerPortalLinksRouteDescriptor,
  rentalSharesAdminRouteDescriptor,
  companycamRouteDescriptor,
  rentalEventsRouteDescriptor,
  rentalsRouteDescriptor,
  rentalRequestsRouteDescriptor,
  schedulesRouteDescriptor,
  crewScheduleEventsRouteDescriptor,
  laborEntriesRouteDescriptor,
  clockRouteDescriptor,
  dailyLogsRouteDescriptor,
  laborBurdenRouteDescriptor,
  timeReviewRunsRouteDescriptor,
  projectLifecycleRouteDescriptor,
  changeOrdersRouteDescriptor,
  guardrailsRouteDescriptor,
  inventoryServiceTicketsRouteDescriptor,
  projectBillingMilestonesRouteDescriptor,
  projectLostReasonsRouteDescriptor,
  messagingRouteDescriptor,
  laborPayrollRunsRouteDescriptor,
  estimateSharesAdminRouteDescriptor,
  inventoryForecastRouteDescriptor,
  pushSubscriptionsRouteDescriptor,
  notificationPreferencesRouteDescriptor,
  notificationsRouteDescriptor,
  takeoffWriteRouteDescriptor,
  estimateRouteDescriptor,
  estimatePushesRouteDescriptor,
  budgetRouteDescriptor,
  workflowEventLogRouteDescriptor,
  analyticsRouteDescriptor,
  blueprintsRouteDescriptor,
  debugTraceRouteDescriptor,
  anchorsRouteDescriptor,
]

/**
 * The assembled (order-sorted) dispatch table. Exported for the
 * route-table-identity conformance test in dispatch.test.ts, which locks
 * the resolution order — see §8 risk 1 of docs/PROJECT_DECOMPOSITION_PLAN.md.
 */
export const DISPATCH_ROUTE_TABLE: readonly DispatchRouteDescriptor[] = buildDispatchTable(DISPATCH_ROUTE_REGISTRY)

/**
 * Walks the assembled route table. Each descriptor's handle receives the
 * per-request runtime and returns true once it has handled the URL+method
 * pair. Order is significant — LOWER `order` runs earlier and wins when
 * paths overlap (ordering is data on the descriptor, not array position).
 * Adding a new route is one descriptor in DISPATCH_ROUTE_REGISTRY with an
 * order slotted between its neighbours.
 *
 * Returns true if a handler responded; false to let the caller emit 404.
 */
export async function dispatch(ctx: DispatchContext): Promise<boolean> {
  const { req, res, url, pool, company, identity, sendJson, requireRole, readBody, checkVersion, sendRedirect } = ctx
  const currentUserId = ctx.getCurrentUserId()

  // Handlers take `readonly string[]`; DispatchContext narrows to
  // `readonly CompanyRole[]`. Hoist the cast once.
  const requireRoleStr = (allowed: readonly string[]) => requireRole(allowed as readonly CompanyRole[])

  const rt: DispatchRouteRuntime = {
    ctx,
    req,
    res,
    url,
    pool,
    company,
    identity,
    currentUserId,
    requireRole,
    requireRoleStr,
    readBody,
    sendJson,
    sendRedirect,
    checkVersion,
  }

  for (const route of DISPATCH_ROUTE_TABLE) {
    if (await route.handle(rt)) return true
  }

  return false
}
