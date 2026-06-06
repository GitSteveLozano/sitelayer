# SiteLayer — More We Can Build (vs. the original vision)

**As of:** 2026-05-26 · Source: Steve's ProService Bid-Intelligence spec (5 layers + 7 agents) and the PlanSwift/Avontus/ConstructionClock merged-platform doc, both mapped against the current code.

> **Update 2026-06-01 — foundation pieces have LANDED on `main`** (verified
> against the cited migrations/files): the PlanSwift Phase-2 assembly-explode
>
> - formula engine (`docker/postgres/init/109_assembly_explode_and_formulas.sql`
> - `110_seed_cladding_assemblies.sql`, `packages/domain/src/assembly.ts`,
>   `packages/formula-evaluator/`) — so the "assemblies" credited as solid below
>   are now backed by the explode-on-recompute path; the worker QBO pull lane
>   (`135_qbo_pull_lane.sql`); teammate invites (`134_company_invites.sql`);
>   RBAC custom roles (`136_custom_roles.sql`); and the PDFium blueprint render
>   foundation (`apps/web/src/lib/pdf/renderer/`). The gap analysis below was
>   written before those merges.

There are **two threads**:

- **Thread 1 — Bid Intelligence (the "AI edge no competitor can replicate").** Steve's strategic vision. **Mostly not built**, but the foundation it needs already exists, so a few pieces are surprisingly cheap. This is also the "lead-gen into sitelayer" funnel Steve described.
- **Thread 2 — Ops-platform completeness** (the merged platform). SiteLayer already covers ~80% of this. A handful of real gaps remain.

---

## Thread 1 — Bid Intelligence (highest leverage; mostly greenfield)

The 5 layers + 7 agents vs. what exists today:

