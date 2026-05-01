# ADR 0002 — Rebuild the web client as `apps/web-v2/`; keep the backend

**Status:** accepted
**Date:** 2026-05-01
**Supersedes:** —
**Superseded by:** —

## Context

Sitelayer ships a working MVP. The current web client (`apps/web/`) is a
desktop-first, form-and-table SPA built around the IA that grew with the
backend: Projects, Schedule, Inventory, Rentals, Bonus-sim, Estimate-pushes
listed flat as siblings. It works, L&A is using it, and the underlying
backend is production-quality.

Design has now committed to a different product shape, captured in the
handoff bundle (`Mobile.html`, `Sitemap.html`, `AI Layer.html`,
`index.html`) and two written briefs (`uploads/sitelayer_takeoff_design_brief.md`,
`uploads/sitelayer_scheduling_design_brief.md`). The headline changes:

- **Mobile-first PWA** with installable manifest, web push, geolocation,
  and camera capture. Desktop is "the same thing, wider, with a side
  rail." The majority of users — owner, foreman, worker — are on phones.
- **5-tab IA**: Home · Projects · Time · Rentals · More. 49 screens,
  9 sheets/modals, 5 system states. Settings demoted to a More row.
- **Three personas with different default Homes and Time-tab defaults.**
  Owner sees a calm dashboard; foreman sees crew status + WTD burden;
  worker sees auto clock-in confirmation and today's scope.
- **Geofenced auto clock-in** as the headline pattern, foreman-view time
  entry, time approval workflow, auto-generated daily logs, labor-burden
  rollup.
- **Multi-condition takeoff** (one polygon, N scope items), per-page
  scale calibration, multi-page nav, linear + count tools, Compare
  overlay, assemblies model, takeoff CSV import, takeoff → QBO with
  sqft preserved as a custom field.
- **Scan-driven rentals** dispatch / return + idle-revenue KPI.
- **AI Layer** as a separate locked visual language with three tiers
  (inline atom, stripe card, agent surface) and a strict anti-list:
  no chatbot, no AI tab, no numeric confidence, no auto-orders,
  no agent-only daily logs.

## Decision

**Keep the backend. Rebuild the web client as `apps/web-v2/` in
parallel with `apps/web/` until cutover.**

The backend (`apps/api`, `apps/worker`, `packages/{config,domain,
logger,queue,workflows}`, the 25 Postgres migrations, Clerk auth,
Sentry, Spaces storage, mutation outbox, tier guard, LWW, audit,
rate limit) is already the right shape for the new design. We add
narrow, additive endpoints and a few new migrations as the new web
features need them. Nothing is rewritten.

The web client is the gap. The IA, the visual language, the
mobile-first PWA shell, and the persona-aware Home are all
structural enough that an in-place refactor would not be faster
than a parallel build. L&A stays on `apps/web/` until the cutover
at the end of Phase 5.

## Why not in-place refactor of `apps/web/`

- Every screen's IA changes. Refactoring 20+ views to a 5-tab
  bottom-nav PWA shell touches every file regardless.
- Service worker, manifest, and Web Push registration are app-level
  changes that have to happen at the shell, not per-screen.
- The visual language is a hard reset (Geist + warm palette + AI
  primitives). Co-existing two design systems in one app for the
  duration of the rebuild is more painful than running two apps.
- L&A must keep using v1 throughout. An in-place refactor would
  force a feature-flag of every screen, doubling QA surface.

## Why not a full rewrite

The backend has earned the right to stay. The deterministic
workflow package, the outbox + idempotency contract, the tier guard,
the audit log, and the migration discipline are all hard-won and
match the new design's needs. Throwing them out would burn months
for zero user-visible value.

## Phasing

| Phase | Scope                                            | Weeks   | Parallel? |
|-------|--------------------------------------------------|---------|-----------|
| 0     | Tokens, AI primitives, PWA shell, ADR            | 1       | —         |
| 1     | Worker + Foreman field shells (geofence, daily   | 4–5     | with 3    |
|       | log, time approval, push, SMS)                   |         |           |
| 2     | Owner home + Projects/Estimate/Schedule rebuild  | 3–4     | —         |
| 3     | Takeoff overhaul (multi-condition, calibration,  | 4–5     | with 1    |
|       | multi-page, linear/count, Compare, assemblies,   |         |           |
|       | CSV import, QBO sqft bridge)                     |         |           |
| 4     | Rentals rebuild (scan dispatch + utilization)    | 2–3     | with 1/3  |
| 5     | AI Layer (bid accuracy, takeoff-to-bid agent,    | 3–4     | —         |
|       | inline atoms across screens)                     |         |           |
| 6     | Cutover (route 100% to v2; retire `apps/web/`)   | 1–2     | —         |

