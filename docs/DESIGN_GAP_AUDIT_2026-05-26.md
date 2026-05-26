# SiteLayer — Design-Fidelity Gap Audit

**As of:** 2026-05-26 · **Designs (source of truth):** `docs/handoff/v3.3.0/` (v3.3.0 handoff — screenshots + JSX prototypes + specs)

This audits the **built UI against the v3.3.0 designs**, screen by screen, to make Steve's "halfway between the old version and the new designs" concrete and checkable.

**Important:** the "Built?" column is judged from **code** (component structure, wiring), not from a running app. Where structure is ambiguous it's flagged "verify." A separate visual side-by-side (render current ↔ design PNG) is the way to confirm pixel fidelity.

### Legend

✅ Matches spec · 🟡 Partial / drifted · 🔴 Missing or wrong-shape · **P0** pilot-critical · **P1** important · **P2** later · Effort **S/M/L**

---

## Headline

| Area                              | Designed                         | Fidelity to designs | Verdict                                                                                                                                               |
| --------------------------------- | -------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Design system + system states** | tokens, ~15 primitives, 5 states | **~100%**           | Foundation is solid — accent `#d9904a`, system font, all primitives + offline/error/empty/loading/permission states built. No Geist/Inter drift.      |
| **Worker** (mobile, dark)         | 6 screens                        | **~60%**            | All screens exist and function, but visible polish gaps (crew avatars, progress bars, pay summary, camera viewfinder).                                |
| **Foreman** (mobile, light)       | 7 screens                        | **~80%**            | 5 screens close to spec; blocker-resolve action may be stubbed (verify); no foreman-specific time-review surface.                                     |
| **Estimator — mobile**            | 12 screens                       | **~85%**            | 10 solid; takeoff "links out" to the desktop canvas; settings partially wired.                                                                        |
| **Estimator — desktop**           | 16 screens                       | **~10%**            | 🔴 **The big gap.** The app is the mobile shell at all widths; only the estimate-builder (and partially the takeoff canvas) have real desktop layout. |

**Net: ~55–60% of the designed surface is built to spec** — consistent with "halfway." The field/mobile product is close; the **desktop estimator/owner experience is essentially unbuilt**, and that's the bulk of what's "not to the designs."

> 🔑 **The one decision that drives everything:** does the pilot need the **desktop estimator** at all, or is mobile-only acceptable for now? If desktop is required, that's ~2–3 weeks of net-new table/grid/dashboard work. If mobile-only is fine for the pilot, the gap shrinks to polish + a few stubbed actions. **This is a question for Steve/Taylor before anyone builds.**

---

## Worker (mobile, dark) — ~60%

| Screen         | Design intent                                                                                   | Built?                  | Gap                                                                                                                                                                  | Pri | Eff |
| -------------- | ----------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- |
| **wk-today**   | Running clock, job card w/ foreman attribution, crew-on-site avatars, scope summary, flag-issue | 🟡 `worker-today.tsx`   | No foreman avatar/attribution pill; **crew avatars section missing**; no scope summary card; break button hardcoded-disabled; no "started/break" meta; no OT warning | P0  | M   |
| **wk-clockin** | Geofence map + green check + "clocked in at…", open-scope CTA, 60s "wrong project" fix          | ✅ `worker-clockin.tsx` | Close. Uses 120s correction window (vs 8s auto-dismiss); no "wrong site" override sheet                                                                              | P1  | S   |
| **wk-scope**   | Dark accent goal card w/ SF target + progress bar, expandable step rows, "question scope"       | 🟡 `worker-scope.tsx`   | Goal card missing accent tint; **no progress bar**; target not formatted/right-aligned; generic step icons; placeholder steps hardcoded                              | P1  | M   |
| **wk-issue**   | 6-tile category grid, severity segmented control, describe + voice/photo                        | ✅ `worker-issue.tsx`   | Strong match. Minor: 6 design categories map to 4 DB kinds (tagged workaround); audio playback element extra                                                         | P2  | S   |
| **wk-hours**   | "32:18 / OF 40 HRS", 7-day bar chart, daily entries, pay-period summary pills                   | 🟡 `worker-hours.tsx`   | Decimal hours (not 32:18) + no "OF 40 HRS" eyebrow; **pay-period summary card omitted**; no OT warning                                                               | P1  | M   |
| **wk-log**     | Full-bleed camera viewfinder, auto-tag chip, 72px capture button, slide-up note                 | 🟡 `worker-log.tsx`     | No full-bleed viewfinder (dashed file-input fallback); no custom capture button/flash/flip controls; auto-tag + note present                                         | P1  | L   |

