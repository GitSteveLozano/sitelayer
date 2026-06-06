/**
 * The `requireCapability` resolver — the route-side enforcement of the
 * two-domain capability model (packages/domain/src/capabilities.ts, migration
 * 009 `context_work_items.domain`).
 *
 * This is the keystone the consumer routes gate on. It dispatches a capability
 * check to the correct trust boundary BY THE CAPABILITY'S DOMAIN PREFIX, so the
 * two domains can never bleed:
 *
 *  - field_request.*  → the COMPANY boundary. Resolved from the caller's role
 *    default caps (`defaultCompanyCapabilities`) widened by the company's
 *    additive named-action grants (the EXISTING custom_role_grants, surfaced as
 *    `grantActions`). A company role can NEVER reach an app_issue.* cap here —
 *    `mergeCompanyCapabilities` only ever emits field_request.* caps.
 *
 *  - app_issue.*  → the PLATFORM boundary. Resolved from
 *    `resolvePlatformCapabilities(isSuperadmin, platform_admin_grants)`.
 *    Superadmin status comes from admin-auth.ts `isSuperadmin`, which requires a
 *    REAL verified Clerk JWT (Identity.source === 'clerk') — unreachable via the
 *    company role, the dev `x-sitelayer-act-as` override, or the header
 *    identity fallback. A non-Clerk identity short-circuits to denied without a
 *    DB hit, and the opt-in platform_admin_grants rows are loaded only for an
 *    app_issue.* check (field_request routes never pay for the lookup).
 *
 * Split into a pure `companyCapabilityGranted` (sync, no I/O) and an async
 * `resolveCapability` (which may consult the DB for the platform path) so the
 * field_request decision is unit-testable without a client, and so server.ts
 * only owns the HTTP wiring (403 on denied).
 */

import {
  APP_ISSUE_CAPABILITIES,
  capabilityDomain,
  mergeCompanyCapabilities,
  resolvePlatformCapabilities,
  type AppIssueCapability,
  type Capability,
} from '@sitelayer/domain'
import { isSuperadmin, type AdminQueryExecutor } from './admin-auth.js'
import type { CompanyRole } from './auth-types.js'
import type { Identity } from './auth.js'

/** A capability verdict. `denied` carries the boundary that rejected it. */
export type CapabilityVerdict =
  | { outcome: 'allowed' }
  | { outcome: 'denied'; domain: 'app_issue' | 'field_request'; reason: string }

/**
 * Pure company-boundary check for a field_request.* capability. The caller's
 * effective company caps = role defaults ∪ the field_request.* slice of the
 * company's additive named-action grants.
 */
export function companyCapabilityGranted(
  role: CompanyRole,
  grantActions: readonly string[],
  capability: Capability,
): boolean {
  const caps = mergeCompanyCapabilities(role, grantActions)
  return (caps as Set<string>).has(capability)
}

/** Load a person's opt-in platform_admin_grants capability rows (Clerk subject). */
export async function loadPlatformGrants(client: AdminQueryExecutor, sub: string): Promise<string[]> {
  if (!sub) return []
  const result = (await client.query('select capability from platform_admin_grants where clerk_user_id = $1', [
    sub,
  ])) as { rows?: Array<{ capability?: unknown }> }
  return (result.rows ?? [])
    .map((row) => (typeof row.capability === 'string' ? row.capability : null))
    .filter((c): c is string => c !== null)
}

/** Inputs the resolver needs, threaded from the per-request route context. */
export type CapabilityContext = {
  /** EFFECTIVE company role (the long-tail role on ActiveCompany). */
  role: CompanyRole
  /** The company's additive named-action grants (custom_role_grants actions). */
  grantActions: readonly string[]
  /** The RAW (pre-act-as) request identity, for the platform check. */
  identity: Identity
  /** A pg client for the platform-grant lookups (app_issue.* only). */
  client: AdminQueryExecutor
  /** The PLATFORM_SUPERADMIN_CLERK_IDS allowlist (bootstrap superadmins). */
  superadminEnvIds: ReadonlySet<string>
  /**
   * The running tier (`appConfig.tier`). Used ONLY to relax the app_issue.*
   * platform boundary for LOCAL DEV: when the tier is not `prod`, the dev/local
   * identity (the RoleSwitcher act-as / header / default fallback) is treated as
   * platform-admin so a collaborator with no Clerk/superadmin can finalize and
   * read issues locally. In `prod` this is `'prod'` and the boundary is
   * UNCHANGED (Clerk + superadmin only). Mirrors the tier-gate in
   * `auth.ts:resolveActAsOverride`. Defaults to `'prod'` (fail-closed) when an
   * older caller doesn't thread it.
   */
  tier?: string
}

