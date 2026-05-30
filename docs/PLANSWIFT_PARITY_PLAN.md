# PlanSwift Feature Parity in Sitelayer — Gap Analysis & Plan

**Status:** Planning / strategy doc
**Date:** 2026-05-30
**Scope:** What it would take to bring PlanSwift-class digital takeoff + estimating into Sitelayer.
**Audience:** Operator (Taylor), Steve, and the agent fleet.

> **One-line answer:** Sitelayer is *not* a blank slate. It already ships ~60–70% of PlanSwift's takeoff + estimating *core*, and it's cloud-native, mobile-first, and AI-capture-first — which is exactly where PlanSwift is weakest. "Matching PlanSwift" is therefore mostly a **gap-closing** exercise on five fronts (precision PDF drawing surface, CAD file support, a real parts/assembly library, reporting + Excel, and a plugin SDK), **not** a 2–4 year ground-up rebuild. With the agent fleet writing the code, the build is cheap and fast — the real timeline is set by your review cadence, UX-feel loops, and real-plan edge cases. Realistic wall-clock: **a usable MVP in ~2–3 weeks, credible parity in ~5–9 weeks** if you stay in the review loop daily (see §3). DWG is the only piece the fleet can't just build — defer it.

---

## 1. The starting point is much further along than "build PlanSwift"

The original framing ("$500K–$1.5M, 2–4 years to clone PlanSwift") assumes a greenfield build. That's not our situation. Sitelayer already has the load-bearing pieces that make takeoff hard:

| PlanSwift capability | Sitelayer today | Where |
| --- | --- | --- |
| Area takeoff (polygon → sq ft) | ✅ Shipped — shoelace area, board-space (0–100) coords | `apps/web/src/screens/projects/takeoff-canvas.tsx`; `packages/domain/src/index.ts:calculatePolygonArea` |
| Linear takeoff (length) | ✅ Shipped — segment-sum lineal tool | `takeoff-canvas.tsx` (`kind = 'lineal'`) |
| Count / point takeoff | ✅ Shipped — count tool (`kind = 'count'`) | `takeoff-canvas.tsx` |
| Page scaling / calibration | ✅ Shipped — known-dimension calibration → `worldPerBoardUnit` | `page-calibration-overlay.tsx`; `blueprint_pages.calibration_*` |
| Plan upload + storage + versioning | ✅ Shipped — PDF multipart streaming to DO Spaces, versioned | `apps/api/src/routes/blueprints.ts`, `blueprint-upload.ts` |
| Page rasterization | ✅ Server-side PDF→PNG exists | `apps/api/src/blueprint-rasterize.ts` |
| Multi-page navigation | ✅ Page strip / page browser | `page-strip.tsx` |
| Assemblies → material/labor/cost | 🟡 Partial — template-driven service items + markup engine | `packages/domain` (`ServiceItemTemplate`, `applyMarkup`, `LA_TEMPLATE`) |
| Waste factors | ✅ `material_waste_pct` in markup config | `packages/domain/src/markup.ts` |
| Markup / margin / burden | ✅ material waste, labor burden, profit margin, sub markup, freight | `packages/domain/src/markup.ts` |
| Cost codes / divisions | ✅ Division templates + MasterFormat/Uniformat codes | `DivisionTemplate`, `capture-schema` (`masterformatCode`/`uniformatCode`) |
| Audit trail (user + timestamp per edit) | ✅ Shipped — `audit_events` with actor/before/after/trace | `apps/api/src/mutation-tx.ts` |
| Estimate PDF export | ✅ Shipped — PDFKit | `apps/api/src/pdf.ts` |
| **AI Auto-Takeoff** (PlanSwift "Takeoff Boost™") | ✅ **Ahead** — 4 capture pipelines (blueprint vision via Claude Opus, RoomPlan, drone orthomosaic, photogrammetry) | `apps/api/src/takeoff-capture-pipelines/`, `packages/pipe-*` |
| 3D preview | ✅ **Ahead** — PlanSwift has none; Sitelayer renders Three.js | `takeoff-3d-scene.tsx`, `lib/takeoff/geometry-3d.ts` |
| Real-time / mobile / offline | ✅ **Ahead** — mobile-first SPA + IndexedDB offline queue + LWW | `apps/web` PWA, `lib/offline-queue.ts` |
| Multi-tenant + RBAC | ✅ Shipped — Clerk + Postgres RLS, per-company isolation | `apps/api/src/auth.ts`, `packages/domain/src/roles.ts` |