_Summary: functional field loop, but reduced visual feedback. Highest-value fixes: crew avatars + foreman attribution on Today, progress bar on Scope, pay summary on Hours._

---

## Foreman (mobile, light) — ~80%

| Screen                | Design intent                                                                                                                  | Built?                          | Gap                                                                                                                                                                                                                            | Pri | Eff |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | --- |
| **fm-today**          | Stacked multi-site, KPIs, AI overnight-delta stripe, "from the field" stripe, per-site cards w/ brief status                   | ✅ `foreman-today.tsx`          | None material — layout, sort priority, stripes all present                                                                                                                                                                     | —   | —   |
| **fm-brief**          | Goal textarea, reorderable steps, materials, crew assign, pre-fill, AI attribution; `POST /briefs`                             | ✅ `foreman-brief.tsx`          | Minor: up/down buttons vs drag handles; functionally complete                                                                                                                                                                  | —   | —   |
| **fm-crew**           | Live roster, by-site/person/map toggle, status pills, long-press quick actions, map mode                                       | ✅ `foreman-crew.tsx`           | Map is a stylized cartoon, not real cartography (P2)                                                                                                                                                                           | P2  | S   |
| **fm-field**          | Issue inbox, severity filter chips, severity stripe rows, AI cluster stripe, tap→detail                                        | ✅ `foreman-field.tsx`          | None material; cluster heuristic relaxed to <60min (vs <30)                                                                                                                                                                    | —   | —   |
| **fm-blocker-detail** | Worker context, issue + voice + photos + GPS, **resolution picker** (order/bring/use/park/change-order), reply, send & resolve | 🟡 `foreman-blocker-detail.tsx` | ⚠️ **Resolve action may be stubbed** — code comment suggests `PATCH /api/worker-issues/:id` may not exist; chips render but submit path unverified. **VERIFY against backend** (other audits say worker-issues triage is live) | P0  | M   |
| **fm-log**            | AI-assembled summary, weather, photo timeline by step, materials, hours, send                                                  | ✅ `foreman-log.tsx`            | Weather shown in narrative, not separate card (P2)                                                                                                                                                                             | —   | —   |
| **fm-time-review**    | PM end-of-day approval: stat strip, worker rows w/ inline edit, AI clock-anomaly flags, "approve all"                          | 🟡 generic `time-review.tsx`    | No foreman-specific surface (generic component shared); no bulk "approve all"; no AI anomaly stripe                                                                                                                            | P1  | M   |

_Summary: the foreman loop is the strongest persona. Two real gaps: confirm/wire the blocker-resolve submit, and add the foreman "approve all" time surface._

---

## Estimator — mobile companion — ~85%

