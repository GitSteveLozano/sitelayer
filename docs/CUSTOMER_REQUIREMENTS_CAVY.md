# Customer requirements — grounded in Cavy's actual asks

**Source of truth:** `docs/WhatsApp Chat with LA  Tiny Bison.txt` (the LA / Tiny Bison thread).
**Last grounded:** 2026-06-13.

## Who's who (read this first)

- **Cavy** (the `+1 (204) 298-8517` number; "Cavy Braun") is **the customer** — runs an
  EIFS / stucco / scaffolding contractor, uses QuickBooks Online, has divisions + foremen,
  and currently uses **Avontus** for rentals. His messages are the requirements.
- **Steve Lozano** is **the builder/dev** ("I'm looking to build a simple version of
  planswift… Okay, built"). He responds to Cavy and ships.
- **David Synchyshyn** is the connector/advisor (market context, Construction Clock, Innergy).

When prioritizing, **Cavy's messages win.** Steve's ambitions and David's market notes are
context, not spec. Treat anything not asked for by Cavy as a nice-to-have until he asks.

## What Cavy actually asked for — and where it stands

Verdicts are grounded against live code (2026-05-30). "Surfaced" = the desktop/mobile UI a
user actually touches, not just an API route.

| #   | Cavy's ask (WhatsApp ref)                                                                                          | Status                     | Evidence / note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Upload drawings** (3/31, "I can't upload drawings")                                                              | ✅ Working                 | Multipart upload → DO Spaces (`blueprint-upload.ts`); desktop "↑ Upload blueprint".                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | **PlanSwift-lite: PDF render, scale calibration, polygon tool, sqft summary, annotations** (3/31)                  | ✅ Working                 | PDFium render (default-on), 2-point calibration, polygon/lineal/count/rect/arc tools, live scope totals.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | **Takeoff: zoom in where the pointer is** (4/22)                                                                   | ✅ Working                 | Wheel zoom is pointer-anchored (`applyZoom` in `est-canvas.tsx`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | **Takeoff: move the plan — right-click drag like PlanSwift** (4/22)                                                | ✅ Just shipped            | Right-button (+ middle/space/hand) now pans; context menu suppressed. PR #451.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | **Don't lose takeoff data on app switch / save** (4/22)                                                            | ✅ Working                 | Measurements persist server-side per `takeoff_draft` (`takeoff-write.ts`) + offline queue. (His complaint was the static GitHub-pages prototype, not the real app.)                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | **Division dropdown on the scope item** (4/10, `WhatsApp:227-229`)                                                 | ✅ Just shipped            | Per-item division chooser next to the scope selector; flows to `division_code`. PR #451.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | **Bid pool vs scope-rate breakdown — Option B (show "Scope $X vs Bid $Y" + warning)** (4/10–4/11)                  | ✅ Working                 | `estimate-builder.tsx` + `BidAccuracyCard` show scope/bid totals + status ("matches" / "small drift — review" / "mismatch — resolve before sending"), via `/estimate/scope-vs-bid`. **Verify it's reachable from Cavy's desktop flow.**                                                                                                                                                                                                                                                                                                 |
| 8   | **Project-specific pricing + per-builder/customer template** (4/11)                                                | ✅ Surfaced/shipped        | `ProjectRatesModal` (`screens/desktop/est-project-rates.tsx`, real upsert/remove via `useUpsertPricingOverride`/`useDeletePricingOverride`) is wired into the desktop estimate flow at `est-quantities.tsx:783`; saving writes `project_pricing_overrides` and recomputes. Per-CUSTOMER template entry from the UI is still thin (the resolver reads project→customer→company→qbo→default, but only the per-project rate has an editor).                                                                                                |
| 9   | **Service item measure option: lineal vs area vs volume** (4/7, "build a bear")                                    | 🟡 Partial                 | Items carry a `unit` (`hr/sqft/lf/ea/cu yd/day`) set in the item-library settings; the takeoff uses it. No per-measurement override, and volume takeoff geometry is thin. Mostly covered for lineal/area.                                                                                                                                                                                                                                                                                                                               |
| 10  | **QBO actual-cost tracking** (4/3, "connect to QBO so I can see actual cost")                                      | 🟡 Partial (per-item gap)  | The "estimate vs actuals" report ships: `OwnerJobCosts` (`screens/desktop/est-actuals.tsx`) wired at `desktop-workspace.tsx:1019` (`job-costs`) — per-PROJECT bid-vs-actual + a By-division rollup off `/api/analytics`. Per-SERVICE-ITEM granularity (the "build-a-bear / actual cost per line item" loop) now lands too via a per-item productivity table fed by `/api/analytics/service-item-productivity` (see #9). The remaining open work is a LIVE QBO pull (today actuals are internal labor+material), not the report surface. |
| 11  | **Foreman daily bulk time-confirm, pre-populated from a weekly schedule** (4/5–4/6; Cavy validated Steve's design) | ✅ Surfaced/shipped        | `FmConfirmDay` (`screens/desktop/fm-confirm-day.tsx`) wired at `desktop-workspace.tsx:1040` (`fm/confirm`): the day's schedule pre-selects the roster, the foreman edits hours + service item, one "Confirm day" dispatches CONFIRM through the crew-schedule workflow (materializes labor entries via outbox). Now also reachable phone-first: `MobileFmConfirmDay` (`screens/mobile/fm-confirm-day.tsx`, `components/m`) at mobile route `time/confirm`, surfaced from the mobile Time tab's top-bar "Confirm day" action.            |
| 12  | **Automated rental invoicing (Avontus replacement) → QBO** (4/7)                                                   | ✅ Working (validate live) | `rental_billing_runs` workflow (preview → approve → post) + worker QBO invoice push; `billing-run-detail.tsx` drives the lifecycle. Confirm against a real rental scenario.                                                                                                                                                                                                                                                                                                                                                             |

## Deliberately NOT the priority (nice-to-have / pie-in-the-sky)

These came up but are **not Cavy requirements** — they're Steve's ambitions or David's market
musings. Don't build them ahead of the table above.

- **Auto geo-clock-in** (Steve's "Option A"). David's own data said manual entry works fine
  when adoption is there, and **Cavy uses manual ("we currently use C")**. Manual
  confirmation-based entry is the ask, not geofencing.
- **GoPro / safety-glasses mapping the workday** (David, "way down the road").
- **Computer vision / smart inventory** (Steve musing, 4/15).
- **Rebuild Construction Clock's whole stack / ERP positioning / Innergy** — strategy, not spec.
- **Generalized multi-tenant "build-a-bear" for every trade** — keep the EIFS/stucco/scaffold
  wedge first (that's Cavy); generalize only when a second customer needs it.

## Recommended next priorities (grounded)

Re-grounded 2026-06-13 against live code: #8 (pricing UI), #11 (confirm-day), and the
estimate-vs-actuals report (#10) are **already shipped + wired** — do NOT rebuild them. The
table above carries the file/route evidence. The remaining grounded gaps:

1. **#10 — LIVE QBO actual-cost pull.** The estimate-vs-actuals report ships (per-project,
   per-division, and now per-service-item), but "actuals" are still computed from internal
   labor + material bills, not pulled live from QBO. Closing the loop fully means reading
   actuals back from QBO once a connection exists.
2. **#8 — per-CUSTOMER rate template editor.** The per-PROJECT rate editor ships; the
   resolver already reads a customer tier, but there is no UI to SET a per-customer template
   (only per-project). A small extension of `ProjectRatesModal`.
3. **#9 — per-measurement unit override + volume geometry.** Items carry a `unit`; the
   per-measurement override (lineal vs area vs volume on a single item) and volume takeoff
   geometry are still thin.
4. **Live-verify #7 and #12** against Cavy's real workflow before calling them done.
