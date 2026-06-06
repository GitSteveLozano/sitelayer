# SiteLayer — What Is Actually Built (evidence-grounded inventory)

**As of:** 2026-05-27. Built by enumerating the filesystem and reading the code, not impressions. Every line is backed by a file. Status legend: **REAL** = wired + usually tested; **PARTIAL** = works but a surface/flag is incomplete; **STUB** = schema/scaffold only.

## Scale (counted, not estimated)

- **~75 API handler modules** (117 files incl. tests) in `apps/api/src/routes/`, dispatched via `routes/dispatch.ts` (~150 endpoints).
- **16 deterministic workflows** in `packages/workflows/src/` (pure reducer + event log + outbox), 14 with golden tests, 7 with property tests.
- **~21 worker runners** in `apps/worker/src/runners/` on a Postgres leased queue + `mutation_outbox`.
- **28 XState machines** (`apps/web/src/machines/`), **63 API resource modules** (`apps/web/src/lib/api/`), **~17 `components/m/` primitives**.
- **157 screen files** across 11 dirs (mobile 45, projects 27, settings 16, financial 11, rentals 8, inventory-admin 8, onboarding 6, foreman 6, owner 5, integrations 4, worker 1).
- **100 SQL migrations / ~90 tables** in `docker/postgres/init/`.
- **11 packages**: domain, workflows, queue, config, logger, capture-schema, capture-catalog, pipe-{blueprint,roomplan,drone,photogrammetry}.

## 1. Takeoff + estimation + assemblies + pricing

- **Blueprint upload / versioning / PDF storage / first-page rasterize** — REAL (`blueprints.ts`, `blueprint-pages.ts`; dual-mode Spaces/local; version lineage).
- **Takeoff measurement CRUD (polygon/lineal/count/volume), batch replace, LWW conflict, draft routing** — REAL (`takeoff-write.ts`, `takeoff-measurements.ts`).
- **Multi-draft takeoff system** (per-draft measurements + estimate) — REAL (`takeoff-drafts.ts`).
- **Capture pipelines** (blueprint_vision/roomplan/drone/photogrammetry → `TakeoffResult` → promote) — blueprint_vision REAL behind `BLUEPRINT_VISION_MODE=live`; roomplan/drone-sidecar/photogrammetry-labeled-mesh REAL paths, live external services PARTIAL/untested. (Detail: `docs/BLUEPRINT_TO_3D_PREVIEW.md`.)
- **3D takeoff preview** (three.js renderer + 2D→3D builder) — REAL (`takeoff-3d-scene.tsx`, `lib/takeoff/geometry-3d.ts`; `/projects/:id/takeoff-preview` + `/demo/takeoff-preview-3d`).
- **CSV import** (Bluebeam/PlanSwift) — REAL (`takeoff-import.ts`).
- **Pricing chain resolver** (project→customer→company→qbo→fallback, single batch query) — REAL (`pricing.ts`).
- **Estimate generation + per-line editing (optimistic guard) + scope-vs-bid + forecast-hours** — REAL (`estimate.ts`).
- **Assemblies** (component recipes w/ waste %, total_rate) — REAL: CRUD + resolver (`assemblies.ts`, `domain/assembly.ts`) and the Estimate Builder drill-down (`estimate-line-assembly.tsx`). By design a cost breakdown, not a sell-rate override, so it is intentionally not folded into `estimate_lines.rate`.
- **Pricing profiles** — CRUD REAL but config not yet consumed by resolver (PARTIAL).
- **Estimate push workflow** (drafted→…→posted) — REAL; QBO push live behind `QBO_LIVE_ESTIMATE_PUSH` (PARTIAL until creds).
- **Bid accuracy** (estimate-vs-actual cohort, confidence) — REAL, pure SQL (`bid-accuracy.ts`).
- **AI insights** (apply/dismiss, takeoff-to-bid/voice-to-log/bid-follow-up enqueue, CV suggestion intake) — REAL ingestion; generators heuristic/stub.