| Screen                  | Design intent                                                               | Built?                                   | Gap                                                                                      | Pri | Eff |
| ----------------------- | --------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- | --- | --- |
| **mb-home**             | Calm dashboard, AI priority row, KPI strip, today's projects, quick actions | ✅ `admin-home.tsx`                      | None material                                                                            | —   | —   |
| **mb-projects**         | Filtered list, state chips, search, card rows                               | ✅ `projects-list.tsx`                   | None material                                                                            | —   | —   |
| **mb-prj-detail**       | Hero + 7-tab nav (Overview/Estimate/Crew/Materials/Budget/Log/Files)        | ✅ `project-detail.tsx` + tabs           | All 7 tabs present (note: some tabs render "lightly")                                    | —   | —   |
| **mb-takeoff**          | Photo-driven mobile takeoff, drafts, capture, estimate integration          | 🟡 `takeoff-list.tsx`                    | **Links out to desktop `takeoff-canvas.tsx` instead of a native mobile takeoff surface** | P1  | L   |
| **mb-estimate**         | Line items review, totals, bid-accuracy keystone, send-to-client            | ✅ `estimate-review.tsx`                 | None material; AI bid-accuracy stripe present                                            | —   | —   |
| **mb-schedule-day**     | Today/week schedule grouped by day, crew dot counts                         | ✅ `schedule.tsx`                        | None material                                                                            | —   | —   |
| **mb-time-queue**       | Approval queue grouped by worker, AI flags inline, bulk approve             | ✅ `time-review.tsx`                     | AI anomaly flags not surfaced; bulk-approve not visible                                  | P2  | M   |
| **mb-rentals-catalog**  | Yard inventory grid, status, daily rate, filters, scan                      | ✅ `rentals.tsx` (+ `rentals-scan.tsx`)  | None material                                                                            | —   | —   |
| **mb-rentals-dispatch** | Dispatch to job: project/equipment/driver/when/billing                      | ✅ `rentals-dispatch.tsx`                | None material                                                                            | —   | —   |
| **mb-invoice-quick**    | Quick invoice: project + amount + memo, net-30                              | ✅ `invoice-quick.tsx`                   | None material                                                                            | —   | —   |
| **mb-settings**         | Profile, notifications, integrations status, push toggles                   | 🟡 `settings/`                           | Profile tab not wired into mobile shell; settings reachable via desktop routes           | P1  | M   |
| **mb-pwa-install**      | Install prompt + location/notification primes + splash                      | ✅ `onboarding/install-prompt-sheet.tsx` | None material                                                                            | —   | —   |

_Summary: the mobile estimator is largely shippable. Two gaps that matter: a native mobile takeoff (currently defers to the desktop canvas) and mobile settings/profile._

---

## Estimator — desktop — ~10% 🔴 (the main gap)

The 2026-05-05 consolidation (ADR 0003) made production mobile-only; these desktop screens render as mobile card-stacks/sheets at all widths. Only `estimate-builder` (and partially `takeoff-canvas`) have real `lg:` desktop layout.

| Screen                    | Design intent                                                                           | Built?                                           | Gap                                                                                    | Pri | Eff |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- | --- | --- |
| **home-dashboard**        | Desktop calm dashboard: KPI grid, AI priority cards, today's projects, calm/busy toggle | 🟡 `owner/today.tsx` (mobile-only)               | Needs desktop KPI grid layout                                                          | P0  | M   |
| **projects-list**         | Sortable table: project·client·state·value·foreman·start·%·margin + filters             | 🔴 `projects/list.tsx` (mobile cards)            | **No desktop table**                                                                   | P0  | L   |
| **prj-detail**            | Multi-tab desktop detail w/ project hero, all 8 tabs                                    | 🟡 `projects/detail.tsx`                         | Mobile sub-tabs only; missing Materials/Budget/Log/Files as full tabs; no desktop hero | P0  | M   |
| **prj-create-sheet**      | Desktop modal: client + archetype + AI budget suggestion                                | 🔴 `mobile/project-new.tsx`                      | No desktop modal                                                                       | P0  | S   |
| **takeoff-canvas**        | Drawing canvas, agent polygons, right-rail quantities, bottom scale/tools               | 🟡 `projects/takeoff-canvas.tsx`                 | Exists but full-screen at all widths; needs desktop toolbar/right-rail arrangement     | P0  | M   |
| **estimate-builder**      | 3-pane: scope tree · line items · bid-accuracy keystone                                 | 🟡 `projects/estimate-builder.tsx`               | Has `lg:` panes — closest desktop screen; verify density/line-edit wiring              | P0  | S   |
| **schedule-ahead**        | Horizontal 28-day grid, crews×days, sticky header/left, drag-reschedule                 | 🔴 `projects/schedule-four-week.tsx` (mobile)    | **No desktop grid**                                                                    | P0  | L   |
| **time-queue**            | Dense approved-hours table, inline AI anomaly chips, bulk→payroll                       | 🟡 `mobile/time-review.tsx`                      | Card layout; needs dense table + anomaly chips + bulk approve + payroll export         | P1  | M   |
| **rentals-home**          | Hero idle-revenue KPI + AI suggestion stripe                                            | 🔴 none dedicated                                | No desktop home                                                                        | P2  | S   |
| **rentals-catalog**       | Inventory table w/ photos, status, idle days, utilization %, reconciliation             | 🔴 `mobile/rentals.tsx`                          | No desktop table                                                                       | P2  | M   |
| **rentals-dispatch**      | Desktop dispatch form, scoped inventory                                                 | 🔴 `mobile/rentals-dispatch.tsx`                 | No desktop screen                                                                      | P2  | S   |
| **rentals-returns**       | Check-in flow, damage→work order                                                        | 🔴 mobile sheet only                             | No desktop returns                                                                     | P2  | S   |
| **rentals-utilization**   | Per-asset in/out/idle chart + monetize panel                                            | 🔴 `rentals/utilization.tsx` (mobile)            | No desktop chart/monetize                                                              | P2  | M   |
| **rentals-portal**        | External customer portal (separate domain): browse/schedule/confirm                     | 🔴 `mobile/rentals-portal.tsx` (stub)            | Not built                                                                              | P2  | L   |
| **invoice-create**        | AIA schedule-of-values builder, auto-fill from scope, net-30, email/portal              | 🔴 `mobile/invoice-quick.tsx`                    | No desktop AIA builder                                                                 | P1  | M   |
| **settings-integrations** | QBO/supplier/email/payment tiles, last-synced + reconnect                               | 🟡 `integrations/hub.tsx` + `qbo-connection.tsx` | Tiles exist; needs desktop layout + auth-status/reconnect/sync timestamp               | P1  | S   |