/**
 * Local-dev relaxation predicate: is this a non-prod tier where the dev/local
 * identity should be treated as platform-admin for app_issue.* caps? Mirrors
 * the `tier !== 'prod'` gate in `auth.ts:resolveActAsOverride`. Fail-closed: an
 * absent tier is treated as `'prod'` so the boundary stays Clerk-only.
 */
function isLocalDevPlatformBypass(tier: string | undefined): boolean {
  return (tier ?? 'prod') !== 'prod'
}

/**
 * The pure verdict behind `requireCapability`. Dispatches by domain:
 *  - field_request.* : sync company-boundary check.
 *  - app_issue.*     : platform-boundary check. Requires a verified Clerk
 *                      session first (non-Clerk → denied, no DB hit), then
 *                      superadmin ∪ platform_admin_grants.
 */
export async function resolveCapability(ctx: CapabilityContext, capability: Capability): Promise<CapabilityVerdict> {
  if (capabilityDomain(capability) === 'field_request') {
    if (companyCapabilityGranted(ctx.role, ctx.grantActions, capability)) return { outcome: 'allowed' }
    return { outcome: 'denied', domain: 'field_request', reason: 'company role lacks capability' }
  }

  // app_issue.* — platform boundary only. A non-Clerk identity (header /
  // default / internal / dev act-as) can never hold an app_issue cap IN PROD.
  // LOCAL DEV relaxation: when the tier is not `prod`, the dev/local identity
  // (RoleSwitcher act-as / header / default fallback) is treated as
  // platform-admin so a collaborator with no Clerk org / superadmin can
  // finalize + read issues end-to-end. In prod this branch is never taken
  // (tier === 'prod') and the boundary stays Clerk + superadmin only — the same
  // tier-gate `auth.ts:resolveActAsOverride` uses for the act-as override.
  if (ctx.identity.source !== 'clerk') {
    if (isLocalDevPlatformBypass(ctx.tier)) return { outcome: 'allowed' }
    return { outcome: 'denied', domain: 'app_issue', reason: 'platform capability requires a verified Clerk session' }
  }
  const superadmin = await isSuperadmin(ctx.client, ctx.identity.userId, ctx.superadminEnvIds)
  const platformGrants = superadmin ? [] : await loadPlatformGrants(ctx.client, ctx.identity.userId)
  const caps = resolvePlatformCapabilities(superadmin, platformGrants)
  if ((caps as Set<string>).has(capability)) return { outcome: 'allowed' }
  return { outcome: 'denied', domain: 'app_issue', reason: 'not a platform admin / no platform grant' }
}

/**
 * The caller's EFFECTIVE app_issue.* capabilities (the platform domain only).
 * For surfacing to the SPA (e.g. /api/session) so the client can decide whether
 * to render the /issues board entry. A non-Clerk identity short-circuits to an
 * empty set without a DB hit — the same boundary `resolveCapability` enforces,
 * so this can never over-report a guest/dev-act-as/header session. NEVER emits
 * a field_request.* cap.
 */
export async function resolveAppIssueCapabilities(ctx: CapabilityContext): Promise<AppIssueCapability[]> {
  if (ctx.identity.source !== 'clerk') {
    // LOCAL DEV relaxation (see resolveCapability): a non-prod tier surfaces ALL
    // app_issue.* caps to the dev/local identity so the SPA renders the /issues
    // board entry for a collaborator. In prod (tier === 'prod') this is never
    // taken and a non-Clerk session reports zero caps without a DB hit.
    if (isLocalDevPlatformBypass(ctx.tier)) return [...APP_ISSUE_CAPABILITIES]
    return []
  }
  const superadmin = await isSuperadmin(ctx.client, ctx.identity.userId, ctx.superadminEnvIds)
  const platformGrants = superadmin ? [] : await loadPlatformGrants(ctx.client, ctx.identity.userId)
  const caps = resolvePlatformCapabilities(superadmin, platformGrants)
  return APP_ISSUE_CAPABILITIES.filter((cap) => caps.has(cap))
}

/** Minimal `res`/`sendJson` shape the route helper needs to emit the 403. */
export type CapabilitySendJson = (status: number, body: unknown) => void

/**
 * Route-side enforcement: resolve `capability` against the correct boundary and,
 * on denial, send a 403 and return false (the handler should `return`). Returns
 * true to continue. Mirrors the requireRole/requirePermission helper contract.
 */
export async function requireCapability(
  ctx: CapabilityContext,
  capability: Capability,
  sendJson: CapabilitySendJson,
): Promise<boolean> {
  const verdict = await resolveCapability(ctx, capability)
  if (verdict.outcome === 'allowed') return true
  sendJson(403, { error: 'forbidden: capability not granted', capability, domain: verdict.domain })
  return false
}
