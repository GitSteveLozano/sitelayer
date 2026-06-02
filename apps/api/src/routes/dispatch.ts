import type http from 'node:http'
import type { Pool } from 'pg'
import type { AppTier } from '@sitelayer/config'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { PermissionAction } from '@sitelayer/domain'
import type { Identity } from '../auth.js'
import type { BlueprintStorage } from '../storage.js'
import type { LedgerExecutor } from '../mutation-tx.js'

import { handleAnalyticsRoutes } from './analytics.js'
import { handleAuditEscrowRoutes } from './audit-escrow.js'
import { handleAuditEventRoutes } from './audit-events.js'
import { handleDispatchLaneRoutes } from './dispatch-lanes.js'
import { handleBonusRuleRoutes } from './bonus-rules.js'
import { handleBlueprintRoutes } from './blueprints.js'
import { handleClockRoutes } from './clock.js'
import { handleCustomerRoutes } from './customers.js'
import { handleDailyLogRoutes } from './daily-logs.js'
import { handleLaborBurdenRoutes } from './labor-burden.js'
import { handleEstimateRoutes } from './estimate.js'
import { handleEstimatePushRoutes } from './estimate-pushes.js'
import { handleLaborEntryRoutes } from './labor-entries.js'
import { handleMaterialBillRoutes } from './material-bills.js'
import { handleNotificationPreferenceRoutes } from './notification-preferences.js'
import { handleNotificationRoutes } from './notifications.js'
import { handlePricingProfileRoutes } from './pricing-profiles.js'
import { handlePricingOverrideRoutes } from './pricing-overrides.js'
import { handleProjectAssignmentRoutes } from './project-assignments.js'
import { handleProjectRoutes } from './projects.js'
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
import { handleCompanyCamRoutes } from './companycam.js'
import { handleRentalEventRoutes } from './rental-events.js'
import { handleRentalRequestRoutes } from './rental-requests.js'
import { handleRentalRoutes } from './rentals.js'
import { handleScheduleRoutes } from './schedules.js'
import { handleCrewScheduleEventRoutes } from './crew-schedule-events.js'
import { handleServiceItemRoutes } from './service-items.js'
import { handleCaptureSessionRoutes } from './capture-sessions.js'
import { handleSupportPacketRoutes } from './support-packets.js'
import { handleWorkRequestRoutes } from './work-requests.js'
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
import { handleTakeoffWriteRoutes } from './takeoff-write.js'
import { handleTimeReviewRunRoutes } from './time-review-runs.js'
import { handleWorkerIssueRoutes } from './worker-issues.js'
import { handleProjectBriefRoutes } from './project-briefs.js'
import { handleWorkerRoutes } from './workers.js'
import { handlePaymentReminderRoutes } from './payment-reminders.js'
import { handleSystemRoutes, handleDebugTraceRoute } from './system.js'
import { handleAdminRoutes } from './admin.js'
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

/**
 * Walks the registered route cascade. Each handler is a thunk that
 * closes over the per-request context and returns true once it has
 * handled the URL+method pair. Order is significant — earlier entries
 * win when paths overlap. Adding a new route is one entry on the array.
 *
 * Returns true if a handler responded; false to let the caller emit 404.
 */
