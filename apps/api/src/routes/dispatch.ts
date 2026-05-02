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
import { handlePricingProfileRoutes } from './pricing-profiles.js'
import { handleProjectRoutes } from './projects.js'
import { handlePushSubscriptionRoutes } from './push-subscriptions.js'
import { handleQboMappingRoutes } from './qbo-mappings.js'
import { handleQboRoutes, type IntegrationMappingRow } from './qbo.js'
import { handleRentalInventoryRoutes } from './rental-inventory.js'
import { handleRentalRoutes } from './rentals.js'
import { handleScheduleRoutes } from './schedules.js'
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
import { handleTakeoffMeasurementRoutes } from './takeoff-measurements.js'
import { handleTakeoffTagRoutes } from './takeoff-tags.js'
import { handleTakeoffWriteRoutes } from './takeoff-write.js'
import { handleTimeReviewRunRoutes } from './time-review-runs.js'
import { handleWorkerIssueRoutes } from './worker-issues.js'
import { handleWorkerRoutes } from './workers.js'
import { handleSystemRoutes, handleDebugTraceRoute } from './system.js'

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
 * Walks the registered route cascade. Each handler receives the per-request
 * context it needs and returns true once it has handled the URL+method
 * pair. Order matches the previous inline cascade in server.ts so behaviour
 * is preserved.
 *
 * Returns true if a handler responded; false to let the caller emit 404.
 */
