# Customer requirements — grounded in Cavy's actual asks

**Source of truth:** `docs/WhatsApp Chat with LA  Tiny Bison.txt` (the LA / Tiny Bison thread).
**Last grounded:** 2026-05-30.

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

| #   | Cavy's ask (WhatsApp ref)                                                                                          | Status                     | Evidence / note                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Upload drawings** (3/31, "I can't upload drawings")                                                              | ✅ Working                 | Multipart upload → DO Spaces (`blueprint-upload.ts`); desktop "↑ Upload blueprint".                                                                                                                                                     |
| 2   | **PlanSwift-lite: PDF render, scale calibration, polygon tool, sqft summary, annotations** (3/31)                  | ✅ Working                 | PDFium render (default-on), 2-point calibration, polygon/lineal/count/rect/arc tools, live scope totals.                                                                                                                                |
| 3   | **Takeoff: zoom in where the pointer is** (4/22)                                                                   | ✅ Working                 | Wheel zoom is pointer-anchored (`applyZoom` in `est-canvas.tsx`).                                                                                                                                                                       |
| 4   | **Takeoff: move the plan — right-click drag like PlanSwift** (4/22)                                                | ✅ Just shipped            | Right-button (+ middle/space/hand) now pans; context menu suppressed. PR #451.                                                                                                                                                          |
| 5   | **Don't lose takeoff data on app switch / save** (4/22)                                                            | ✅ Working                 | Measurements persist server-side per `takeoff_draft` (`takeoff-write.ts`) + offline queue. (His complaint was the static GitHub-pages prototype, not the real app.)                                                                     |
| 6   | **Division dropdown on the scope item** (4/10, `WhatsApp:227-229`)                                                 | ✅ Just shipped            | Per-item division chooser next to the scope selector; flows to `division_code`. PR #451.                                                                                                                                                |
| 7   | **Bid pool vs scope-rate breakdown — Option B (show "Scope $X vs Bid $Y" + warning)** (4/10–4/11)                  | ✅ Working                 | `estimate-builder.tsx` + `BidAccuracyCard` show scope/bid totals + status ("matches" / "small drift — review" / "mismatch — resolve before sending"), via `/estimate/scope-vs-bid`. **Verify it's reachable from Cavy's desktop flow.** |
| 8   | **Project-specific pricing + per-builder/customer template** (4/11)                                                | 🟡 Partial                 | API + tables exist (`project_/customer_/company_pricing_overrides`, mig 071) and project rates override default. **No desktop UI to SET per-project / per-customer rates** — needs a pricing screen.                                    |
| 9   | **Service item measure option: lineal vs area vs volume** (4/7, "build a bear")                                    | 🟡 Partial                 | Items carry a `unit` (`hr/sqft/lf/ea/cu yd/day`) set in the item-library settings; the takeoff uses it. No per-measurement override, and volume takeoff geometry is thin. Mostly covered for lineal/area.                               |
| 10  | **QBO actual-cost tracking** (4/3, "connect to QBO so I can see actual cost")                                      | 🟡 Partial                 | Estimate push + labor + material bills push to QBO; analytics compute cost/margin. **No single "estimate vs actuals per item" report view.**                                                                                            |
| 11  | **Foreman daily bulk time-confirm, pre-populated from a weekly schedule** (4/5–4/6; Cavy validated Steve's design) | 🟡 Partial                 | `crew_schedules` + `time_review_run` workflow exist; mobile time screens exist. The **schedule → draft entries → foreman one-tap "Confirm Day"** flow is not fully wired in the UI.                                                     |
| 12  | **Automated rental invoicing (Avontus replacement) → QBO** (4/7)                                                   | ✅ Working (validate live) | `rental_billing_runs` workflow (preview → approve → post) + worker QBO invoice push; `billing-run-detail.tsx` drives the lifecycle. Confirm against a real rental scenario.                                                             |

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

1. **#8 — project / per-builder pricing UI.** Cavy explicitly asked and it's the highest-value
   gap with backend already done; just needs a screen to set per-project / per-customer rates.
2. **#11 — schedule → foreman "Confirm Day".** Cavy validated this exact design; the infra
   exists, the one-tap confirm flow needs wiring.
3. **#10 — estimate-vs-actuals report.** Closes the loop Cavy cares about ("see actual cost").
4. **Live-verify #7 and #12** against Cavy's real workflow before calling them done.