export async function dispatch(ctx: DispatchContext): Promise<boolean> {
  const { req, res, url, pool, company, identity, sendJson, requireRole, readBody, checkVersion, sendRedirect } = ctx
  const currentUserId = ctx.getCurrentUserId()

  // Handlers take `readonly string[]`; DispatchContext narrows to
  // `readonly CompanyRole[]`. Hoist the cast once.
  const requireRoleStr = (allowed: readonly string[]) => requireRole(allowed as readonly CompanyRole[])

  const routes: Array<() => Promise<boolean>> = [
    // Cross-tenant platform-admin API (/api/admin/*) — gated by requirePlatformAdmin
    // on the raw (pre-act-as) identity. Placed first; its namespace is distinct.
    () =>
      handleAdminRoutes(req, url, {
        pool,
        identity,
        sendJson,
        readBody,
        tier: ctx.tier,
        runScenarioApply: makeScenarioApplyRunner(pool, seedCompanyDefaults),
      }),

    // Custom-role management API (admin-gated CRUD for custom_roles +
    // custom_role_grants; GET surfaces the read-only built-in matrix). The
    // editable half of the RBAC-A overhaul — see permission-seam.ts for the
    // LAYER 1/LAYER 2 enforcement that consumes these rows. Namespace
    // (/api/companies/:id/roles, /memberships/:id/role) is distinct.
    () =>
      handleCompanyRoleRoutes(req, url, {
        pool,
        userId: currentUserId,
        sendJson,
        readBody,
      }),

    // System / session-scoped GETs (bootstrap, spec, session, projects list, divisions).
    () =>
      handleSystemRoutes(req, url, {
        pool,
        company,
        currentUserId,
        actorUserId: identity.actorUserId ?? null,
        authMode: identity.mode ?? 'self',
        sendJson,
        setHeader: ctx.setHeader,
        send304: ctx.send304,
      }),

    // Customer routes
    () =>
      handleCustomerRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
        backfillCustomerMapping: ctx.backfillCustomerMapping,
      }),

    // Worker routes
    () =>
      handleWorkerRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),

    // Payment-reminder bulk send (owner-money)
    () =>
      handlePaymentReminderRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Pricing-profile routes
    () =>
      handlePricingProfileRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),

    // Per-project / per-customer pricing override routes
    () =>
      handlePricingOverrideRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
      }),

    // Bonus-rule routes
    () =>
      handleBonusRuleRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),

    // Audit events (admin-only GET /api/audit-events)
    () =>
      handleAuditEventRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),

    // Dispatch lanes (admin-only GET / POST /api/admin/dispatch-lanes)
    // Wedge 5 kill-switch primitive — see migration 094 and
    // apps/worker/src/dispatch-lanes.ts for the runtime gate.
    () =>
      handleDispatchLaneRoutes(req, url, {
        pool,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        getCurrentUserId: ctx.getCurrentUserId,
      }),

    // Audit Escrow verification (admin-only GET /api/audit/escrow/...)
    // Wedge 2 of the proving-ground plan — see migration 095 and
    // packages/queue/src/audit-escrow.ts for the primitive.
    () =>
      handleAuditEscrowRoutes(req, url, {
        pool,
        requireRole: requireRoleStr,
        sendJson,
      }),

    // Worker issues — wk-issue ping (any role POSTs; admin/foreman/office GET)
    () =>
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

    // Foreman morning brief — fm-brief upsert + read.
    () =>
      handleProjectBriefRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Capture sessions — correlation spine for product trace, feedback, and artifacts.
    () =>
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
        readBody,
        sendJson,
        sendFileContent: ctx.sendFileContent,
        sendFileRedirect: ctx.sendFileRedirect,
      }),

    // Support / debug packets — bounded redacted client timeline + audit/queue join.
    () =>
      handleSupportPacketRoutes(req, url, {
        pool,
        company,
        identity,
        tier: ctx.tier,
        buildSha: getBuildSha(),
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Obstruction signals — first-class queryable view over work items
    // that are stuck (review_stale / proposal_expired / wont_do / dispatch
    // outbox dead). Mounted BEFORE handleWorkRequestRoutes so the
    // /api/work-requests/obstructions GET wins against the
    // /api/work-requests/:id detail matcher (which would otherwise treat
    // 'obstructions' as a work-item id and return 400).
    () =>
      handleObstructionsRoutes(req, url, {
        pool,
        company,
        identity,
        requireRole,
        sendJson,
      }),

    // Work Requests — context-aware support/task handoff timeline.
    () =>
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
        requireRole,
        readBody,
        sendJson,
      }),

    // QBO mapping CRUD
    () =>
      handleQboMappingRoutes(req, url, {
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
        listMappings: ctx.listIntegrationMappings,
        upsertMapping: ctx.upsertIntegrationMapping,
      }),

    // Sync queue inspection + manual drain
    () =>
      handleSyncRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // QBO auth + connection + sync
    () =>
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

    // Service-item mutations (code-keyed) and list
    () =>
      handleServiceItemRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        checkVersion,
      }),

    // Project mutations (POST/PATCH/closeout/summary)
    () =>
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

    // Per-project foreman/worker assignments.
    () =>
      handleProjectAssignmentRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        getCurrentUserId: ctx.getCurrentUserId,
      }),

    // Material-bill CRUD
    () =>
      handleMaterialBillRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
        checkVersion,
      }),

    // Takeoff drafts (multi-draft per project)
    () =>
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

    // Takeoff measurement read + LWW-gated PATCH/DELETE
    () =>
      handleTakeoffMeasurementRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
        assertBlueprintDocumentsBelongToProject: ctx.assertBlueprintDocumentsBelongToProject,
      }),

    // Multi-condition takeoff tags (Phase 3A) — 1:N scope tags per polygon
    () =>
      handleTakeoffTagRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Blueprint pages + per-page calibration (Phase 3B/C)
    () =>
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

    // Plan-revision diffs (H3) — serve stored blueprint_page_diffs +
    // affected_measurement_ids so the takeoff surface can render the
    // "N measurements affected" badge. Read-only; diff population is a
    // follow-up slice.
    () =>
      handleBlueprintDiffRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),

    // Takeoff CSV import (Phase 3G)
    () =>
      handleTakeoffImportRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Assemblies (Phase 3F)
    () =>
      handleAssemblyRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // QBO custom field mappings (Phase 3H — sqft on QBO entities)
    () =>
      handleQboCustomFieldRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Inventory utilization rollup (Phase 4 — must precede the catalog
    // CRUD handler so the more-specific path matches first).
    () =>
      handleInventoryUtilizationRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),

    // AI Layer — bid accuracy cohort stats (Phase 5).
    () =>
      handleBidAccuracyRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),

    // AI Layer — insights CRUD + agent triggers (Phase 5).
    () =>
      handleAiInsightRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // AI Layer — operator-context chat staging (consumer of the
    // browser-bridge operator-context handshake; see
    // digital-ontology/operator-context-handshake-design.md).
    () =>
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

    // Rental inventory + billing workflow
    () =>
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

    // Branches, cross-hire, scaffold catalog + BOM bridge
    () =>
      handleScaffoldOpsRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // QR scaffold tags + inspections
    () =>
      handleScaffoldTagRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Damage / loss / late-return billing
    () =>
      handleDamageChargeRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Shipments: estimate-to-fulfillment workflow
    () =>
      handleShipmentRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Payroll exports: XLSX / Xero / Payworks
    () =>
      handlePayrollExportRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        res: ctx.res,
      }),

    // Customer portal links
    () =>
      handleCustomerPortalRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // CompanyCam one-way photo mirror
    () =>
      handleCompanyCamRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Rental workflow event-API surface (GET /:id snapshot, POST /:id/events).
    // Wired before handleRentalRoutes so the canonical workflow paths
    // short-circuit the generic CRUD routes; the legacy POST /return and
    // POST /transfer routes remain handled by handleRentalRoutes for
    // back-compat with the rental-return-sheet and rental-transfer-sheet
    // SPA flows.
    () =>
      handleRentalEventRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Avontus-style rentals
    () =>
      handleRentalRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),

    // Operator-side approval queue for portal rental_requests submissions
    // (see routes/portal-rentals.ts for the public create path).
    () =>
      handleRentalRequestRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Crew schedules
    () =>
      handleScheduleRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
      }),

    // Crew schedule workflow snapshot + events (GET /:id, POST /:id/events,
    // PATCH /:id) — mirrors rental-billing-state and time-review-runs.
    () =>
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

    // Labor entries
    () =>
      handleLaborEntryRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        assertDivisionAllowedForServiceItem: ctx.assertDivisionAllowedForServiceItem,
      }),

    // Clock in/out + timeline
    () =>
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

    // Daily logs (Sitemap.html § fm-log) — incl. photo upload + fetch
    () =>
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

    // Labor burden rollup (fm-today-v2 dark card)
    () =>
      handleLaborBurdenRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),

    // Time review runs (Sitemap.html § t-approve) — workflow snapshot + events
    () =>
      handleTimeReviewRunRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        requirePermission: ctx.requirePermission,
        readBody,
        sendJson,
      }),

    // Project lifecycle workflow (single 7-state machine: draft → … → archived)
    () =>
      handleProjectLifecycleRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Change orders (v2) — list/create + per-CO workflow snapshot + events
    () =>
      handleChangeOrderRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Guardrails (v2) — per-project monitors + company-wide active + snooze/mute/clear
    () =>
      handleGuardrailRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Inventory service tickets — maintenance lifecycle (open → in_service → done)
    () =>
      handleInventoryServiceTicketRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Project billing milestones (v2) — deposit/progress/final schedule with manual paid status
    () =>
      handleProjectBillingMilestoneRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Project lost reasons (v2) — get + upsert the categorised lost-bid capture
    () =>
      handleProjectLostReasonRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Cross-role comms (v2) — project chat threads + owner broadcasts
    () =>
      handleMessagingRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Labor payroll runs (QBO TimeActivity export) — workflow snapshot + events
    () =>
      handleLaborPayrollRunRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Authenticated estimate share-link routes (POST /api/projects/:id/estimate/share, list, revoke)
    () =>
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

    // Inventory demand forecast — GET /api/inventory-items/:id/forecast
    () =>
      handleInventoryForecastRoutes(req, url, {
        company,
        sendJson,
      }),

    // Web Push subscription registration (read VAPID key, upsert/delete subs)
    () =>
      handlePushSubscriptionRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.trim() || null,
      }),

    // Per-user notification channel preferences
    () =>
      handleNotificationPreferenceRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Per-user notification feed (list unread + mark read). Used by wk-today's
    // "Foreman replied" banner to drain the worker's queue of Loop 2
    // resolution messages. Scoped via WHERE recipient_clerk_user_id = currentUserId.
    () =>
      handleNotificationRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Takeoff measurement writes (POST single + replace set)
    () =>
      handleTakeoffWriteRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Estimate flow (recompute, scope-vs-bid, PDF, forecast hours, divisions xref)
    () =>
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

    // Estimate-push workflow snapshots/events
    () =>
      handleEstimatePushRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
      }),

    // Workflow event-log tail — read-only GET for the SiteLayer Probe
    // (ADR-0019). Operator-tier read access, company-scoped.
    () =>
      handleWorkflowEventLogRoutes(req, url, {
        pool,
        company,
        requireRole: requireRoleStr,
        sendJson,
      }),

    // Analytics dashboards
    () =>
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

    // Blueprint document CRUD + streaming upload + presigned download
    () =>
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

    // Debug trace lookup (Bearer DEBUG_TRACE_TOKEN, prod-gated)
    () =>
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
  ]

  for (const route of routes) {
    if (await route()) return true
  }

  return false
}