Phase 1 and Phase 3 are independent (different DB tables, different API
surfaces, no shared screens) and can run as two streams. Phase 4 is also
independent and can slot alongside. Phase 2 reads time-anomaly data
produced by Phase 1, so it sequences after.

## Tech defaults for `apps/web-v2/`

- Vite + `vite-plugin-pwa` (matches v1 bundler; offline-first fits)
- React 19, React Router 7, Clerk 5, Sentry 10 (pinned to v1 versions)
- TanStack Query for data fetching/caching (v1 hand-rolled it; v2's
  role-aware shells justify the upgrade)
- Tailwind 3.4 driven by CSS custom properties — design tokens are the
  source of truth, Tailwind reads them via `theme.extend.colors:
  'var(--m-…)'` so engineers can write `bg-paper text-ink border-line`
- Tokens and AI primitives stay local to `apps/web-v2/` until Phase 1
  or 3 needs to share them with `apps/web/`. No premature `packages/`
  promotion.

## What is explicitly **not** in Phase 0

- No feature work
- No API additions or migrations
- No service-worker background sync (Phase 1 if it earns its keep)
- No actual push payload handling (just the registration scaffold)
- No screen migrations from v1
- No AI inference

## AI / SDK choices (locked here for downstream phases)

- **Cohort statistics** (bid accuracy, time anomalies, estimate
  generation) run as SQL aggregations in the API. No LLM.
- **Agent surfaces** (takeoff-to-bid, bid follow-up, voice-to-log) call
  Claude via the Anthropic SDK with a thin abstraction at the call site
  for testability. No pre-emptive multi-provider abstraction.
- Confidence is **always ordinal** (none / low / medium / high), never
  numeric. Hard rule from the AI Layer doc.
- Every AI-sourced field carries a one-sentence source attribution.
- Dismiss is signal, not deletion — dismissals are recorded for the
  cohort model, not silently dropped.

## Notification channels

- Web Push (VAPID) for installed PWA
- Twilio SMS for non-PWA workers and assignment alerts
- Email (existing Resend/SendGrid path) for office-side delivery
- All three live behind a single `notification-channels` interface in
  the worker; per-user preference selects channel.

## Cutover criteria (end of Phase 5)

Before traffic is moved off `apps/web/`:

1. Every L&A workflow exercised in the last 30 days runs end-to-end on
   v2 in preview tier without manual intervention.
2. Offline mutation queue replays correctly on field PWA installs
   (geofence clock, daily log, photo capture).
3. Sentry + Pino traces propagate through the v2 SPA the same way they
   do in v1 (request_id, sentry_trace, sentry_baggage).
4. PWA install + Web Push permission flows succeed on iOS 18+ Safari
   and Chrome Android.
5. v2 bundle budget is at or below v1's.
6. Rollback path verified: reverse-proxy can route any subset of users
   back to `apps/web/` for one release window after cutover.

## Consequences

Positive:

- Backend continuity — no risk to QBO sync, mutation outbox,
  workflow reducers, tier guard.
- L&A is undisturbed during the rebuild.
- v2 is mobile-first and PWA-shaped from day one, not retrofitted.
- AI Layer can land with a locked visual language because its
  primitives ship in Phase 0.
- Two work-streams (Phase 1 || Phase 3) compress the calendar to
  ~13–16 weeks instead of ~17–22.

Negative:

- Two web codebases coexist for 12+ weeks. Discipline required to
  avoid drift between v1's bug-fix cadence and v2's build-out.
- New API endpoints during the build need to live alongside any v1
  callers — additive only, no breaking changes.
- The AI Layer primitives are built before the screens that use
  them. Some primitives may need revision once Phase 5 lands.

## Open follow-ons (not blockers)

- Native iOS app for the auto-clock-in geofence gap if PWA's iOS
  background-geolocation degradation is unacceptable in production.
  Discover, don't pre-build.
- Promotion of tokens / AI primitives into `packages/` if either is
  needed by `apps/web/` before Phase 5 cutover.
