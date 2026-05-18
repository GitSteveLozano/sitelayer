# ADR 0005 — Defer customer-support impersonation until post-pilot

**Status:** accepted
**Date:** 2026-05-18
**Supersedes:** —
**Superseded by:** —

## Context

Customer support needs a way to reproduce customer-reported bugs. The two common patterns are:

1. **Impersonation:** support staff log in as the customer's company (typically read-only) and see exactly what the customer sees.
2. **Engineering-mediated repro:** support escalates to engineering, which queries production data, replays the request, or reconstructs the issue from logs.

Sitelayer has neither a customer-facing support team nor a customer-volume that warrants a separate auth path. The pilot is one customer (L&A Operations was the planned pilot; current state is zero paying customers per ADR 0003). Support volume is effectively zero.

The dev role-switcher (`apps/web/src/components/dev/RoleSwitcher.tsx`) exists for local QA, not for production support. It is structurally gated against prod by two independent checks:

- **SPA side:** `App.tsx` only mounts `<RoleSwitcher />` when `import.meta.env.MODE !== 'production'` AND `isClerkConfigured() === false`. Both branches are dead-code-eliminated in the production Vite build.
- **API side:** `apps/api/src/auth.ts:resolveActAsOverride` reads the `x-sitelayer-act-as` header only when `appConfig.tier !== 'prod'`. In `prod` the header is logged and discarded.

Either guard alone blocks the bypass; both must independently regress for the dev path to activate in prod. Unit-test coverage on both sides (`apps/api/src/auth.test.ts`, `apps/web/src/components/dev/RoleSwitcher.test.tsx`).

## Decision

**No read-only "act as company X" view for customer support exists in MVP.** Reproduction requests go through engineering: query production data via Mesh + DB read access, reconstruct from `audit_events` / Sentry traces, or replay the request with a known fixture.

Concretely:

1. No `/api/admin/impersonate/:companyId` route.
2. No support-tier role in `company_memberships`.
3. No Clerk organization tied to "Sitelayer Support" with cross-tenant read.
4. The dev role-switcher stays as-is — dev/preview only, prod-impossible by construction.

## Why now (vs. building a proper impersonation path)

Pilot support volume doesn't justify the complexity. A real impersonation path requires:

- A separate Clerk organization for support staff with explicit cross-tenant grants.
- A Clerk Backend API check (`CLERK_SECRET_KEY` — currently reserved but unused) verifying the acting user has the support role.
- An `audit_events` row for every impersonation session with start/end timestamps and acting-user attribution.
- A read-only enforcement layer that intercepts every PATCH / POST / DELETE at the route level, not just hides UI buttons.
- A visible UI banner in the impersonated session so support staff can't forget which company they're viewing.

The cost is at least a one-week build plus ongoing audit-log review. The benefit at current volume is zero: engineering can reproduce any pilot-era bug from logs + DB queries faster than the build itself would take.

## Trigger to revisit

Build a real impersonation path when **either** is true:

- Pilot support volume exceeds **5 reproduction requests per week** sustained for 2+ weeks.
- A customer-facing incident occurs that engineering cannot reproduce from `audit_events`, Sentry traces, and DB queries alone, AND the incident materially blocks customer operations.

## Recommendation when triggered

- **Route:** `POST /api/admin/impersonate/:companyId` issues a short-lived (15-minute) session token scoped to the target company.
- **Auth gate:** Clerk Backend API role check using `CLERK_SECRET_KEY`. Acting user must have the `sitelayer:support` role in the Sitelayer Support Clerk organization. No header-based bypass.
- **Audit:** every impersonation start writes an `audit_events` row `kind='support_impersonation_start'` with acting user, target company, justification text, and Sentry trace id. End writes `support_impersonation_end`.
- **Capability:** the impersonation token is **read-only**. Every non-GET route checks the token's `impersonated=true` claim and returns 403. No write capability, no QBO push, no notification send.
- **UI:** persistent red banner across the top of every screen: "Viewing {company.name} as support. No writes allowed." Banner is rendered server-side via session metadata, not a client toggle.
- **Session boundary:** auto-expire at 15 minutes. Explicit logout writes the end-event row. No refresh.

## Consequences

Positive:

- Zero attack surface for a cross-tenant read path during pilot.
- The dev role-switcher's gates remain the **only** identity-override mechanism in the codebase, which simplifies the security-review story.
- Engineering-mediated repro forces structured log/audit hygiene, which is independently valuable.

Negative:

- Support staff (when hired) cannot self-serve repro until the trigger fires and the build lands.
- Engineering on-call carries reproduction burden during pilot. At current volume this is sustainable; the trigger is the metric that says otherwise.

## References

- `apps/web/src/components/dev/RoleSwitcher.tsx` — dev-only switcher (gated by `MODE !== 'production'` + `!isClerkConfigured()`).
- `apps/api/src/auth.ts:resolveActAsOverride` — API-side gate (`tier !== 'prod'`).
- `apps/api/src/auth.test.ts`, `apps/web/src/components/dev/RoleSwitcher.test.tsx` — coverage for the gates.
- `CLAUDE.md` → "Local/preview role testing" — operator-facing description of the dev path.