## 2. Rentals + inventory + dispatch + shipments + scaffold

- **Rental billing workflow** (multi-cycle → QBO invoice) — REAL (`rental-billing-state.ts` + workflow).
- **Rental CRUD + return + transfer**, Phase-2 event API — REAL (`rentals.ts`, `rental-events.ts`).
- **Job rental contracts + lines + rate tiers + billing-run preview/create** — REAL.
- **Inventory items/locations/movements, availability rollup, forecast, utilization** — REAL (forecast's crew-schedule window is a stub feed).
- **Cross-hire / re-rent (external_rentals + vendors)** — REAL.
- **Damage/loss settlement workflow** (open→invoiced|waived) — REAL.
- **Shipment workflow** (planned→…→closed, per-line qty tracking) — REAL.
- **Dispatch lanes kill-switch** (active/paused/degraded + audit) — REAL.
- **Scaffold catalog/systems/manufacturers/parts (w/ real dims+weight), BOM+lines, branches, QR tags + inspections** — REAL.
- **Scaffold ops approval workflow** — reducer exists, route dispatch PARTIAL.
- **Portal rentals** (public catalog + reserve → request queue) + **rental request approval** — REAL.
- **NOT built:** scaffold _designer_ (catalog+ops only, no design→BOM, no 3D modeler).

## 3. Time + crew + payroll

- **Clock in/out** (GPS, geofence, `auto_out_idle`/`auto_out_geo`, void window, photo verify) — REAL (`clock.ts`).
- **Labor entries** (+ auto-draft from clock-out) + **burden math** (base × (1+ins%+ben%)) — REAL.
- **Payroll runs workflow** (generated→…→posted) — REAL.
- **Payroll exports**: XLSX (dependency-free OOXML writer) / Xero / Payworks / Gusto (8h OT split) / ADP (REG/OT) / CSV / JSON — all REAL.
- **Time review workflow + anomaly detection** (overlap/excessive/zero/geofence/etc → lock labor) — REAL.
- **Crew scheduling** (draft→confirmed, drag-reschedule, **copy-week**) — REAL.
- **Workers roster, project assignments** (clerk_users name resolution) — REAL.
- **Daily logs** (draft→submitted + photos) — REAL.
- **Bonus rules** — CRUD + payout math (`calculateBonusPayout`/`simulateBonusScenario` in `domain`) + simulator UI REAL; only _applying_ payout into a live payroll run is unbuilt (PARTIAL).

## 4. QBO + integrations + sync

- **OAuth connect** (signed state, token exchange, refresh) — REAL (`qbo.ts`).
- **Pull**: Customer, Item, Class/Division → upsert + mapping — REAL. TimeActivity/Bill pulled+counted but **not auto-ingested** (STUB ingest).
- **Push**: Material Bill → QBO Bill (vendor resolve/create), Estimate → QBO Estimate — REAL (tested w/ HTTP mock); simulated mode w/o creds.
- **qbo_sync_run workflow** (pending→syncing→succeeded|failed→retrying) — REAL.
- **Circuit breaker** (in-process + `integration_circuit_state` + Prometheus gauge) — REAL.
- **Custom-field mappings, entity mappings, sync_events audit, cost logging** (`company_usage_log`) — REAL.
- **Rental-invoice / labor-payroll QBO push** — behind `QBO_LIVE_*` flags, stub IDs until enabled (PARTIAL).

## 5. Deterministic workflows (the spine)

All 16 registered via `registry.ts`, pure reducer, `workflow_event_log` (optimistic `state_version`), outbox side effects, replay harness (`replay.ts`). REAL: estimate_push, rental_billing_run, crew_schedule, project_closeout, time_review_run, labor_payroll_run, project_lifecycle, field_event, daily_log, notification, shipment, damage_charge_settlement, rental_request_approval, qbo_sync_run, scaffold_ops_approval. PARTIAL: `rental` (reducer + tests, routes not fully wired).

## 6. Worker (background processing)

Leased Postgres queue + `mutation_outbox` (claim `FOR UPDATE SKIP LOCKED`, lease, retry, dead-letter, prune). Dedicated runners (REAL unless noted): queue-drain, queue-prune, heartbeat-prelude, rental-invoice, rental-billing-push, estimate-push, lock-labor, labor-payroll, field-events (+auto-escalation), takeoff-to-bid (Claude Opus), voice-to-log (live behind `VOICE_TO_LOG_MODE=live`+key, else deterministic draft), companycam-poll (live behind `LIVE_COMPANYCAM`), notification (email/SMS/web-push), welcome-email, stuck-workflow-alerts, lane-health-keeper, blueprint-storage-gc, context-work-dispatch (Mesh), work-request-stale, audit-escrow-tick (Ed25519 chain). damage-charges push PARTIAL.

## 7. Web frontend

- **MobileShell** canonical runtime shell + inline route table; **45 mobile screens** (~38 REAL: worker today/scope/hours/log/clockin/issue; foreman today/field/crew/log/brief/map/time; estimator home/projects/detail/takeoff/takeoff-mobile/estimate/estimate-push; schedule; rentals catalog/dispatch/scan; work-requests; settings/more hubs). Few PARTIAL (foreman-crew/map use a labor-count proxy until clock-timeline), quick-invoice STUB.
- **Desktop/admin** (projects 27, financial 11, settings 16, owner 5, integrations 4, inventory-admin 8, rentals 8, onboarding 6): estimate-builder, takeoff-canvas (1585 lines), QBO connection/mappings/custom-fields, rental-contract (670 lines), damage-charges, daily-log (701 lines), live-crew, onboarding wizard all REAL. Financial/settings hub+list screens are thin card-decks (STUB-ish) over REAL detail screens.
- **Data layer:** single `request<T>()` (Sentry trace + tenant header + Clerk auth), 63 resource modules, TanStack Query, CRUD factory.

## 8. Auth + onboarding + portal + notifications

- **Clerk JWT verify + act-as (dev) + header fallback**, roles admin/foreman/office/member/bookkeeper — REAL (`auth.ts`).
- **Company create + membership + seed + modules/settings + usage rollup** — REAL.
- **Clerk webhook user-mirror** (`clerk_users`, migration 096) — REAL (mirrors identity; welcome fires post-onboarding, not from webhook).
- **Customer portal**: estimate share links + **e-signature accept/decline** (idempotent, fires project_lifecycle) — REAL; portal photo/inspection/shipment lists STUB. Rental portal reserve → request queue PARTIAL.
- **Notifications**: 8-state workflow, queue view, per-user feed, preferences (push/sms/email/off), web-push subscriptions — REAL.
- **Project briefs** (foreman morning plan) — REAL.

## 9. Observability + security + audit + ops

- **Prometheus metrics** (12 series), **Pino JSON logs** w/ request context, **Sentry trace propagation** API→outbox→worker→QBO, **debug-trace endpoint**, **/health + /api/version** — REAL.
- **Row-Level Security** 3 phases (shadow → ENABLE → FORCE) across 60+ tables, per-tx `SET LOCAL app.company_id` — REAL.
- **Audit events** + **audit escrow** (Ed25519 tamper-evident hash chain, optional S3 Object Lock + OpenTimestamps) — REAL.
- **Support debug packets** (auto-built redacted context + access log), **work-requests** (Mesh handoff w/ callback tokens), **obstructions**, **workflow-event-log API**, **company_usage_log** cost ledger — REAL.
- **Rate limiting, version guard, LWW** — REAL.

## 10. Field capture + AI

- **CompanyCam** photo mirror — REAL behind `LIVE_COMPANYCAM` (real API poll + dedupe).
- **Daily logs + photos**, **field-event triage** (worker issue → foreman resolve/escalate, voice/photo attachments, auto-escalation) — REAL.
- **AI chat assist** — REAL transport (stage → Mesh dispatch → SSE response), model runs out-of-band in a Mesh subscription runner.
- **AI insights / voice-to-log / takeoff-to-bid** — dispatch REAL; voice-to-log has a live Claude path (`VOICE_TO_LOG_MODE=live` + `ANTHROPIC_API_KEY`) that degrades to a deterministic draft; bid-follow-up heuristic.

---

## The honest "not built / thin" list

> Verified 2026-05-27 by reading each before acting. Several items first listed
> as gaps were already built — the docs/comments lied. Corrections inline.

1. **Scaffold designer** (3D design → auto-BOM → load/bracing) — _in progress; core + 3D UI shipped 2026-05-27._ `packages/domain/src/scaffold-design.ts` `generateScaffoldModel(spec)` is the pure, deterministic core (bays×lifts → 3D members + part demand by role+length). A live designer screen is wired at `/scaffold-designer` (reachable from the scaffold catalog): edit the spec, see the scaffold in three.js (`scaffold-3d-scene.tsx` via the tested `lib/scaffold/scaffold-scene.ts` mapper), and read the auto-BOM (part demand) table. The auto-BOM persists: `resolveScaffoldBom` (domain) matches part demand → `catalog_parts` by the `attrs.role` convention + nearest `length_mm`, and `POST /api/projects/:id/scaffold-designs/bom` runs the generator, resolves, and writes a draft `boms`/`bom_lines` (`source='scaffold_design'`) with weight rollup, reporting any unresolved roles. The designer screen closes the loop: a "Save as BOM" panel (project + scaffold-system picker) POSTs to the endpoint and reports the saved draft BOM + any unresolved roles, then links to the project BOMs screen (`/projects/:id/boms`, also reachable from the rental-contract screen) which lists every saved BOM, shows its lines, and approves drafts. Remaining slices: load/bracing checks; a richer member-level render (decks already render as planes); BOM approve→inventory rollup is already wired via the existing `scaffold_ops_approval` workflow.
2. ~~Captured 3D geometry → renderer~~ — **shipped (2026-05-27), true scale for blueprint + drone.** `geometry-3d.ts` renders promoted `kind:'capture'` polygons and bypasses the blueprint/page filter; selecting the capture draft in the 3D preview shows them. **Blueprint** renders at true scale (pixels ÷ `provenance.scaleFt`); **drone** renders at true scale (GeoJSON `[lon,lat]` tagged `coordSpace:'lonlat'` at promote, equirectangular-projected to feet about the centroid). Any future polygon-bearing source with neither falls back to bounds-normalized relative scale.
3. **QBO live pushes for rental-invoice / labor-payroll** + TimeActivity/Bill **ingest** — flag-gated / needs business rules + creds (operator-blocked).
4. **AI chat model** — out-of-band (runs in a Mesh subscription runner, not in-process).
5. **Bonus payout _application_ into a payroll run** — the math (`calculateBonusPayout`/`simulateBonusScenario`) and simulator UI exist; only applying payout inside a live run remains (a money-path design decision).
6. ~~Assembly expansion into estimate_lines~~ — **NOT a gap.** Assembly drill-down is built + wired in the Estimate Builder (`estimate-line-assembly.tsx` → `/api/assemblies`); it's a cost breakdown by design, not a sell-rate override.
7. ~~Customer-portal media lists~~ — **DONE** (`portal-public.ts:147-219` returns photos/inspections/shipments).
8. ~~XLSX payroll export~~ — **DONE** (`xlsx-writer.ts` + the `xlsx` branch); the old "returns 503" comment was stale and is now fixed.
9. ~~Voice-to-log LLM~~ — **shipped** live mode (2026-05-27): `VOICE_TO_LOG_MODE=live` + `ANTHROPIC_API_KEY` calls Claude (Haiku default); graceful fallback to the deterministic draft on failure.
10. **Pricing-profile config consumption** — config stored, not consumed by the resolver (ambiguous config schema; needs design).