export async function dispatch(ctx: DispatchContext): Promise<boolean> {
  const { req, url, res, pool, company, identity, sendJson, requireRole, readBody, checkVersion, sendRedirect } = ctx

  // System / session-scoped GETs (bootstrap, spec, session, projects list,
  // divisions). These are read-only and were previously inline in server.ts.
  if (
    await handleSystemRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      sendJson,
      setHeader: ctx.setHeader,
      send304: ctx.send304,
    })
  ) {
    return true
  }

  // Customer routes
  if (
    await handleCustomerRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
      backfillCustomerMapping: ctx.backfillCustomerMapping,
    })
  ) {
    return true
  }

  // Worker routes
  if (
    await handleWorkerRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Pricing-profile routes
  if (
    await handlePricingProfileRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Bonus-rule routes
  if (
    await handleBonusRuleRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Audit events (admin-only GET /api/audit-events)
  if (
    await handleAuditEventRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      sendJson,
    })
  ) {
    return true
  }

  // Worker issues — wk-issue ping (any role POSTs; admin/foreman/office GET)
  if (
    await handleWorkerIssueRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Support / debug packets — bounded redacted client timeline + audit/queue
  // join.
  if (
    await handleSupportPacketRoutes(req, url, {
      pool,
      company,
      identity,
      tier: ctx.tier,
      buildSha: process.env.APP_BUILD_SHA ?? process.env.SENTRY_RELEASE ?? 'unknown',
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // QBO mapping CRUD
  if (
    await handleQboMappingRoutes(req, url, {
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
      listMappings: ctx.listIntegrationMappings,
      upsertMapping: ctx.upsertIntegrationMapping,
    })
  ) {
    return true
  }

  // Sync queue inspection + manual drain
  if (
    await handleSyncRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // QBO auth + connection + sync
  if (
    await handleQboRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      sendRedirect,
      qboConfig: ctx.qboConfig,
    })
  ) {
    return true
  }

  // Service-item mutations (code-keyed) and list
  if (
    await handleServiceItemRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Project mutations (POST/PATCH/closeout/summary)
  if (
    await handleProjectRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Material-bill CRUD
  if (
    await handleMaterialBillRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Takeoff measurement read + LWW-gated PATCH/DELETE
  if (
    await handleTakeoffMeasurementRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
      assertBlueprintDocumentsBelongToProject: ctx.assertBlueprintDocumentsBelongToProject,
    })
  ) {
    return true
  }

  // Multi-condition takeoff tags (Phase 3A) — 1:N scope tags per polygon
  if (
    await handleTakeoffTagRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Blueprint pages + per-page calibration (Phase 3B/C)
  if (
    await handleBlueprintPageRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Takeoff CSV import (Phase 3G)
  if (
    await handleTakeoffImportRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Assemblies (Phase 3F)
  if (
    await handleAssemblyRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // QBO custom field mappings (Phase 3H — sqft on QBO entities)
  if (
    await handleQboCustomFieldRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Inventory utilization rollup (Phase 4 — must precede the catalog
  // CRUD handler so the more-specific path matches first).
  if (
    await handleInventoryUtilizationRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      sendJson,
    })
  ) {
    return true
  }

  // AI Layer — bid accuracy cohort stats (Phase 5).
  if (
    await handleBidAccuracyRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      sendJson,
    })
  ) {
    return true
  }

  // AI Layer — insights CRUD + agent triggers (Phase 5).
  if (
    await handleAiInsightRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Rental inventory + billing workflow
  if (
    await handleRentalInventoryRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Avontus-style rentals
  if (
    await handleRentalRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Crew schedules
  if (
    await handleScheduleRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
    })
  ) {
    return true
  }

  // Labor entries
  if (
    await handleLaborEntryRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      assertDivisionAllowedForServiceItem: ctx.assertDivisionAllowedForServiceItem,
    })
  ) {
    return true
  }

  // Clock in/out + timeline
  if (
    await handleClockRoutes(req, url, {
      pool,
      company,
      currentUserId: identity.userId,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Daily logs (Sitemap.html § fm-log) — incl. photo upload + fetch
  if (
    await handleDailyLogRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
      storage: ctx.storage,
      maxPhotoBytes: Number(process.env.MAX_DAILY_LOG_PHOTO_BYTES ?? 15 * 1024 * 1024),
      photoDownloadPresigned: ctx.blueprintDownloadPresigned,
      sendFileContent: ctx.sendFileContent,
      sendFileRedirect: ctx.sendFileRedirect,
    })
  ) {
    return true
  }

  // Labor burden rollup (fm-today-v2 dark card)
  if (
    await handleLaborBurdenRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      sendJson,
    })
  ) {
    return true
  }

  // Time review runs (Sitemap.html § t-approve) — workflow snapshot + events
  if (
    await handleTimeReviewRunRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Web Push subscription registration (read VAPID key, upsert/delete subs)
  if (
    await handlePushSubscriptionRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.trim() || null,
    })
  ) {
    return true
  }

  // Per-user notification channel preferences
  if (
    await handleNotificationPreferenceRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Takeoff measurement writes (POST single + replace set)
  if (
    await handleTakeoffWriteRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Estimate flow (recompute, scope-vs-bid, PDF, forecast hours, divisions xref)
  if (
    await handleEstimateRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      sendPdf: ctx.sendPdf,
    })
  ) {
    return true
  }

  // Estimate-push workflow snapshots/events
  if (
    await handleEstimatePushRoutes(req, url, {
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
    })
  ) {
    return true
  }

  // Analytics dashboards
  if (
    await handleAnalyticsRoutes(req, url, {
      pool,
      company,
      currentUserId: identity.userId,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      sendJson,
    })
  ) {
    return true
  }

  // Blueprint document CRUD + streaming upload + presigned download
  if (
    await handleBlueprintRoutes(req, url, {
      pool,
      company,
      requireRole: (allowed) => requireRole(allowed as readonly CompanyRole[]),
      readBody,
      sendJson,
      checkVersion,
      storage: ctx.storage,
      maxBlueprintUploadBytes: ctx.maxBlueprintUploadBytes,
      blueprintDownloadPresigned: ctx.blueprintDownloadPresigned,
      sendFileContent: ctx.sendFileContent,
      sendFileRedirect: ctx.sendFileRedirect,
    })
  ) {
    return true
  }

  // Debug trace lookup (Bearer DEBUG_TRACE_TOKEN, prod-gated)
  if (
    await handleDebugTraceRoute({
      req,
      url,
      pool,
      company,
      currentUserId: ctx.getCurrentUserId(),
      sendJson,
      setHeader: ctx.setHeader,
      send304: ctx.send304,
      requestId: ctx.requestId,
      tier: ctx.tier,
    })
  ) {
    return true
  }

  // Suppress unused-import lints — `res` is part of the context for any
  // future handler that needs raw stream access; deliberately not used in
  // the cascade today.
  void res

  return false
}