**Read this table the right way:** the things PlanSwift took ~20 years to grind out at the *data and workflow* layer (calibrated coordinate systems, quantity math, assemblies/markup, audit, storage) are largely present. What's missing is concentrated in the **precision drawing surface**, **file-format breadth**, **library depth**, and **output/integration** — plus the long tail of edge cases.

---

## 2. The real gaps (what PlanSwift has that we don't)

### Gap A — Precision drawing surface (the biggest UX gap)

PlanSwift's reputation is built on a fast, forgiving, mouse-driven measurement surface on top of a true PDF render. Sitelayer's canvas is a **mobile-first SVG overlay with 3 tools** (polygon / lineal / count) over a rasterized/thumbnail image — good for field use, thin for desktop estimating.

Missing tool-level features:
- **In-browser true PDF viewer** — we rasterize server-side and show images; there is **no `pdfjs-dist`** in the tree. Estimators expect crisp vector zoom, text selection, and snapping to the actual PDF geometry.
- **Cutouts / deduct areas** — subtract windows/doors/openings from a wall or floor area. No boolean geometry today (`calculatePolygonArea` is a single ring).
- **Arc / curved segments** — radiused walls, curved curbs. Polylines only today.
- **Segment / multi-segment paths with bends** — partially covered by lineal, but no per-segment editing/labeling.
- **Ortho mode + snapping** — snap to 90°, snap to existing vertices/CAD lines, snap-to-axis.
- **Freehand trace + smoothing.**
- **Pitch / slope and roof geometry** (hip/valley, pitch multiplier) — roofing math.
- **Box/marquee takeoff** — drag a rectangle to capture everything inside.
- **Rich edit affordances** — drag vertices, insert/delete points, undo/redo stack, on-canvas dimension labels ("12'-6\"").

**What it takes:** This is the single largest chunk. Swap the SVG-over-image overlay for a **PDF render layer + a vector interaction layer** (Konva or Fabric, or a hand-rolled canvas controller). Build the tool state machine (we already use XState — model tools/undo/snap there). Add boolean geometry (a small library like `polygon-clipping` for cutouts/union). Add arc + pitch math to `packages/domain`.

**Render-engine decision (settled — PDFium/EmbedPDF, copy `qedviz`, NOT pdfjs):** We have already fought and won this exact battle in `~/projects/qedviz`. **`pdfjs-dist` 4.x and 5.x both silently hung past page 1** in our setup — a hard dealbreaker for takeoff, where plan *sets are 20–80+ pages*. The proven answer is **PDFium WASM via `@embedpdf/engines` + `@embedpdf/pdfium`** (`createPdfiumDirectEngine`, "direct mode") — the same engine Chrome's built-in PDF viewer uses, a completely different rendering pipeline that does not hang. `~/projects/learn` kept only the *pdfjs subset* qedviz had already abandoned — do **not** use learn as the template; use **qedviz**.

