/**
 * The capability catalog + default role→capability map for the two-domain
 * permission model (migration 009 `context_work_items.domain`).
 *
 * THE KEYSTONE. Every consumer route gates on a capability constant from this
 * catalog. There are exactly two NON-BLEEDING domains:
 *
 *  - app_issue.*    — PLATFORM scope. Problems with the sitelayer SOFTWARE;
 *                     internal, cross-tenant. These caps live ONLY on the
 *                     platform boundary (Clerk-JWT-verified superadmin ∪ the
 *                     opt-in platform_admin_grants rows). They are UNREACHABLE
 *                     via a company role, the dev `x-sitelayer-act-as` override,
 *                     or the header identity fallback — see admin-auth.ts.
 *  - field_request.* — COMPANY scope. The contractor operational
 *                     problems/requests on a real job; a per-company business
 *                     feature. These caps live ONLY on the company boundary
 *                     (the role defaults below ∪ the additive custom_role_grants
 *                     named-action grants on the membership).
 *
 * The two domains CANNOT bleed: a company role can NEVER acquire an app_issue.*
 * capability without a platform grant, and a platform grant carries no
 * field_request.* authority. `resolvePlatformCapabilities` only ever emits
 * app_issue.* caps; `defaultCompanyCapabilities` / `mergeCompanyCapabilities`
 * only ever emit field_request.* caps. apps/api/src/capability.ts dispatches a
 * `requireCapability` check to the correct boundary by the capability's domain
 * prefix.
 *
 * Why a checked-in catalog (not a table): like BUILTIN_ROLE_PERMISSIONS in
 * permissions.ts, the catalog + the default role map is the SYSTEM CONTRACT —
 * constant-time, immutable, no DB hit. Only the OPT-IN additions are stored
 * (custom_role_grants for field_request, platform_admin_grants for app_issue).
 */

import type { CompanyRole } from './roles.js'

// --- The capability catalog (the approved model — EXACT names) -------------

/** PLATFORM-scope capabilities (app-issues = problems with the software). */
export const APP_ISSUE_CAPABILITIES = [
  // open the capture dock + record
  'app_issue.capture',
  // see the /issues board + capture artifacts/replays/support-packets
  'app_issue.view',
  // route/resolve/dispatch app-issues
  'app_issue.triage',
] as const

/** COMPANY-scope capabilities (field-requests = contractor job problems). */
export const FIELD_REQUEST_CAPABILITIES = [
  'field_request.create',
  'field_request.view',
  'field_request.triage',
  'field_request.resolve',
] as const

export const CAPABILITIES = [...APP_ISSUE_CAPABILITIES, ...FIELD_REQUEST_CAPABILITIES] as const

export type AppIssueCapability = (typeof APP_ISSUE_CAPABILITIES)[number]
export type FieldRequestCapability = (typeof FIELD_REQUEST_CAPABILITIES)[number]
export type Capability = (typeof CAPABILITIES)[number]

/** The two non-bleeding capability domains; mirrors context_work_items.domain. */
export const CAPABILITY_DOMAINS = ['app_issue', 'field_request'] as const
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number]

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

export function isAppIssueCapability(value: unknown): value is AppIssueCapability {
  return typeof value === 'string' && (APP_ISSUE_CAPABILITIES as readonly string[]).includes(value)
}

export function isFieldRequestCapability(value: unknown): value is FieldRequestCapability {
  return typeof value === 'string' && (FIELD_REQUEST_CAPABILITIES as readonly string[]).includes(value)
}

/** The domain a capability belongs to — the prefix before the first dot. */
export function capabilityDomain(capability: Capability): CapabilityDomain {
  return capability.startsWith('app_issue.') ? 'app_issue' : 'field_request'
}

// --- Default company role → field_request.* capability map -----------------
//
// MUST preserve current behaviour: field-requests are a live company feature
// and nothing gates on these caps yet, so the defaults are the floor that keeps
// every role's existing reach unchanged once the consumers wire in.
//
//   field_request.create  -> ALL 5 company roles
//   field_request.view    -> ALL 5 (member sees own only — that scoping is the
//                            consumer's row filter, not a capability difference)
//   field_request.triage  -> admin / foreman / office / bookkeeper
//   field_request.resolve -> admin / foreman / office / bookkeeper
//
// `member` is the only role WITHOUT triage/resolve. The 'office' company role is
// retained here distinctly (it normalizes to 'admin' on read elsewhere, but the
// map is keyed on the raw 5-union so it is explicit and grep-able).

export const DEFAULT_COMPANY_CAPABILITIES: Record<CompanyRole, readonly FieldRequestCapability[]> = {
  admin: ['field_request.create', 'field_request.view', 'field_request.triage', 'field_request.resolve'],
  foreman: ['field_request.create', 'field_request.view', 'field_request.triage', 'field_request.resolve'],
  office: ['field_request.create', 'field_request.view', 'field_request.triage', 'field_request.resolve'],
  bookkeeper: ['field_request.create', 'field_request.view', 'field_request.triage', 'field_request.resolve'],
  // member: create + view only (no triage/resolve). View is scoped to own rows
  // by the consumer; the capability itself is granted.
  member: ['field_request.create', 'field_request.view'],
}

/**
 * The default COMPANY (field_request.*) capabilities for a role, as a Set. Pure;
 * no DB. This is the floor — `mergeCompanyCapabilities` layers the additive
 * custom_role_grants on top.
 */
export function defaultCompanyCapabilities(role: CompanyRole): Set<FieldRequestCapability> {
  return new Set(DEFAULT_COMPANY_CAPABILITIES[role] ?? DEFAULT_COMPANY_CAPABILITIES.member)
}

/**
 * Merge a role's default field_request.* caps with the company's additive
 * named-action grants (the EXISTING custom_role_grants rows, loaded per
 * membership). A grant whose action names a field_request.* capability widens
 * the set; any non-field_request grant (e.g. one of the 9 permission actions)
 * is IGNORED here — those flow through requirePermission, not requireCapability.
 *
 * This is additive only and can never reach across the domain boundary: the
 * filter to FIELD_REQUEST_CAPABILITIES guarantees a company grant can NEVER
 * mint an app_issue.* capability.
 */
export function mergeCompanyCapabilities(
  role: CompanyRole,
  grantedActions: readonly string[] = [],
): Set<FieldRequestCapability> {
  const caps = defaultCompanyCapabilities(role)
  for (const action of grantedActions) {
    if (isFieldRequestCapability(action)) caps.add(action)
  }
  return caps
}

/**
 * The PLATFORM (app_issue.*) capabilities for a request. A superadmin
 * implicitly holds ALL app_issue.* caps; otherwise the set is exactly the
 * opt-in platform_admin_grants rows (filtered to real app_issue.* names so a
 * stray/typo'd grant row is inert, never a third-domain leak).
 *
 * Pure; the caller resolves `isSuperadmin` (admin-auth.ts) and loads
 * `platformGrants` before calling. This NEVER emits a field_request.* cap.
 */
export function resolvePlatformCapabilities(
  isSuperadmin: boolean,
  platformGrants: readonly string[] = [],
): Set<AppIssueCapability> {
  if (isSuperadmin) return new Set(APP_ISSUE_CAPABILITIES)
  const caps = new Set<AppIssueCapability>()
  for (const grant of platformGrants) {
    if (isAppIssueCapability(grant)) caps.add(grant)
  }
  return caps
}