_Summary: ~13 of 16 desktop screens are missing or wrong-shape. The P0 trio (projects table, home dashboard, 28-day schedule grid) is ~60% of estimator daily use per the spec and has no production desktop layout._

---

## Design system & system states — ~100% ✅

Foundation is the strongest part and matches spec: tokens (`apps/web/src/styles/tokens.css` — accent `#d9904a`, system font, no Geist/Inter drift), all ~15 primitives in `apps/web/src/components/m/` (MTopBar, MLargeHead, MRow, MKpi, MPill, MBanner, MBottomTabs, MAvatarGroup, MQuickAction, AI primitives Spark/AiStripe/AiEyebrow), and all 5 system states in `apps/web/src/components/m-states/` (offline, error, empty, loading, permission). Building the remaining screens does **not** require new foundation work.

---

## Prioritized punch-list

**P0 — pilot-critical**

1. **Decide desktop vs mobile-only for the pilot** (scope gate — answer before building).
2. If desktop: build the trio — **projects-list table, home-dashboard, schedule-ahead 28-day grid** (all currently mobile-shaped). Effort: L + M + L.
3. Finish **prj-detail** (Materials/Budget/Log/Files tabs) and **takeoff-canvas** desktop arrangement.
4. **Verify/wire foreman blocker-resolve** (`PATCH /api/worker-issues/:id`) — the field loop dead-ends if it's stubbed.
5. Worker **wk-today**: crew avatars + foreman attribution.

**P1 — important**

- Foreman "approve all" time-review surface; mobile native takeoff (`mb-takeoff`); mobile settings/profile; worker scope progress bar + hours pay summary + camera viewfinder; desktop invoice (AIA) + settings-integrations polish.

**P2 — later**

- Rentals desktop suite (home/catalog/dispatch/returns/utilization/portal), real cartography for fm-crew map, AI anomaly chips in time queues, worker log camera controls.

---

## Items to verify (don't trust the code-read alone)

1. **Foreman blocker-resolve**: one audit found a "route may not exist" comment; backend audits said `worker-issues` triage is live. Confirm in the running app.
2. **Pixel fidelity** of the "✅ Matches" screens — these are code-structure matches; only a side-by-side render confirms the look.
3. **Whether mb-takeoff "linking out" is acceptable** for the pilot or counts as a gap.
4. **Steve's read** on which screens he considers "old version" styling vs "new" — he's the designer and the spec names him the source of truth for ambiguity.
