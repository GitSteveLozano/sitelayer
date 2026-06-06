# SiteLayer — What's Left / Roadmap

**As of:** 2026-05-26 · Built from 3 explore agents + direct verification. UI is complete (61 handoff screens + all backend→UI gaps closed). This is everything else, prioritized. Each item marked ✅verified (confirmed in code/docs/mesh) or ◻︎inferred.

> **Verification corrections** to the raw findings: (1) `vendor-three` is **already lazy-loaded** (not in the app shell) — only the PWA precache carries it, so it's a minor tweak, not P0. (2) Geofence auto **clock-in** is wired and on-by-default; the gap is auto **clock-out on idle** + iOS background.

---

## Track A — Pilot launch (operator/ops; mostly NOT code) · the real gate

These block a real first customer. Verified from CRITICAL_PATH.md / DEPLOY_RUNBOOK.md / mesh.

| P      | Item                                        | What                                                                                                                                                                                   | Effort |
| ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **P0** | **QBO sandbox validation** ✅               | Capture Intuit OAuth Playground creds, run `scripts/qbo-sandbox-smoke.sh` (MODE A + `RENTAL_INVOICE_TEST=1`), then flip `QBO_LIVE_*=1`. All plumbing shipped; only creds + run remain. | ~1h    |
| **P0** | **UptimeRobot monitors** ✅                 | Provision 3 monitors (`/health`, `/api/version`, dev) per `docs/UPTIME_ROBOT_MONITORS.md`; route to Slack/phone.                                                                       | 30m    |
| **P0** | **Perf baseline** ✅                        | Load-test pilot-critical flows (blueprint upload, takeoff write, rental-billing events, QBO drain) for the documented `<500ms` criterion.                                              | ~4h    |
| **P0** | **First-customer provision** ✅             | Run `scripts/provision-pilot-company.sh`; brand the Clerk app off "My Application".                                                                                                    | ~1h    |
| **P1** | **On-call / SLA + Sentry worker alerts** ✅ | Define escalation; finish `scripts/sentry-provision-alerts.sh` for the worker project (QBO failure scopes).                                                                            | ~2h    |
| **P1** | **Spaces CORS** ✅                          | Validate + flip `BLUEPRINT_DOWNLOAD_PRESIGNED=1` so large PDFs stop proxying through the API.                                                                                          | ~1h    |

## Track B — Quick wins (code; high value, ≤1 day each) · do these next

| P      | Item                                | Status                                                                                                                                                                                                                    | Effort |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **P1** | **Copy-week UI** ✅                 | API `POST /api/schedules/copy-week` exists + tested; **no UI button**. Add it to the schedule grid.                                                                                                                       | 0.5–1d |
| **P1** | **Clerk webhook user mirroring** ✅ | `public.ts:190` is a confirmed no-op. Add the mirror table + upsert on `user.created/updated` so invited members get JIT membership (kills manual provisioning friction).                                                 | 1d     |
| **P1** | **Geofence idle auto clock-out** ✅ | `auto_out_idle` event declared but no client idle timer. Add the timer/watcher to complete the time-tracking story.                                                                                                       | 1–2d   |
| **P2** | **Doc-drift fix** ✅                | CLAUDE.md workflow table is wrong: shipment is `planned/picking/shipped/delivered/returning/closed/voided` (not `draft/scheduled…`); damage is `open/invoiced/waived` (not `billed`). 2-line fix.                         | 10m    |
| **P2** | **Delete dead code** ✅             | `screens/worker/` (7 files: today/hours/issue-modal/photo-log/clocked-in-view/clockin-success) is orphaned (no imports) — duplicated by `screens/mobile/worker-*`. Remove. Also `revision-compare-stub` is a placeholder. | 0.5d   |
| **P2** | **PWA precache trim** ✅            | `vendor-three` (538KB) is lazy-loaded but still in the Workbox precache → downloaded on install for everyone. Exclude from precache / runtime-cache it.                                                                   | 0.5d   |
| **P2** | **Backend follow-ups** ✅           | Company-wide `GET /api/assignments` (avoid per-project fan-out in the new assignments view); assignee name resolution (`clerk_user_id`→worker name).                                                                      | 1d     |