| Vision piece                                                                                      | Status              | Existing foundation to reuse                                                                                                                                           | Gap to close                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **L1 Contextual onboarding** (company profile/voice from past quotes+jobs+win/loss)               | 🟡 partial          | `companies`, `pricing_profiles`, `ai_insights`, project history                                                                                                        | a `company_profiles` table (voice/vertical/pricing-logic) + an ingest pass                                      |
| **L2 Bid gen calibrated by loaded labor cost, in voice**                                          | 🟡 partial          | **loaded labor cost is already computed** (`labor-burden.ts`, `labor_payroll_runs`), pricing-chain resolver (`pricing.ts`), estimate gen, PDF, blueprint-vision/Claude | the "in the company's voice" composition step + RFP intake                                                      |
| **L3 Follow-up automation** (5+ paced sequence, in voice, cold-bid detect)                        | 🔴 missing          | notification workflow + deterministic-workflow pattern + estimate_push                                                                                                 | a `bid_follow_ups` table + paced workflow + voice drafts                                                        |
| **L4 Win/loss tracking** (reason, competitor, price gap, patterns)                                | 🔴 missing          | `project_lifecycle` has `declined`/`accepted` states; `audit_events`; bid-accuracy                                                                                     | a `bid_outcomes` table + capture UI + pattern inference                                                         |
| **L5 Pricing intelligence over time** (actual margins, "you lose 60% of $25K+ bids to X")         | 🟡 partial          | `bid-accuracy.ts`, labor/material actuals, `analytics.ts`, QBO costs                                                                                                   | cohort aggregation (win-rate × margin × vertical × competitor) + synthesis                                      |
| **Intake agent** (RFP→structured)                                                                 | 🔴 missing          | blueprint-vision (Claude Opus on PDF) is the exact pattern                                                                                                             | RFP-tuned prompt + a `POST …/rfp-intake` route                                                                  |
| **Context agent** (company profile, vector store)                                                 | 🔴 missing          | `ai_insights`; Postgres is available for pgvector                                                                                                                      | profile store + retrieval                                                                                       |
| **Pricing agent** (loaded cost via tool-call, margins, win-rate → range + confidence + citations) | 🟢 foundation ready | `pricing.ts` + `labor-burden.ts` already give the no-hallucination loaded cost; bid-accuracy gives margins                                                             | a recommendation endpoint that combines them + citation trail (this is Steve's "hallucination-resistance demo") |
| **Composition agent** (writes bid in voice)                                                       | 🟡 partial          | estimate PDF + Claude wired                                                                                                                                            | voice-context prompt + draft store                                                                              |
| **Win/Loss agent** (async, infers reasons, feeds back)                                            | 🔴 missing          | project-lifecycle workflow hook                                                                                                                                        | async task on `declined` → infer → write profile                                                                |
| **Follow-up agent**                                                                               | 🔴 missing          | (see L3)                                                                                                                                                               | (see L3)                                                                                                        |
| **Intelligence agent** (turn it into a strategic asset)                                           | 🔴 missing          | bid-accuracy + analytics + ai-insights                                                                                                                                 | weekly synthesis task                                                                                           |

**The cheap, high-impact sequence** (each reuses existing plumbing; this is the differentiator):

1. **Win/loss capture** — `bid_outcomes` table + a "mark won/lost + why/competitor/price-gap" UI on the project/estimate screen. Small. Unlocks L4 + feeds everything.
2. **Pricing-recommendation endpoint** — combine the _already-computed_ loaded labor cost + bid-accuracy margins + win-rate → a recommended range + confidence + **citation trail**. This is Steve's signature "no competitor can replicate / hallucination-resistant" demo, and most inputs already exist.
3. **Company-voice profile + voice-aware composition** — `company_profiles` seeded from past estimates/notes; inject into a Claude composition step so bids come out in the company's voice.
4. **Follow-up sequencing** — `bid_follow_ups` + a paced deterministic workflow (24-48h / 4-5d / 7-10d) drafting in voice; cold-bid detection.
5. **Intelligence synthesis** — weekly cohort job → "you lose 60% of $25K+ bids to Competitor X on price within 3 days" surfaced as an insight.

> Steve framed the bidding project as **"lead gen into sitelayer"** — these 5 can ship as a focused bid surface that funnels into the full platform.

---

## Thread 2 — Ops-platform gaps (SiteLayer already covers most)

**Already solid** (don't rebuild): takeoff + measurements + **assemblies**, estimates + customer portal, rental inventory (per-location, serialized, **cross-hire/re-rent**, damage/loss billing, multi-cycle rental billing → QBO), clock/schedules/daily-logs/CompanyCam, **payroll export (XLSX/Xero/Payworks/Gusto/ADP)**, QBO OAuth+invoice+estimate+TimeActivity, scaffold catalog+BOM(+approval).

**The 5 real gaps:**
| Gap | Status | Note |
|---|---|---|
| **3D scaffold designer + BOM-from-design** | 🔴 missing | The #1 Avontus-parity gap — sitelayer scaffold is inventory/ops, not _design_. Big (~weeks): a Three.js modeler → auto-BOM → load/bracing checks. |
| **BIM / DWG / Navisworks / viewer exports** | 🔴 missing | Depends on the designer. Post-MVP. |
| **Cost-code accounting** | 🟡 thin | No `cost_code` on measurements/estimate-lines/labor-entries (uses `service_item_code` as a proxy). Blocks true job-cost + QBO cost-code mapping. Small-medium, high value. |
| **Granular estimate-vs-actual / closeout** | 🟡 partial | `analytics` is division-level revenue/cost/margin; missing phase + cost-code variance, labor-rate variance, unbilled-hours scanner, closeout checklist. Medium. |
| **AI-takeoff review loop** | 🟡 stubbed | `blueprint-vision` calls Claude, and `ai_insights` has auto-count/scale/bookmark kinds, but the review→approve→apply UI loop isn't wired. Medium. |

Smaller: geofence _auto_ clock-in trigger (idle auto-clock-out already shipped this session), live crew map (schema ready, no map UI), backorders/purchase-orders, QR-label generation, recurring inspection scheduler.

---

## Recommendation

The **Bid-Intelligence thread is the real "more we can do"** — it's Steve's stated edge, it's a lead-gen funnel into sitelayer, and items 1–3 are cheap because the loaded-labor-cost + bid-accuracy + pricing-chain + Claude foundations already exist. The ops gaps are mostly polish except the 3D scaffold designer, which is a genuine multi-week effort and a separate decision.

Suggested first build: **win/loss capture → pricing-recommendation-with-citations → company-voice composition** (Bid-Intelligence items 1-3). That stands up the differentiated demo on top of what's already here, fastest.
