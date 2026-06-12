import type http from 'node:http'
import type { Pool } from 'pg'
import type { AppTier } from '@sitelayer/config'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Capability, PermissionAction } from '@sitelayer/domain'
import type { Identity } from '../auth.js'
import type { BlueprintStorage } from '../storage.js'
import type { LedgerExecutor } from '../mutation-tx.js'

import { handleAnalyticsRoutes } from './analytics.js'
import { handleAuditEscrowRoutes } from './audit-escrow.js'
import { handleAuditEventRoutes } from './audit-events.js'
import { handleCompanyExportRoutes } from './company-export.js'
import { handleDispatchLaneRoutes } from './dispatch-lanes.js'
import { handleBonusRuleRoutes } from './bonus-rules.js'
import { handleBlueprintRoutes } from './blueprints.js'
import { handleClockRoutes } from './clock.js'
import { handleCustomerRoutes } from './customers.js'
import { handleDailyLogRoutes } from './daily-logs.js'
import { handleLaborBurdenRoutes } from './labor-burden.js'
import { handleEstimateRoutes } from './estimate.js'
import { handleEstimatePushRoutes } from './estimate-pushes.js'
import { handleBudgetRoutes } from './budget.js'
import { handleLaborEntryRoutes } from './labor-entries.js'
import { handleMaterialBillRoutes } from './material-bills.js'
import { handleNotificationPreferenceRoutes } from './notification-preferences.js'
import { handleNotificationRoutes } from './notifications.js'
import { handlePricingProfileRoutes } from './pricing-profiles.js'
import { handlePricingOverrideRoutes } from './pricing-overrides.js'
import { handleProjectAssignmentRoutes } from './project-assignments.js'
import { handleProjectRoutes } from './projects.js'
import { handleVoiceIntentRoutes } from './voice-intent.js'
import { handlePushSubscriptionRoutes } from './push-subscriptions.js'
import { handleQboMappingRoutes } from './qbo-mappings.js'
import { handleQboRoutes, type IntegrationMappingRow } from './qbo.js'
import { handleRentalInventoryRoutes } from './rental-inventory.js'
import { handleScaffoldOpsRoutes } from './scaffold-ops.js'
import { handleScaffoldTagRoutes } from './scaffold-tags.js'
import { handleDamageChargeRoutes } from './damage-charges.js'
import { handleShipmentRoutes } from './shipments.js'
import { handlePayrollExportRoutes } from './payroll-exports.js'
import { handleCustomerPortalRoutes } from './customer-portal-links.js'
import { handleRentalShareAdminRoutes } from './rental-shares-admin.js'
import { handleCompanyCamRoutes } from './companycam.js'
import { handleRentalEventRoutes } from './rental-events.js'
import { handleRentalRequestRoutes } from './rental-requests.js'
import { handleRentalRoutes } from './rentals.js'
import { handleScheduleRoutes } from './schedules.js'
import { handleCrewScheduleEventRoutes } from './crew-schedule-events.js'
import { handleServiceItemRoutes } from './service-items.js'
import { handleCostLibraryRoutes } from './cost-library.js'
import { handleCaptureSessionRoutes } from './capture-sessions.js'
import { handleOpsDiagnosticsRoutes } from './ops-diagnostics.js'
import { handleSupportPacketRoutes } from './support-packets.js'
import { handleWorkRequestRoutes } from './work-requests.js'
import { handleIssueRoutes } from './issues.js'
import { handleObstructionsRoutes } from './obstructions.js'
import { handleSyncRoutes } from './sync.js'
import { handleAssemblyRoutes } from './assemblies.js'
import { handleBlueprintPageRoutes } from './blueprint-pages.js'
import { handleBlueprintDiffRoutes } from './blueprint-diffs.js'
import { handleQboCustomFieldRoutes } from './qbo-custom-fields.js'
import { handleInventoryUtilizationRoutes } from './inventory-utilization.js'
import { handleBidAccuracyRoutes } from './bid-accuracy.js'
import { handleAiInsightRoutes } from './ai-insights.js'
import { handleAiChatRoutes } from './ai-chat.js'
import { handleTakeoffImportRoutes } from './takeoff-import.js'
import { handleTakeoffDraftRoutes } from './takeoff-drafts.js'
import { handleTakeoffMeasurementRoutes } from './takeoff-measurements.js'
import { handleTakeoffTagRoutes } from './takeoff-tags.js'
import { handleConditionRoutes } from './conditions.js'
import { handleTakeoffWriteRoutes } from './takeoff-write.js'
import { handleTimeReviewRunRoutes } from './time-review-runs.js'
import { handleWorkerIssueRoutes } from './worker-issues.js'
import { handleProjectBriefRoutes } from './project-briefs.js'
import { handleWorkerRoutes } from './workers.js'
import { handlePaymentReminderRoutes } from './payment-reminders.js'
import { handleSystemRoutes, handleDebugTraceRoute } from './system.js'
import { handleAdminRoutes } from './admin.js'
import { handleAdminJobsRoutes } from './admin-jobs.js'
import { handlePlatformGrantRoutes } from './platform-grants.js'
import { handleCompanyRoleRoutes } from './company-roles.js'
import { makeScenarioApplyRunner } from '../admin-scenarios.js'
import { seedCompanyDefaults } from '../onboarding.js'
import { handleProjectLifecycleRoutes } from './project-lifecycle.js'
import { handleChangeOrderRoutes } from './change-orders.js'
import { handleGuardrailRoutes } from './guardrails.js'
import { handleInventoryServiceTicketRoutes } from './inventory-service-tickets.js'
import { handleProjectBillingMilestoneRoutes } from './project-billing-milestones.js'
import { handleProjectLostReasonRoutes } from './project-lost-reasons.js'
import { handleMessagingRoutes } from './messaging.js'
import { handleLaborPayrollRunRoutes } from './labor-payroll-runs.js'
import { handleEstimateShareRoutes } from './estimate-shares-admin.js'
import { handleInventoryForecastRoutes } from './inventory-forecast.js'
import { handleWorkflowEventLogRoutes } from './workflow-event-log.js'
import { handleAnchorRoutes } from './anchors.js'
import { handleAgentToolsRoutes } from './agent-tools.js'
import { getBuildSha } from '../lib/build-sha.js'
import { rasterizePdfPageToPng } from '../blueprint-rasterize.js'

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

  // Custom-role management API (admin-gated CRUD for custom_roles +
  // custom_role_grants; GET surfaces the read-only built-in matrix). The
  // editable half of the RBAC-A overhaul — see permission-seam.ts for the
  // LAYER 1/LAYER 2 enforcement that consumes these rows. Namespace
  // (/api/companies/:id/roles, /memberships/:id/role) is distinct.
  {
    name: 'company-roles',
    order: 20,
    handle: ({ req, url, pool, currentUserId, sendJson, readBody }) =>
      handleCompanyRoleRoutes(req, url, {
        pool,
        userId: currentUserId,
        sendJson,
        readBody,
      }),
  },

  // System / session-scoped GETs (bootstrap, spec, session, projects list, divisions).
  {
    name: 'system',
    order: 30,
    handle: ({ req, url, pool, company, currentUserId, identity, ctx, sendJson }) =>
      handleSystemRoutes(req, url, {
        pool,
        company,
        currentUserId,
        actorUserId: identity.actorUserId ?? null,
        authMode: identity.mode ?? 'self',
        resolveAppIssueCapabilities: ctx.resolveAppIssueCapabilities,
        sendJson,
        setHeader: ctx.setHeader,
        send304: ctx.send304,
      }),
  },

  // Operator-only onsite diagnostics. Read-only aggregation over local
  // control-plane/capture primitives; gated on app_issue.view because it can
  // reveal platform health and desktop-capture posture.
  {
    name: 'ops-diagnostics',
    order: 40,
    handle: ({ req, url, ctx, sendJson, company, readBody, currentUserId }) =>
      handleOpsDiagnosticsRoutes(req, url, {
        requireCapability: ctx.requireCapability,
        sendJson,
        company,
        storage: ctx.storage,
        buildSha: getBuildSha(),
        readBody,
        getCurrentUserId: () => currentUserId,
      }),
  },

  // Agent-tools discovery — self-describing catalog of the deterministic
  // workflows as agent-callable tools (instrument-your-own-app surface).
  {
    name: 'agent-tools',
    order: 50,
    handle: ({ req, url, sendJson }) => handleAgentToolsRoutes(req, url, { sendJson }),
  },

  // Customer routes
  {
    name: 'customers',
    order: 60,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, checkVersion, ctx }) =>
      handleCustomerRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
        backfillCustomerMapping: ctx.backfillCustomerMapping,
      }),
  },

  // Worker routes
  {
    name: 'workers',
    order: 70,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, checkVersion }) =>
      handleWorkerRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Payment-reminder bulk send (owner-money)
  {
    name: 'payment-reminders',
    order: 80,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handlePaymentReminderRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Pricing-profile routes
  {
    name: 'pricing-profiles',
    order: 90,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, checkVersion }) =>
      handlePricingProfileRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Per-project / per-customer pricing override routes
  {
    name: 'pricing-overrides',
    order: 100,
    handle: ({ req, url, pool, company, requireRoleStr, ctx, readBody, sendJson }) =>
      handlePricingOverrideRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
      }),
  },

  // Bonus-rule routes
  {
    name: 'bonus-rules',
    order: 110,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, checkVersion }) =>
      handleBonusRuleRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Audit events (admin-only GET /api/audit-events)
  {
    name: 'audit-events',
    order: 120,
    handle: ({ req, url, pool, company, requireRoleStr, sendJson }) =>
      handleAuditEventRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // Per-tenant data export (admin-only GET /api/company/export) — portability /
  // offboarding bundle (JSON | CSV). Strictly company-scoped via the GUC +
  // explicit company_id predicate. See ./company-export.ts.
  {
    name: 'company-export',
    order: 130,
    handle: ({ req, url, pool, company, requireRoleStr, sendJson, ctx }) =>
      handleCompanyExportRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
        res: ctx.res,
      }),
  },

  // Dispatch lanes (admin-only GET / POST /api/admin/dispatch-lanes)
  // Wedge 5 kill-switch primitive — see migration 094 and
  // apps/worker/src/dispatch-lanes.ts for the runtime gate.
  {
    name: 'dispatch-lanes',
    order: 140,
    handle: ({ req, url, pool, requireRoleStr, readBody, sendJson, ctx }) =>
      handleDispatchLaneRoutes(req, url, {
        pool,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        getCurrentUserId: ctx.getCurrentUserId,
      }),
  },

  // Audit Escrow verification (admin-only GET /api/audit/escrow/...)
  // Wedge 2 of the proving-ground plan — see migration 095 and
  // packages/queue/src/audit-escrow.ts for the primitive.
  {
    name: 'audit-escrow',
    order: 150,
    handle: ({ req, url, pool, requireRoleStr, sendJson }) =>
      handleAuditEscrowRoutes(req, url, {
        pool,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // Worker issues — wk-issue ping (any role POSTs; admin/foreman/office GET)
  {
    name: 'worker-issues',
    order: 160,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, ctx, readBody, sendJson }) =>
      handleWorkerIssueRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        storage: ctx.storage,
        maxAttachmentBytes: Number(process.env.MAX_WORKER_ISSUE_ATTACHMENT_BYTES ?? 25 * 1024 * 1024),
        attachmentDownloadPresigned: ctx.blueprintDownloadPresigned,
        sendFileContent: ctx.sendFileContent,
        sendFileRedirect: ctx.sendFileRedirect,
      }),
  },

  // Foreman morning brief — fm-brief upsert + read.
  {
    name: 'project-briefs',
    order: 170,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleProjectBriefRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Capture sessions — correlation spine for product trace, feedback, and artifacts.
  {
    name: 'capture-sessions',
    order: 180,
    handle: ({ req, url, pool, company, identity, ctx, requireRole, readBody, sendJson }) =>
      handleCaptureSessionRoutes(req, url, {
        pool,
        company,
        identity,
        tier: ctx.tier,
        buildSha: getBuildSha(),
        storage: ctx.storage,
        maxArtifactBytes: Number(process.env.MAX_CAPTURE_ARTIFACT_BYTES ?? 50 * 1024 * 1024),
        artifactDownloadPresigned: ctx.blueprintDownloadPresigned,
        requireRole,
        // app_issue.capture gates finalize; app_issue.view gates the artifact
        // download — both on the platform boundary. See capture-sessions.ts.
        requireCapability: ctx.requireCapability,
        readBody,
        sendJson,
        sendFileContent: ctx.sendFileContent,
        sendFileRedirect: ctx.sendFileRedirect,
      }),
  },

  // Support / debug packets — bounded redacted client timeline + audit/queue join.
  {
    name: 'support-packets',
    order: 190,
    handle: ({ req, url, pool, company, identity, ctx, readBody, sendJson }) =>
      handleSupportPacketRoutes(req, url, {
        pool,
        company,
        identity,
        tier: ctx.tier,
        buildSha: getBuildSha(),
        // app_issue.view gates the read paths (get/list/access-log); the POST
        // producer path stays open. See support-packets.ts.
        requireCapability: ctx.requireCapability,
        readBody,
        sendJson,
      }),
  },

  // Obstruction signals — first-class queryable view over work items
  // that are stuck (review_stale / proposal_expired / wont_do / dispatch
  // outbox dead). Ordered BEFORE handleWorkRequestRoutes so the
  // /api/work-requests/obstructions GET wins against the
  // /api/work-requests/:id detail matcher (which would otherwise treat
  // 'obstructions' as a work-item id and return 400).
  {
    name: 'obstructions',
    order: 200,
    handle: ({ req, url, pool, company, identity, requireRole, sendJson }) =>
      handleObstructionsRoutes(req, url, {
        pool,
        company,
        identity,
        requireRole,
        sendJson,
      }),
  },

  // Work Requests — context-aware support/task handoff timeline.
  {
    name: 'work-requests',
    order: 210,
    handle: ({ req, url, pool, company, identity, currentUserId, ctx, readBody, sendJson }) =>
      handleWorkRequestRoutes(req, url, {
        pool,
        company,
        // Act-as-aware identity: created_by / actor attribution and the
        // member-scoped read filters inside the handler key off
        // identity.userId. Under the dev RoleSwitcher the raw identity is the
        // demo-user, so override userId with the impersonated user id while
        // preserving source/role. `currentUserId` resolves to the act-as
        // override only when tier !== 'prod', so prod attribution is unchanged.
        identity: { ...identity, userId: currentUserId },
        tier: ctx.tier,
        buildSha: getBuildSha(),
        // field_request.* capability gate (migration 009). Resolves on the
        // company boundary from resolvedCompany.active.role ∪ custom_role_grants
        // — the act-as override above only re-attributes actor/userId, not the
        // role the cap resolves against. See work-requests.ts + capability.ts.
        requireCapability: ctx.requireCapability,
        readBody,
        sendJson,
      }),
  },

  // Internal APP-ISSUE surface — read-only board/list/detail over the
  // `app_issue` half of context_work_items (migration 009 `domain`). Every
  // route gates on the PLATFORM capability `app_issue.view` (superadmin ∪
  // platform_admin_grants over the RAW identity), so the captured internal
  // data is unreachable via a company role / dev act-as / header fallback.
  // Distinct /api/issues/* namespace; does not overlap /api/work-requests/*.
  {
    name: 'issues',
    order: 220,
    handle: ({ req, url, pool, company, identity, ctx, readBody, sendJson }) =>
      handleIssueRoutes(req, url, {
        pool,
        company,
        identity,
        buildSha: getBuildSha(),
        requireCapability: ctx.requireCapability,
        readBody,
        sendJson,
      }),
  },

  // QBO mapping CRUD
  {
    name: 'qbo-mappings',
    order: 230,
    handle: ({ req, url, company, requireRoleStr, readBody, sendJson, checkVersion, ctx }) =>
      handleQboMappingRoutes(req, url, {
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
        listMappings: ctx.listIntegrationMappings,
        upsertMapping: ctx.upsertIntegrationMapping,
      }),
  },

  // Sync queue inspection + manual drain
  {
    name: 'sync',
    order: 240,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson }) =>
      handleSyncRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // QBO auth + connection + sync
  {
    name: 'qbo',
    order: 250,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, sendRedirect, ctx }) =>
      handleQboRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        sendRedirect,
        qboConfig: ctx.qboConfig,
      }),
  },

  // Service-item mutations (code-keyed) and list
  {
    name: 'service-items',
    order: 260,
    handle: ({ req, url, pool, company, requireRoleStr, ctx, readBody, sendJson, checkVersion }) =>
      handleServiceItemRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Shared cost library (Takeoff Deep Dive M5) — company + shared-catalog
  // list/search, single create, and CSV/.xlsx price-book import. Additive:
  // the pricing resolver consults this only as the lowest-priority fallback
  // (pricing.ts layer 6), so an empty library changes nothing.
  {
    name: 'cost-library',
    order: 270,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleCostLibraryRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Voice-driven project setup (v1) — voice PROPOSES proposed fields, the
  // human CONFIRMS via the regular POST /api/projects. Must precede the
  // project handler so the /api/projects/voice-intent* paths win over the
  // project handler's GET /^\/api\/projects\/[^/]+$/ matcher. Gated by
  // isAiChatEnabled() — no-ops clean (200 disabled) on a non-AI instance.
  {
    name: 'voice-intent',
    order: 280,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, ctx, readBody, sendJson }) =>
      handleVoiceIntentRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
      }),
  },

  // Project mutations (POST/PATCH/closeout/summary)
  {
    name: 'projects',
    order: 290,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, ctx, readBody, sendJson, checkVersion }) =>
      handleProjectRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Per-project foreman/worker assignments.
  {
    name: 'project-assignments',
    order: 300,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, ctx }) =>
      handleProjectAssignmentRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        getCurrentUserId: ctx.getCurrentUserId,
      }),
  },

  // Material-bill CRUD
  {
    name: 'material-bills',
    order: 310,
    handle: ({ req, url, pool, company, requireRoleStr, ctx, readBody, sendJson, checkVersion }) =>
      handleMaterialBillRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Takeoff drafts (multi-draft per project)
  {
    name: 'takeoff-drafts',
    order: 320,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, currentUserId, ctx }) =>
      handleTakeoffDraftRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        currentUserId,
        storage: ctx.storage,
        maxBlueprintUploadBytes: ctx.maxBlueprintUploadBytes,
      }),
  },

  // Takeoff measurement read + LWW-gated PATCH/DELETE
  {
    name: 'takeoff-measurements',
    order: 330,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, checkVersion, ctx }) =>
      handleTakeoffMeasurementRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
        assertBlueprintDocumentsBelongToProject: ctx.assertBlueprintDocumentsBelongToProject,
      }),
  },

  // Multi-condition takeoff tags (Phase 3A) — 1:N scope tags per polygon
  {
    name: 'takeoff-tags',
    order: 340,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleTakeoffTagRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Condition layer (Takeoff Deep Dive H1) — company-scoped reusable typed
  // templates. Additive: measurements may record condition_id, the tag flow
  // above remains the fallback.
  {
    name: 'conditions',
    order: 350,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleConditionRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Blueprint pages + per-page calibration (Phase 3B/C)
  {
    name: 'blueprint-pages',
    order: 360,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, ctx }) =>
      handleBlueprintPageRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        storage: ctx.storage,
        blueprintDownloadPresigned: ctx.blueprintDownloadPresigned,
        sendFileContent: ctx.sendFileContent,
        sendFileRedirect: ctx.sendFileRedirect,
      }),
  },

  // Plan-revision diffs (H3) — serve stored blueprint_page_diffs +
  // affected_measurement_ids so the takeoff surface can render the
  // "N measurements affected" badge. Read-only; diff population is a
  // follow-up slice.
  {
    name: 'blueprint-diffs',
    order: 370,
    handle: ({ req, url, pool, company, requireRoleStr, sendJson }) =>
      handleBlueprintDiffRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // Takeoff CSV import (Phase 3G)
  {
    name: 'takeoff-import',
    order: 380,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleTakeoffImportRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Assemblies (Phase 3F)
  {
    name: 'assemblies',
    order: 390,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleAssemblyRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // QBO custom field mappings (Phase 3H — sqft on QBO entities)
  {
    name: 'qbo-custom-fields',
    order: 400,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson }) =>
      handleQboCustomFieldRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Inventory utilization rollup (Phase 4 — must precede the catalog
  // CRUD handler so the more-specific path matches first).
  {
    name: 'inventory-utilization',
    order: 410,
    handle: ({ req, url, pool, company, requireRoleStr, sendJson }) =>
      handleInventoryUtilizationRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // AI Layer — bid accuracy cohort stats (Phase 5).
  {
    name: 'bid-accuracy',
    order: 420,
    handle: ({ req, url, pool, company, requireRoleStr, sendJson }) =>
      handleBidAccuracyRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // AI Layer — insights CRUD + agent triggers (Phase 5).
  {
    name: 'ai-insights',
    order: 430,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleAiInsightRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // AI Layer — operator-context chat staging (consumer of the
  // browser-bridge operator-context handshake; see
  // digital-ontology/operator-context-handshake-design.md).
  {
    name: 'ai-chat',
    order: 440,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, res }) =>
      handleAiChatRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        // Raw response handle for the SSE stream route. JSON endpoints
        // ignore this; the streaming endpoint refuses to start without
        // it (defense in depth — it can never legitimately be missing
        // through dispatch.ts).
        res,
      }),
  },

  // Rental inventory + billing workflow
  {
    name: 'rental-inventory',
    order: 450,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, checkVersion, ctx }) =>
      handleRentalInventoryRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
        storage: ctx.storage,
        maxMovementPhotoBytes: Number(process.env.MAX_MOVEMENT_PHOTO_BYTES ?? 25 * 1024 * 1024),
        movementPhotoDownloadPresigned: ctx.blueprintDownloadPresigned,
        sendFileContent: ctx.sendFileContent,
        sendFileRedirect: ctx.sendFileRedirect,
      }),
  },

  // Branches, cross-hire, scaffold catalog + BOM bridge
  {
    name: 'scaffold-ops',
    order: 460,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleScaffoldOpsRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // QR scaffold tags + inspections
  {
    name: 'scaffold-tags',
    order: 470,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleScaffoldTagRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Damage / loss / late-return billing
  {
    name: 'damage-charges',
    order: 480,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleDamageChargeRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Shipments: estimate-to-fulfillment workflow
  {
    name: 'shipments',
    order: 490,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleShipmentRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Payroll exports: XLSX / Xero / Payworks
  {
    name: 'payroll-exports',
    order: 500,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, ctx }) =>
      handlePayrollExportRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        res: ctx.res,
      }),
  },

  // Customer portal links
  {
    name: 'customer-portal-links',
    order: 510,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleCustomerPortalRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Rental share-link owner admin (revoke + access audit; LANE A)
  {
    name: 'rental-shares-admin',
    order: 520,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, sendJson }) =>
      handleRentalShareAdminRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // CompanyCam one-way photo mirror
  {
    name: 'companycam',
    order: 530,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleCompanyCamRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Rental workflow event-API surface (GET /:id snapshot, POST /:id/events).
  // Ordered before handleRentalRoutes so the canonical workflow paths
  // short-circuit the generic CRUD routes; the legacy POST /return and
  // POST /transfer routes remain handled by handleRentalRoutes for
  // back-compat with the rental-return-sheet and rental-transfer-sheet
  // SPA flows.
  {
    name: 'rental-events',
    order: 540,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleRentalEventRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Avontus-style rentals
  {
    name: 'rentals',
    order: 550,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, checkVersion }) =>
      handleRentalRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Operator-side approval queue for portal rental_requests submissions
  // (see routes/portal-rentals.ts for the public create path).
  {
    name: 'rental-requests',
    order: 560,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleRentalRequestRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Crew schedules
  {
    name: 'schedules',
    order: 570,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, checkVersion }) =>
      handleScheduleRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Crew schedule workflow snapshot + events (GET /:id, POST /:id/events,
  // PATCH /:id) — mirrors rental-billing-state and time-review-runs.
  {
    name: 'crew-schedule-events',
    order: 580,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, ctx, readBody, sendJson, checkVersion }) =>
      handleCrewScheduleEventRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        checkVersion,
      }),
  },

  // Labor entries
  {
    name: 'labor-entries',
    order: 590,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, ctx }) =>
      handleLaborEntryRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        assertDivisionAllowedForServiceItem: ctx.assertDivisionAllowedForServiceItem,
      }),
  },

  // Clock in/out + timeline
  {
    name: 'clock',
    order: 600,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, ctx, readBody, sendJson }) =>
      handleClockRoutes(req, url, {
        pool,
        company,
        // Act-as-aware (matches every other dispatch entry, e.g. daily-logs):
        // clock in/out must attribute to the impersonated user under the dev
        // RoleSwitcher, not the raw demo-user identity.
        currentUserId,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        storage: ctx.storage,
        // Reuse the blueprint upload cap until ops asks for a separate knob.
        maxPhotoBytes: ctx.maxBlueprintUploadBytes,
      }),
  },

  // Daily logs (Sitemap.html § fm-log) — incl. photo upload + fetch
  {
    name: 'daily-logs',
    order: 610,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, ctx, readBody, sendJson, checkVersion }) =>
      handleDailyLogRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        checkVersion,
        storage: ctx.storage,
        maxPhotoBytes: Number(process.env.MAX_DAILY_LOG_PHOTO_BYTES ?? 15 * 1024 * 1024),
        photoDownloadPresigned: ctx.blueprintDownloadPresigned,
        sendFileContent: ctx.sendFileContent,
        sendFileRedirect: ctx.sendFileRedirect,
      }),
  },

  // Labor burden rollup (fm-today-v2 dark card)
  {
    name: 'labor-burden',
    order: 620,
    handle: ({ req, url, pool, company, requireRoleStr, sendJson }) =>
      handleLaborBurdenRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // Time review runs (Sitemap.html § t-approve) — workflow snapshot + events
  {
    name: 'time-review-runs',
    order: 630,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, ctx, readBody, sendJson }) =>
      handleTimeReviewRunRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
      }),
  },

  // Project lifecycle workflow (single 7-state machine: draft → … → archived)
  {
    name: 'project-lifecycle',
    order: 640,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleProjectLifecycleRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Change orders (v2) — list/create + per-CO workflow snapshot + events
  {
    name: 'change-orders',
    order: 650,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleChangeOrderRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Guardrails (v2) — per-project monitors + company-wide active + snooze/mute/clear
  {
    name: 'guardrails',
    order: 660,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleGuardrailRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Inventory service tickets — maintenance lifecycle (open → in_service → done)
  {
    name: 'inventory-service-tickets',
    order: 670,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleInventoryServiceTicketRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Project billing milestones (v2) — deposit/progress/final schedule with manual paid status
  {
    name: 'project-billing-milestones',
    order: 680,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleProjectBillingMilestoneRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Project lost reasons (v2) — get + upsert the categorised lost-bid capture
  {
    name: 'project-lost-reasons',
    order: 690,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleProjectLostReasonRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Cross-role comms (v2) — project chat threads + owner broadcasts
  {
    name: 'messaging',
    order: 700,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleMessagingRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Labor payroll runs (QBO TimeActivity export) — workflow snapshot + events
  {
    name: 'labor-payroll-runs',
    order: 710,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleLaborPayrollRunRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Authenticated estimate share-link routes (POST /api/projects/:id/estimate/share, list, revoke)
  {
    name: 'estimate-shares-admin',
    order: 720,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, ctx }) =>
      handleEstimateShareRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        shareSecret: ctx.estimateShareConfig.secret,
        portalBaseUrl: ctx.estimateShareConfig.portalBaseUrl,
      }),
  },

  // Inventory demand forecast — GET /api/inventory-items/:id/forecast
  {
    name: 'inventory-forecast',
    order: 730,
    handle: ({ req, url, company, sendJson }) =>
      handleInventoryForecastRoutes(req, url, {
        company,
        sendJson,
      }),
  },

  // Web Push subscription registration (read VAPID key, upsert/delete subs)
  {
    name: 'push-subscriptions',
    order: 740,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handlePushSubscriptionRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.trim() || null,
      }),
  },

  // Per-user notification channel preferences
  {
    name: 'notification-preferences',
    order: 750,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleNotificationPreferenceRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Per-user notification feed (list unread + mark read). Used by wk-today's
  // "Foreman replied" banner to drain the worker's queue of Loop 2
  // resolution messages. Scoped via WHERE recipient_clerk_user_id = currentUserId.
  {
    name: 'notifications',
    order: 760,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleNotificationRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Takeoff measurement writes (POST single + replace set)
  {
    name: 'takeoff-write',
    order: 770,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleTakeoffWriteRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Estimate flow (recompute, scope-vs-bid, PDF, forecast hours, divisions xref)
  {
    name: 'estimate',
    order: 780,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, ctx }) =>
      handleEstimateRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        sendPdf: ctx.sendPdf,
        sendFileContent: ctx.sendFileContent,
      }),
  },

  // Estimate-push workflow snapshots/events
  {
    name: 'estimate-pushes',
    order: 790,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleEstimatePushRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Budget freeze + per-cost-code variance (Deep Dive §4 — bid/budget/actuals).
  // Explicit operator freeze of the live estimate_lines into an immutable
  // budget_snapshots row (change orders mint a new version), plus BUDGET vs
  // ACTUALS (material_bills + labor_entries) rolled by service_item_code.
  // estimate_lines stays the live bid. Ordered near the estimate family; its
  // /api/projects/:id/budget* paths don't overlap the project CRUD matchers.
  {
    name: 'budget',
    order: 800,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
      handleBudgetRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),
  },

  // Workflow event-log tail — read-only GET for the SiteLayer Probe
  // (ADR-0019). Operator-tier read access, company-scoped.
  {
    name: 'workflow-event-log',
    order: 810,
    handle: ({ req, url, pool, company, requireRoleStr, sendJson }) =>
      handleWorkflowEventLogRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // Analytics dashboards
  {
    name: 'analytics',
    order: 820,
    handle: ({ req, url, pool, company, currentUserId, requireRoleStr, sendJson }) =>
      handleAnalyticsRoutes(req, url, {
        pool,
        company,
        // Act-as-aware: the /divisions + /service-item-productivity role
        // lookups must read the impersonated user's membership under the dev
        // RoleSwitcher, not the raw identity (which would skip the gate).
        currentUserId,
        requireRole: requireRoleStr,
        sendJson,
      }),
  },

  // Blueprint document CRUD + streaming upload + presigned download
  {
    name: 'blueprints',
    order: 830,
    handle: ({ req, url, pool, company, requireRoleStr, readBody, sendJson, checkVersion, ctx }) =>
      handleBlueprintRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
        storage: ctx.storage,
        maxBlueprintUploadBytes: ctx.maxBlueprintUploadBytes,
        blueprintDownloadPresigned: ctx.blueprintDownloadPresigned,
        sendFileContent: ctx.sendFileContent,
        sendFileRedirect: ctx.sendFileRedirect,
        rasterizePdfPage: rasterizePdfPageToPng,
      }),
  },

  // Debug trace lookup (Bearer DEBUG_TRACE_TOKEN, prod-gated)
  {
    name: 'debug-trace',
    order: 840,
    handle: ({ req, url, pool, company, currentUserId, sendJson, ctx }) =>
      handleDebugTraceRoute({
        req,
        url,
        pool,
        company,
        currentUserId,
        sendJson,
        setHeader: ctx.setHeader,
        send304: ctx.send304,
        requestId: ctx.requestId,
        tier: ctx.tier,
      }),
  },

  // Statechart-anchor lookup — incident-tracking surface, same gate as
  // debug-trace (Bearer DEBUG_TRACE_TOKEN, prod-gated). Resolves a one-string
  // transition anchor (or a from/to pair) to its workflow_event_log row(s),
  // linked capture session + artifacts, sentry_trace, and deterministic replay.
  {
    name: 'anchors',
    order: 850,
    handle: ({ req, url, pool, company, ctx, sendJson }) =>
      handleAnchorRoutes({
        req,
        url,
        pool,
        company,
        tier: ctx.tier,
        requestId: ctx.requestId,
        sendJson,
        setHeader: ctx.setHeader,
      }),
  },
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