## Track C — Feature completion (medium; finish what's half-built)

| P   | Item                                    | Status                                                                                                                         | Effort   |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| P1  | **Estimate line editing on mobile** ✅  | "INTEGRATION TODO" markers; desktop works, mobile plumbing incomplete.                                                         | 1–2d     |
| P1  | **Rental Phase-2 event migration** ✅   | Lifecycle events API exists + now has UI; legacy CRUD paths still active in `routes/rentals.ts`. Consolidate onto the reducer. | 2–3d     |
| P2  | **Blueprint revision diff renderer** ✅ | `revision-compare-stub`: picker + data ready, red/blue image-diff overlay not built (schema `blueprint_page_diffs` exists).    | 2–3d     |
| P2  | **AI anomaly detection (real)** ✅      | Currently a simple `>8h` heuristic labeled "placeholder for the AI flag". Replace with real variance/pattern detection.        | 5–7d     |
| P2  | **Geofence iOS background** ◻︎           | Background geolocation for installed iOS PWA — deferred to native follow-on per code comment.                                  | research |

## Track D — Bigger features (post-pilot)

| P   | Item                                             | Status                                                                                           | Effort                           |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------- |
| P2  | **Photogrammetry / drone / RoomPlan capture** ✅ | All three pipelines are stubs returning empty `TakeoffResult` (only `blueprint_vision` is real). | ~3–4w each, vendor-API dependent |
| P2  | **i18n** ✅                                      | Deferred (ADR 0004); all strings en-US.                                                          | 3–4w                             |

## Track E — Tech debt / hardening

| P      | Item                                               | Status                                                                                                                                                   | Effort   |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **P0** | **API route tests** ✅                             | ~40 of 75 routes untested — incl. clock, labor-entries, rentals, takeoff-import (customer-facing). Add route-level tests.                                | 3–4d     |
| **P0** | **Un-skip e2e + run in CI** ✅                     | 6 workflow e2e specs gated behind `E2E_RUN=1`, never run in CI (only 2 smokes run). Stabilize preview seed, gate deploy on them.                         | 1–2d     |
| **P1** | **Zero-downtime deploy** ✅                        | Single-droplet container swap = ~30s blank window per deploy (observed in rollback drill). Add standby stack + Caddy health-gated upstreams, or a DO LB. | ~5d      |
| **P1** | **Integration smoke in CI** ✅                     | QBO / Clerk-sync / notification delivery only have mocked tests; no CI smoke against sandboxes.                                                          | 4d       |
| **P1** | **Restore-drill automation** ✅                    | Weekly timer runs but success isn't auto-verified/alerted; schedule a quarterly rollback drill too.                                                      | ~1d      |
| **P2** | **ORM migration (Prisma/Drizzle)** ✅              | CLAUDE.md flags raw-SQL-in-handlers as "unsustainable beyond ~100 queries"; already past threshold. Post-pilot.                                          | 2–3w     |
| **P2** | **Web screen/primitive tests** ✅                  | ~19% screen coverage; `components/m/*` primitives have 0 tests. Cover top screens + core primitives.                                                     | 5–7d     |
| **P2** | **HA / off-region backup** ✅                      | Single droplet, single region. Add secondary/LB + nyc3 backup bucket.                                                                                    | ~1w      |
| **P2** | **Sentry sampling + workflow schema versioning** ◻︎ | Prod traces at 10%; no `schemaVersion` on workflow snapshots for future replay.                                                                          | <1d / 1d |

---

## Recommended sequence

1. **Track A (P0 operator items)** — the actual pilot gate; ~1 day of mostly non-code ops. Nothing below blocks the pilot.
2. **Track B quick-wins batch** — copy-week UI, Clerk webhook mirroring, doc-drift, delete dead code, precache trim, backend follow-ups. ~2–3 days, parallelizable with agents; high value/low risk.
3. **Track E P0 (tests + e2e in CI)** — buy back confidence before a 2nd customer.
4. **Track C** feature completion (idle clock-out, rental Phase-2, estimate line editing) as pilot feedback dictates.
5. **Track D / Track E P2** — post-pilot.

Quick-wins in Track B are the obvious next execution batch — all verified, all clone/extend existing patterns, all shippable via the established dev→prod flow.
