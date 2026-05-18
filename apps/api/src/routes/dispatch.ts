import type http from 'node:http'
import type { Pool } from 'pg'
import type { AppTier } from '@sitelayer/config'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Identity } from '../auth.js'
import type { BlueprintStorage } from '../storage.js'
import type { LedgerExecutor } from '../mutation-tx.js'

import { handleAnalyticsRoutes } from './analytics.js'
import { handleAuditEventRoutes } from './audit-events.js'
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
import { handleRentalRequestRoutes } from './rental-requests.js'
import { handleRentalRoutes } from './rentals.js'
import { handleScheduleRoutes } from './schedules.js'
import { handleCrewScheduleEventRoutes } from './crew-schedule-events.js'
import { handleServiceItemRoutes } from './service-items.js'
import { handleSupportPacketRoutes } from './support-packets.js'
import { handleSyncRoutes } from './sync.js'
import { handleAssemblyRoutes } from './assemblies.js'
import { handleBlueprintPageRoutes } from './blueprint-pages.js'
import { handleQboCustomFieldRoutes } from './qbo-custom-fields.js'
import { handleInventoryUtilizationRoutes } from './inventory-utilization.js'
import { handleBidAccuracyRoutes } from './bid-accuracy.js'
import { handleAiInsightRoutes } from './ai-insights.js'
import { handleTakeoffImportRoutes } from './takeoff-import.js'
import { handleTakeoffDraftRoutes } from './takeoff-drafts.js'
import { handleTakeoffMeasurementRoutes } from './takeoff-measurements.js'
import { handleTakeoffTagRoutes } from './takeoff-tags.js'
import { handleTakeoffWriteRoutes } from './takeoff-write.js'
import { handleTimeReviewRunRoutes } from './time-review-runs.js'
import { handleWorkerIssueRoutes } from './worker-issues.js'
import { handleProjectBriefRoutes } from './project-briefs.js'
import { handleWorkerRoutes } from './workers.js'
import { handleSystemRoutes, handleDebugTraceRoute } from './system.js'
import { handleProjectLifecycleRoutes } from './project-lifecycle.js'
import { handleLaborPayrollRunRoutes } from './labor-payroll-runs.js'
import { handleEstimateShareRoutes } from './estimate-shares-admin.js'
import { handleInventoryForecastRoutes } from './inventory-forecast.js'

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
  const { req, url, pool, company, identity, sendJson, requireRole, readBody, checkVersion, sendRedirect } = ctx
  const currentUserId = ctx.getCurrentUserId()

  // Handlers take `readonly string[]`; DispatchContext narrows to
  // `readonly CompanyRole[]`. Hoist the cast once.
  const requireRoleStr = (allowed: readonly string[]) => requireRole(allowed as readonly CompanyRole[])

  const routes: Array<() => Promise<boolean>> = [
    // System / session-scoped GETs (bootstrap, spec, session, projects list, divisions).
    () =>
      handleSystemRoutes(req, url, {
        pool,
        company,
        currentUserId,
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

    // Worker issues — wk-issue ping (any role POSTs; admin/foreman/office GET)
    () =>
      handleWorkerIssueRoutes(req, url, {
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
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

    // Support / debug packets — bounded redacted client timeline + audit/queue join.
    () =>
      handleSupportPacketRoutes(req, url, {
        pool,
        company,
        identity,
        tier: ctx.tier,
        buildSha: process.env.APP_BUILD_SHA ?? process.env.SENTRY_RELEASE ?? 'unknown',
        requireRole: requireRoleStr,
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
        currentUserId: identity.userId,
        requireRole: requireRoleStr,
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
        pool,
        company,
        currentUserId,
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        checkVersion,
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
        requireRole: requireRoleStr,
        readBody,
        sendJson,
        sendPdf: ctx.sendPdf,
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

    // Analytics dashboards
    () =>
      handleAnalyticsRoutes(req, url, {
        pool,
        company,
        currentUserId: identity.userId,
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