The reference implementation to lift is `qedviz/client/src/features/pdf-reader/renderer/`:
- **`embedpdf.ts`** — the PDFium renderer. Renders each page to a `<canvas>` *we own* via `engine.renderPageRaw` → `putImageData` (standard RGBA, DPR-aware), with abort/cancel handling and rotated-text guards. The measurement overlay (sitelayer's existing SVG/vector tool layer) sits on top of that canvas. We never touch any prebuilt viewer UI, so the "PDF.js can't be customized" pain simply does not exist.
- **`types.ts`** — the `PdfRenderer` / `PdfDocument` interface seam. Engine is swappable without touching the tool layer. Already exposes everything §2-F wants for free: `getBookmarks` (→ Auto-Bookmark), `search`/`searchAllPages` streaming + `getPageText` (→ text-based scale detection from the title block), and `getPageSize` **in PDF points, top-left origin** — a clean, stable coordinate basis for calibration and measurement (better than rasterized board-space).
- **`index.ts`** — engine selector: PDFium default, pdfjs fallback via `localStorage["qedviz.pdf_renderer"] = "pdfjs"`. Keep the seam; keep pdfjs as the escape hatch only.

Licensing is clean: **PDFium is BSD-3** (Chromium), **@embedpdf is MIT** — no AGPL entanglement (this also retires the earlier MuPDF/Artifex suggestion; PDFium is both more robust *and* better-licensed). Deployment notes: bundle/self-host the `@embedpdf/pdfium/pdfium.wasm?url` asset; the impl re-packs pixel buffers into owned `ArrayBuffer`s so it runs **without** cross-origin isolation (no mandatory COOP/COEP), but if we later want threaded PDFium, qedviz already has `server/security-headers.ts` to model the headers on. Sitelayer's existing server-side rasterizer (`blueprint-rasterize.ts`) remains a fallback path for thumbnails / ultra-large sheets via tiled deep-zoom, behind the same seam.

**Effort:** ~**8–14 engineer-weeks** for a desktop-grade surface with cutouts, arcs, snapping, undo/redo, and dimension labels. The render foundation drops to ~**1 week** by lifting qedviz's `renderer/` module wholesale — the multi-page hang and the engine choice are already solved, so the remaining work is the *measurement tool layer*, not the PDF engine.

### Gap B — CAD / vendor file formats

PlanSwift opens `.PDF, .DWG, .DXF, .DWF, .TIF, .JPG, .PLN`. Sitelayer is **PDF + raster images** today.

- **DXF** is text-based and tractable (`dxf-parser` / `three-dxf` exist).
- **DWG** is proprietary and the genuinely hard one — realistically requires **licensing the Open Design Alliance (ODA / Teigha)** SDK or a hosted conversion service (e.g. CloudConvert, Autodesk Forge/APS). This is a **buy, not build** decision.
- **DWF / PLN** are niche; defer or convert.

**What it takes:** DXF import (own it, ~2 weeks). DWG via a licensed converter or APS conversion endpoint (~2–3 weeks integration + **ongoing license cost**). Treat DWG as a paid dependency, not a feature to write.
**Effort:** ~**4–6 engineer-weeks** + recurring SDK/API license. **Recommendation: defer DWG to a later phase** — most residential/sub-trade plans arrive as PDF, and that's our beachhead.

### Gap C — Parts / Assembly engine depth

PlanSwift's differentiator is **drag an assembly onto a takeoff and it explodes into material + labor + equipment + sub quantities with formulas and waste**. Sitelayer has the *bones* — `ServiceItemTemplate`, `DivisionTemplate`, `applyMarkup` with waste/burden/margin, MasterFormat/Uniformat codes — but **no user-editable parts library, no nested assemblies, and no custom-formula evaluator.**

**What it takes:**
1. Data model: `parts`, `assemblies`, `assembly_components` (a part or nested assembly, with qty-per-unit + waste). New migrations (immutable, numbered — see `docker/postgres/init/`).
2. A **formula evaluator** for item/assembly calcs (sandboxed expression engine — e.g. `expr-eval`) so users can write `area * 1.1 / 32` style logic, mirroring PlanSwift's custom formulas.
3. UI to build/manage the library and to drop an assembly onto a measurement (we already promote capture quantities → estimate line items; extend that path).
4. Trade **starter packs** (roofing, concrete, framing, EIFS/stucco, electrical, HVAC, plumbing) — seedable assembly libraries. These are *content*, not engineering, and are where Sitelayer's exterior-cladding focus already gives it a head start (`LA_TEMPLATE`, `LA_SERVICE_ITEMS`).

**Effort:** ~**6–10 engineer-weeks** for engine + UI; trade packs are ongoing content work (days each, per trade, ideally fleet-generated and SME-reviewed).

### Gap D — Reporting + Excel integration

PlanSwift ships a report suite (Summary, Customer Copy, RFQ, Cost-vs-Sell), **unlimited custom reports**, and a tight **bidirectional Excel link**. Sitelayer has estimate PDF + estimate share portal + payroll CSV exports — **no `xlsx`/`exceljs` in the tree**, no custom report builder.

**What it takes:**
- **Excel export** (own it quickly): add `exceljs`, map estimate/takeoff line items to a workbook. ~1 week.
- **Bidirectional / live cell linkage** (PlanSwift's signature): much harder and arguably the wrong bet for a web app. A cloud-native equivalent is **"open this estimate as a live Google Sheet / web grid"** rather than COM-automating desktop Excel. ~3–4 weeks if pursued; **recommend a web data-grid + Excel export instead of true two-way COM linkage.**
- **Custom report builder**: a column/template config over the existing estimate model. ~3–4 weeks.

**Effort:** ~**4–8 engineer-weeks** depending on how far the report builder goes. Quick win = Excel export in week 1.

### Gap E — Plugin SDK / extensibility

PlanSwift has an OLE/COM SDK + plugin store. Sitelayer has clean REST + workflow seams but no published external API surface or scripting host.

**What it takes:** Document and version a stable public API, add API keys/scopes (Clerk already gives us the auth substrate), and optionally a sandboxed scripting hook for custom assembly formulas (overlaps Gap C's evaluator). This is **low priority for parity** and high value only once there's a third-party ecosystem — defer.
**Effort:** ~**3–5 engineer-weeks** when it's actually warranted.

### Gap F — AI takeoff is already ahead, but the *review loop* is thin

PlanSwift's Takeoff Boost™ (Auto Takeoff, Auto Count, Auto Scale, Auto Bookmark) is bolted-on. Sitelayer's capture pipelines are **architecturally native** (one `TakeoffResult` contract, confidence scores, provenance, review floor). What's thin is the **human-in-the-loop review UI** — the screen where an estimator accepts/edits/promotes AI-proposed quantities. The contract enforces a `REVIEW_REQUIRED_CONFIDENCE_FLOOR = 0.7`; the UI to act on it needs polish.

Specific Boost-equivalents worth building, mapped to our advantage:
- **Auto Count** → reuse pipeline + an on-canvas "define once, find across pages" interaction. Medium.
- **Auto Scale** → infer scale from blueprint title-block / known symbols; we already parse architectural scale in `pipe-blueprint/dimensions.ts`. Medium.
- **Auto Bookmark** → read PDF embedded links / page labels into the page strip. Small.
- **Auto Takeoff** → already the headline capability; needs the review surface, not new ML.

**Effort:** ~**4–8 engineer-weeks**, mostly UI + targeted pipeline work — and this is where we *win*, not catch up.

---

## 3. Realistic timeline — agents build this, not human contractors

Engineer-weeks are the wrong unit. The fleet writes well-scoped React/TS/SQL into a repo that already has Vitest, Playwright E2E, deterministic XState workflows, a visual-regression harness, and a verified merge queue. **Producing the code is cheap and fast.** A PR-sized feature goes from prompt to a working, test-passing first draft in **minutes to ~an hour of agent time**, at near-zero marginal cost (subscription seats).

So the timeline is **not** gated by typing. It's gated by four things the fleet *cannot* compress:

1. **Dependency chains.** The PDFium render layer (lifted from qedviz) must land before the vector tools that sit on it; the assembly schema before the assembly UI. These are serial no matter how many agents you throw at them.
2. **Your review + merge cadence.** Every PR waits for you (or an SME) to look. This is the dominant variable. Daily engaged review → fast. Sporadic review → the calendar stretches linearly, regardless of how fast agents draft.
3. **UX feel loops.** A drawing surface either *feels* right under a mouse or it doesn't. That needs a human in the loop iterating — agents can implement and screenshot-verify (the statechart visual harness helps), but "does this snap/undo/drag feel like PlanSwift" is a judgment call, not a test.
4. **Real-plan edge cases.** Rotated PDFs, weird title blocks, 80-page sets, a deleted calibration. These surface only against real plans (`blueprints_sample/` is a start; pilot plans are the real test). This is a long tail you *discover*, not a task you schedule.

### Wall-clock estimate (assuming you stay in the review loop ~daily)

| Phase | Work units (≈PRs) | Agent build | Wall-clock — *bottleneck* |
| --- | --- | --- | --- |
| **0 — Quick wins** (Excel export, auto-bookmark, AI review-surface polish) | 3–5 | hours | **~3–6 days** — gated by your review, not the code |
| **1 — Desktop drawing surface** (PDFium/EmbedPDF layer from qedviz, vector tools, cutouts, arcs, snap, undo, dimension labels, auto-scale) | 10–18 | days of compute | **~2–4 weeks** — serial deps + UX feel loops are the long pole; render engine is already solved |
| **2 — Assembly engine + trade packs** (parts/assemblies schema, formula evaluator, drag-to-explode UI, cladding pack first) | 8–14 | days of compute | **~1.5–3 weeks** — mostly mechanical; SME validation of the math is the gate |
| **3 — Reporting + Auto-Count** (report builder, Excel-grade output, define-once-find-across-pages) | 6–10 | days of compute | **~1–2 weeks** |
| **Credible parity (Phases 0–3, DXF/PDF only)** | ~30–45 | — | **≈ 5–9 weeks wall-clock** |
| **MVP that's actually usable** (Phase 0 + the core of Phase 1) | ~12–18 | — | **≈ 2–3 weeks wall-clock** |

These are *calendar* weeks with the fleet running, not 40-hour engineer-weeks. The agent compute to write all of it is on the order of **days**, not months — the ~5–9 weeks is almost entirely review cadence + UX iteration + edge-case shakeout.

### What changes the number

- **You review daily and decisively** → the table holds (5–9 weeks).
- **You batch review weekly** → roughly double it; the queue sits waiting on you, not on agents.
- **You bring a real estimator (Steve / pilot) into the loop early** → Phase 1 UX and Phase 2 assembly math converge *faster*, because the expensive loop is "agent guesses what an estimator wants → you find out it's wrong weeks later." Front-load that feedback.
- **DWG** is the one thing the fleet can't just build — it needs a licensed ODA/APS converter (paid, recurring). It's not on the parity critical path; **defer it.**

**The honest risk isn't build time — it's the edge-case tail.** PlanSwift fixed 20 years of rotated-PDF / bad-layer / lost-calibration bugs one paying customer at a time. The fleet closes the *feature* gap in weeks; the *robustness* gap closes only as real plans flow through. Plan for a steady hardening drip after Phase 1 ships, driven by pilot usage — not a finish line.

---

## 4. Recommended sequencing

**Don't clone PlanSwift feature-for-feature.** Lean into Sitelayer's structural advantages (cloud, mobile, offline, AI-capture-native, QBO-integrated) and close only the gaps that block real estimating work.

### Phase 0 — Quick wins (1–2 weeks)
- Excel export of estimate + takeoff line items (`exceljs`). Immediate PlanSwift-parity talking point.
- Auto-Bookmark from PDF page labels/links into the page strip.
- Polish the AI capture **review surface** (act on the 0.7 confidence floor): accept / edit / promote proposed quantities.

### Phase 1 — Desktop-grade drawing surface (6–10 weeks) ← the MVP that matters
- PDFium/EmbedPDF render layer (lifted from qedviz) + vector interaction layer over it (keep the mobile SVG path for field). **Not** pdfjs — it hangs past page 1 on multi-page sets (see §2-A).
- Cutouts/deduct areas (boolean geometry), arcs, ortho + vertex snapping, undo/redo, on-canvas dimension labels.
- Auto-Scale from title-block/known symbols (build on `pipe-blueprint/dimensions.ts`).
- Box/marquee takeoff.

### Phase 2 — Assembly engine + trade packs (6–10 weeks)
- `parts` / `assemblies` / `assembly_components` model + sandboxed formula evaluator.
- Drag-assembly-onto-measurement → explode into material/labor/equipment/sub with waste (reuse `applyMarkup`).
- Seed exterior-cladding pack first (our wedge), then roofing/concrete/framing.

### Phase 3 — Reporting + AI Boost depth (4–8 weeks)
- Custom report builder (Summary / Customer Copy / RFQ / Cost-vs-Sell templates over the estimate model).
- Auto Count ("define once, find across pages").

### Phase 4 — Format breadth + extensibility (as warranted)
- DXF import (own it). DWG via licensed ODA/APS conversion (paid, deferred).
- Public API + keys; scripting host only if a third-party ecosystem materializes.

---

## 5. Where Sitelayer already *beats* PlanSwift (lead with these)

PlanSwift's weaknesses are Sitelayer's defaults — this is the strategic point, and it inverts the "they have a 20-year head start" anxiety:

- **Cloud-native + real mobile + offline-first.** PlanSwift is Windows-only desktop with no real-time collaboration. Sitelayer is a mobile-first PWA with an IndexedDB offline queue and LWW sync — field-to-office in one app.
- **AI capture is native, not bolted-on.** One `TakeoffResult` contract spanning blueprint-vision, RoomPlan, drone, and photogrammetry — beyond PlanSwift's Takeoff Boost™, which only does the 2D plan.
- **3D preview.** PlanSwift can't; Sitelayer renders measurements in Three.js.
- **End-to-end ops, not just takeoff.** Estimate → crew schedule → labor/clock → QBO sync → closeout already exist. PlanSwift stops at the estimate and hands off.
- **Modern UX vs. a 2007 Ribbon Bar**, and subscription pricing without the desktop-license baggage that drew Reddit backlash.

**Strategic recommendation:** position Sitelayer as **"PlanSwift-class takeoff inside a full cloud construction-ops platform, with AI capture the desktop tools can't do"** — and build a *narrower, better* takeoff surface for the exterior-cladding wedge first, rather than a general-purpose clone. Phase 1 (desktop drawing surface) is the only place we genuinely trail; everything else is either present, ahead, or content.

---

## 6. Open questions before committing build time

1. **Who's the user of the desktop surface?** If pilots estimate primarily on the plan PDF at a desk, Phase 1 is the priority. If they're field-first, Phase 0 + AI review loop may deliver more value sooner.
2. **DWG demand — real or assumed?** Confirm whether target customers actually send DWG/DXF or just PDF. This decides whether Gap B is ever worth the license.
3. **Excel: export-only, or do customers truly want PlanSwift's live two-way link?** Strongly suspect export-only + a web grid is enough.
4. **Assembly library ownership** — do we seed/maintain trade packs ourselves (fleet-generated + SME-reviewed), or let customers build their own? Affects Phase 2 scope.
5. **How much of A/C/D do we hand to the fleet vs. hand-build?** Most of it is fleet-suitable; the gating resource is operator/SME review, not engineering hours.

---

### Appendix — Key files referenced
- Canvas / tools: `apps/web/src/screens/projects/takeoff-canvas.tsx`
- Geometry + quantity math: `packages/domain/src/index.ts` (`calculatePolygonArea`, `calculateTakeoffQuantity`)
- Markup / waste / margin: `packages/domain/src/markup.ts`
- Calibration: `apps/web/src/screens/projects/page-calibration-overlay.tsx`, `blueprint_pages.calibration_*`
- Capture contract: `packages/capture-schema/src/takeoff.ts` (`TakeoffResult`, `REVIEW_REQUIRED_CONFIDENCE_FLOOR`)
- Capture pipelines: `apps/api/src/takeoff-capture-pipelines/`, `packages/pipe-blueprint|roomplan|drone|photogrammetry`
- 3D preview: `apps/web/src/screens/projects/takeoff-3d-scene.tsx`, `apps/web/src/lib/takeoff/geometry-3d.ts`
- Blueprint upload/raster: `apps/api/src/routes/blueprints.ts`, `apps/api/src/blueprint-rasterize.ts`
- Estimate PDF: `apps/api/src/pdf.ts`
- Audit/mutation: `apps/api/src/mutation-tx.ts`
- Schema migrations (immutable): `docker/postgres/init/`
