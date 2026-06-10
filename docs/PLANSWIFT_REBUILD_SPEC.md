# PlanSwift: Full Capability Spec + SiteLayer Rebuild Plan

**Audience:** Developer building the takeoff/estimating module into SiteLayer (PWA).
**Purpose:** (1) Document everything PlanSwift does, with the *why* behind each capability. (2) Specify what to actually rebuild — separating the core engine from legacy desktop artifacts. (3) Set the modern bar so we don't ship a 2010 product in 2026.

---

## 0. How to read this document (read this first)

Two things to get straight before any code:

**We are not cloning PlanSwift 1:1.** PlanSwift is a ~15-year-old Windows/.NET/COM desktop application. A large fraction of its feature surface exists *because* it's a native desktop app (digitizer-tablet integration, OLE/COM Excel live-linking, ribbon-bar UI chrome, per-machine license check-in/out, local `data.xml` storages). Porting those into a PWA is wasted effort that bakes desktop assumptions into a web product. We rebuild the **takeoff + estimating engine** — the part that turns plans into measured quantities and quantities into priced estimates — and re-architect everything around it for web/offline/sync.

**The bar is no longer PlanSwift.** In 2026 the relevant competitors (Togal.AI, Kreo, STACK AI Assist) auto-detect and measure walls, rooms, doors, windows, and areas with computer vision — users report the AI completing ~80% of a takeoff with the estimator reviewing the rest, and Togal claims ~98% accuracy on architectural floor plans. PlanSwift's manual point-and-click is now the *floor*, not the target. SiteLayer already has an AI-layer brief; the takeoff module should treat AI-assisted measurement as a first-class feature, not a v2 bolt-on. If we ship pure manual takeoff, we ship something that was competitive in 2012.

**Anchor-customer bias toward exterior envelope.** L&A is an exterior-systems contractor (siding, cladding, EIFS/panels, roofing, trim/flashing). That workload is dominated by **area** (wall and roof faces), **linear** (trim, edge metal, fascia, flashing, starter, J-channel), and **count** (openings to deduct, penetrations). It needs **pitch-corrected area** (plan area → true sloped surface area) badly. We should build the engine to be trade-agnostic but ship an opinionated exterior-envelope template/assembly pack first, rather than trying to serve all 13 trades on day one.

---

## 1. What PlanSwift is and why it exists

### The problem it solves
A construction estimate starts with a **quantity takeoff (QTO):** measuring, from the drawings, every quantity needed to build the job — square footage of wall, linear feet of trim, count of fixtures, cubic yards of concrete. Historically this was done by hand with a scale ruler and a highlighter on paper plans. That process is slow and error-prone ("scale fatigue" — misreading the ruler after hours of counting), and quantity errors flow straight into the bid, so a takeoff mistake is a money mistake.

### What PlanSwift does about it
PlanSwift is **digital takeoff + estimating software.** You load the plans on screen, calibrate the scale once, then measure by clicking directly on the drawing. Measurements convert to real-world quantities automatically, and those quantities drive a cost estimate via **assemblies** (bundles of material + labor + waste + markup). Core value props, in the vendor's own framing: "if it's colored, it's counted," drag-and-drop assemblies onto measured items, instant cost recalculation, export to Excel or built-in reports.

### Where it sits in the workflow
`Plans (PDF/image/CAD) → Takeoff (measure quantities) → Assemblies (attach cost logic) → Estimate (rolled-up priced bid) → Export/Report (Excel, PDF, RFQ)`

This is exactly the front half of SiteLayer's bid lifecycle. The takeoff/estimate output should drop into SiteLayer's existing bid states rather than being a standalone island.

### Commercial context (informs our pricing/positioning later)
- ~$1,749–$2,000/user/year subscription; historically sold as a ~$1,595 one-time "lifetime" license + ~$250/yr support.
- Windows desktop only; cloud storage limited to ~30 days. No real-time multi-user collaboration — a structural weakness we can beat by being cloud-native.
- Trade-specific capability sold as paid **plugins/starter packs** (earthwork, electrical, roofing, etc.).
- Common user complaints: slows down / crashes on large plan sets (risk of lost work), steep-ish learning curve, mixed support. These are the gaps to exploit.

---

## 2. Complete capability inventory ("everything it can do")

This is the full functional surface, grouped. Each group notes **what** it does and **why** it matters. Build/cut/replace decisions are in Part 4.

### 2.1 Takeoff engine (the core)
The measurement primitives. Each measured thing is a **takeoff item** carrying geometry + properties.

- **Area takeoff** — draw a polygon over a region; computes square footage/area. Supports **deductions/cutouts** (subtract window/door/opening polygons from a wall area). Critical primitive.
- **Linear takeoff** — draw a polyline; computes length. "Separate linear takeoff items," custom line widths. Used for trim, flashing, conduit, wiring, perimeters.
- **Count takeoff** — click to place point markers; computes count. Includes **Auto Count** (detect repeated symbols), **labeled point counts**, **scaled point counts**, and **custom point-count symbols**.
- **Segment/volume** — linear with depth/section → cubic yards (concrete, earthwork).
- **Pitch / roof tools** — **Pitch Calculator**, **Hip & Valley Calculator**, **Calculate Roof Areas**, slope/angle measurement. Converts plan (flat) area to true sloped surface area. Essential for roofing and exterior.
- **Geometry helpers** — **Arc tool** (radiuses), **Triangulate tool**, **Box takeoff mode**, **Ortho mode** (constrain to horizontal/vertical), **snap to CAD lines**, **snap to axis**, **free-hand drawing**, **advanced Joist tool**, **Beam tool**.
- **Editing** — undo, easily adjust/move takeoff items, copy/paste items, multiple measurements, multi-select.
- **Visual encoding** — hatch patterns, custom line widths/colors, labels on items, on-screen magnifier during takeoff, "mouse hints" prompting next action.
- **Scale / calibration** — intuitive page scaling with named ratios (1/8″ = 1′, etc.) *or* calibrate by drawing a known dimension. Per-page scale. (When calibrated correctly the measurement is mathematically exact — the whole accuracy claim rests on calibration being right.)
- **Audit trail** — timestamp + username per change.

### 2.2 Estimating engine
Turns measured quantities into priced output.

- **Parts** — atomic priced items (a material or labor line) with cost, unit, item number, cost code.
- **Assemblies** — bundles of parts + waste + labor that you **drag-and-drop onto a takeoff item**; quantity flows from the item's measurement into the assembly, which computes material/labor/waste/tax instantly.
- **Custom formulas** — user-defined formulas drive quantities (e.g., studs = wall length × spacing factor; sheets = area ÷ coverage × waste). This is effectively a spreadsheet formula layer.
- **Costing** — material, labor, equipment, subcontract, taxes, markup %, manual adjustments, cost-vs-sell.
- **Data sources** — import Excel items, link to database lists, supports product item numbers and cost codes.
- **Instant recalculation** — change a unit cost, everything downstream updates.

### 2.3 Plan / document handling
- **Formats** — PDF, image (scanned plans), DWG/CAD. Vector and raster.
- **Multi-page plan sets** — view/take off across many pages; folder structure for pages; tabbed browsing; page search; bookmarks.
- **Overlay / revision compare** — overlay two drawing versions to find changes between revisions (manual in PlanSwift; AI-automatic in modern tools).
- **Markup/annotation** — notes, annotations, legends, hyperlinks (to pages, URLs, or other items).
- **Import from planrooms** — pull drawings from online plan rooms.

### 2.4 Project organization
Every takeoff item can be tagged/grouped by **Division, Phase, Location, Zone, Folder**. This is what makes a 500-line estimate navigable and lets reports roll up by any axis. Don't skip this — it's load-bearing for real estimates.

### 2.5 Navigation & UI (mostly desktop-era — see cut list)
Ribbon bar (MS Office 2007 style), overview/minimap window, customizable toolbars, color themes, mouse-wheel zoom, hover-navigation, quick pan (right mouse), adjustable pan/zoom speed, forward/back like a browser, "jump to item on plan from estimate," customizable hotkeys, quick command search.

### 2.6 Reporting
Built-in reports by Division, Location, Folder, Phase, Material, Labor, Equipment, Subcontract, Markup, Cost-vs-Sell, Summary, Customer Copy, Request-for-Quote. **Unlimited custom reports.** Export report → Excel; print → PDF.

### 2.7 Integration
- **Excel** — export, *and* a "live link" that writes takeoff quantities into your existing Excel estimating spreadsheet in real time as you click (desktop OLE mechanism).
- **Estimating/ERP** — MC2, Sage 100/300 (Master Builder/Timberline), Alliance Millsoft, Turbo Bid, ProjectPAK, etc.
- **Point-of-sale export.**
- **Plugin store + SDK** — third parties build trade packs and ERP connectors (see §3).

### 2.8 Deployment / licensing / storage (desktop concerns — mostly N/A for us)
Windows install (.NET Framework dependency), online activation, web-based license management, license auto-release on exit, offline mode, license check-in/out per machine. Jobs stored on local/network/removable drives via **"Storages"**; 30-day free cloud storage; copy/move jobs between storages.

---

## 3. Original architecture (so we understand the data model we're re-deriving)

You don't need to replicate this, but understanding it tells you *what data PlanSwift actually models*, which is the real prize.

- **Platform:** Windows desktop, .NET Framework, **COM**-based object model. Plugins are .NET assemblies (or standalone EXEs) that talk to PlanSwift via COM interop. (Reference: third-party ERP connectors were built as standalone .NET processes accessing PlanSwift COM objects through Win32 APIs and bridging to REST.)
- **Data store:** XML. Each job persists to a **`data.xml`**. The vendor's own note: *every object* — page, bookmark, area, linear, count, template — has its own XML property bag, so plugins can "piggyback" arbitrary tagged data onto any object. This is the key insight: **PlanSwift is a tree of typed objects, each with an extensible property bag.**
- **Object tree (the back end, exposed via the "Under-The-Hood" tab):**
  ```
  PlanSwift (root)
   └─ Job (the active job)
       ├─ Pages        (plan pages; add a page on the back end → it appears in the UI)
       ├─ Takeoff      (the measured items — areas, linears, counts…)
       ├─ Bookmarks
       └─ Storages     (where templates/parts/assemblies live; Local + network paths)
  ```
  The UI is just a projection of this tree; writes to the tree update the screens. `item.fullpath` addresses any node; storages can live on a LAN.
- **"Storages" concept:** templates, parts, and assemblies are stored independently of jobs and can be local, on a network share, in a DB, or in XML — so cost libraries are reusable across jobs.
- **SDK:** publicly there are old SDK example repos (PlanSwift 9, circa 2008–2010) on GitHub and developer docs ("much of which is coming soon"). The plugin model is mature but dated.

**Takeaway for us:** the data model we need is essentially *Job → Pages → TakeoffItems(typed, with geometry + property bag) + reusable Parts/Assemblies/Templates library.* We'll model that natively (relational + JSON columns) instead of an XML tree, but the shape carries over directly.

---

## 4. SiteLayer rebuild spec

Scope decision baked in here: **rebuild the engine, re-architect for cloud/offline/web, add AI-assist, drop the desktop-isms.** Module by module.

### 4.1 The hard part, stated plainly: the browser plan canvas
This is the make-or-break component and where most of the engineering risk lives. Everything else is CRUD + math.

**Requirements:**
- Render large multi-page PDFs and high-res scanned images smoothly in the browser, including 100+ MB plan sets, with pan/zoom that doesn't choke (the #1 PlanSwift complaint is large-set slowdown — we must beat it).
- Support both **vector PDFs** (CAD-exported — we can extract real geometry and snap to it / enable AI auto-detect) and **raster** (scanned — pixels only, manual or vision-model measurement).
- Overlay an editable **vector layer** of takeoff items (polygons, polylines, points) that stays registered to the plan through zoom/pan and survives page changes.
- Hit-testing, selection, vertex editing, snapping (to CAD lines, to axis/ortho, to existing vertices).

**Recommended approach:**
- **Rendering:** `PDF.js` (Mozilla) to rasterize PDF pages to canvas tiles; for vector PDFs, use PDF.js `getOperatorList()` to pull vector path geometry (enables snap-to-geometry and feeds the AI/auto-detect path). Tile + virtualize for large pages; render at device-pixel-ratio for crisp lines. Consider `pdfium` (WASM) as a fallback renderer if PDF.js struggles on specific files.
- **Measurement/overlay layer:** a dedicated canvas (Konva.js or a custom canvas2D/WebGL renderer) on top of the plan raster. **Don't use a giant SVG DOM for items** — it dies on big takeoffs. Keep items as plain data; redraw the canvas from state. Use `requestAnimationFrame` and dirty-rect redraws.
- **Coordinate system:** store all geometry in **real-world units** (feet/meters) per page, derived from the page's scale calibration — *not* in pixels. Render transforms pixels↔world. This makes measurements resolution-independent and makes re-render on zoom trivial.
- **Offline-first:** plan files cached in the browser (Cache Storage / IndexedDB) so the PWA works on a job site with no signal; takeoff state in IndexedDB with background sync to the backend.

If you build nothing else well, build this well.

### 4.2 Scale calibration
- Per page. Two paths: (a) pick a named ratio (1/8″=1′, 1:50, etc.); (b) **calibrate** — user draws a line on a known dimension and types the real length; we compute units-per-pixel.
- For vector PDFs, attempt to read embedded real-world coordinates/units and pre-fill calibration; always let the user confirm/override (their accuracy claim and ours both live or die here).
- Store `scale` and `unit` on the page object. Warn loudly if a page is uncalibrated before any measurement is trusted.

### 4.3 Measurement math (the geometry kernel)
Pure functions, fully unit-tested, framework-agnostic. Use `turf.js` where it fits, custom where it doesn't.
- **Area:** shoelace formula on the polygon (in world units). Subtract child cutout polygons.
- **Linear:** sum of segment lengths along the polyline; expose perimeter for closed shapes.
- **Count:** length of point array.
- **Volume/segment:** area × depth, or linear × cross-section.
- **Pitch correction (priority for exterior/roofing):** true surface area = plan area × slope factor, where slope factor = √(rise² + run²)/run (e.g., 6/12 pitch → ×1.118). Expose pitch as a property on roof/wall area items; recompute true area automatically. Hip/valley length helpers.
- **Arcs/radius:** support arc segments in polylines (center+radius+sweep) for curved walls/edges.
- Snapping helpers: snap-to-vertex, snap-to-axis (ortho), snap-to-vector-geometry (vector PDFs only).

### 4.4 Data model (native, not XML tree)
Carry over PlanSwift's shape into relational + JSON. Indicative schema:

```
Project ─┐
         ├─ PlanSet ──┬─ Page (file_ref, page_no, scale, unit, calibration)
         │            └─ ...
         ├─ TakeoffItem
         │     id, page_id, type {area|linear|count|segment}
         │     geometry (JSON: world-unit coords; cutouts as child polys)
         │     computed {length, area, count, volume, true_area}
         │     assembly_id (nullable)
         │     tags {division, phase, location, zone, folder}
         │     style {color, hatch, line_width, label}
         │     audit {created_by, created_at, updated_by, updated_at}
         │     props (JSON property bag — the PlanSwift extensibility trick; keep it)
         │
         └─ EstimateLine (derived; see 4.5)

Library (reusable across projects — PlanSwift "Storages"):
  Part        id, name, item_no, cost_code, unit, unit_cost, type {material|labor|equipment|sub}
  Assembly    id, name, components[] {part_id, formula, waste_pct}
  Template    id, name, default tags/styles
  CostBook    versioned price lists
```

Keep the **`props` JSON bag** on items — it's how PlanSwift let plugins extend objects without schema changes, and we'll want the same for AI metadata (confidence scores, source = AI|manual), trade packs, and SiteLayer-specific fields.

### 4.5 Assemblies + formula engine (the estimating core)
- An **assembly** attaches to a takeoff item; the item's measured quantity becomes the driving variable.
- Each assembly component computes a quantity via a **formula** referencing the item's measurements and named variables (e.g. `ceil(AREA / SHEET_COVERAGE) * (1 + WASTE)`).
- **Do not use `eval()`.** Use a sandboxed expression evaluator — `mathjs` or `expr-eval` — with a whitelisted variable/function set. This is a security-critical boundary (formulas may be user/library-authored).
- Variables available to formulas: `AREA, TRUE_AREA, LENGTH, PERIMETER, COUNT, VOLUME, PITCH`, plus assembly-level constants (coverage, spacing, waste %, labor rate).
- Output per component: quantity, material cost, labor cost/hours, waste, tax. Roll up to item, then to estimate.
- **Instant recalc:** changing a unit cost or formula constant recomputes downstream reactively. Model the estimate as derived state, not stored totals.

### 4.6 Estimate + reporting + export
- **Estimate view:** all lines, grouped/rolled up by any tag axis (division/phase/location/zone/material/labor). Cost-vs-sell, markup %, manual adjustments, taxes — same rollup categories PlanSwift reports on.
- **Reports:** the PlanSwift report set is a good starting menu (Division, Material, Labor, Equipment, Sub, Markup, Cost-vs-Sell, Summary, Customer Copy, RFQ). Generate as on-screen views + PDF + Excel export.
- **Excel:** export `.xlsx` (SheetJS). **Skip the desktop "live link"** (OLE writing into a running Excel instance) — it's a Windows hack. Replace with: native estimate sheet in-app + clean `.xlsx`/CSV export + (later) an API so external sheets can pull.
- **SiteLayer integration:** the finished estimate is an artifact in SiteLayer's bid lifecycle — it should populate a bid's line items and totals and move with the bid's won/lost/revision states, not live in a silo.

### 4.7 AI-first takeoff (the core product, not a bolt-on)
**Locked decision: AI-first from the start.** The primary workflow is *review-and-correct AI-proposed items*, not draw-from-scratch. Manual drawing tools still exist (for non-standard plans, fixes, and items the AI misses) but they are the fallback, not the default path.

**Critical framing — AI-first does NOT mean "build the model first."** The plan canvas, geometry kernel, and editable-item model (§4.1, §4.3, §4.4) are still built first, because the AI's output has to land somewhere reviewable and correctable. A proposed item is just a `TakeoffItem` with `source = AI` and a confidence score; the estimator accepts/edits/rejects it on the same canvas a manual item would live on. Build the place the answers land before building the thing that produces them.

**Two ingestion pipelines (because input is mixed vector + scans), converging on the same `TakeoffItem` output.** They are not equally hard; sequence accordingly.

- **Vector-PDF pipeline (ship first — fast, accurate, "AI-first on day one"):** vector PDFs carry real geometry (paths, text, embedded coordinates). The work is *parse → classify → snap*: extract the vector layer (PDF.js `getOperatorList`), classify runs as walls / roof edges / openings / trim, and emit precise takeoff items snapped to true geometry. **Area-accurate by construction** (measuring real geometry, not guessing pixel boundaries). Largely deterministic geometry + lightweight classification — minimal/no model training to get value. This is what makes the Kavi demo land.
- **Scan/raster pipeline (the ML-heavy parallel track):** scans are pure pixels — needs a real computer-vision detection/segmentation model. Lower out-of-box accuracy (~85–90%, improving on your plan types), more human correction, and pre-processing: **deskew, denoise, and OCR the title block.** Note: **scale cannot be read from a scan** — calibration is manual (draw-a-known-dimension) or vision-inferred from a dimension string/scale bar, and must be confirmed before any quantity is trusted. Let this track mature behind the vector demo; don't block launch on it.
- Both pipelines emit identical `TakeoffItem`s, so the canvas, review UI, assemblies, and estimate layers are pipeline-agnostic. Mark every AI item with `source`, `confidence`, and `pipeline` in the `props` bag so review/QA is filterable ("show me everything below 0.8 confidence").

**Model strategy:** for precise area/linear (which drive material cost), boundaries must be geometry-accurate — a vision-language model alone will classify and locate but won't give you trustworthy polygon areas. Use VLM/classification for *what it is* and classical CV / vector geometry for *exactly where its edges are*. Reuse SiteLayer's existing AI layer; don't stand up a parallel stack.

**The correction flywheel (highest-leverage non-obvious decision — build it in from commit one):** every estimator correction is training data. Log the delta between AI-proposed and human-final geometry/classification from the very first version. Togal didn't launch at 98% — it got there on user corrections. Without the capture loop, the AI never improves on *your* plan types and there's no moat; with it, accuracy compounds on exactly the work you do most (exterior envelope). Extend the `props` bag to store the original AI proposal alongside the human-final state for every edited item.

**Revision compare (fast-follow):** auto-diff two plan versions and highlight changed scope; manual overlay is the fallback. High value for change orders. Build after both ingestion pipelines are stable.

**Always human-in-the-loop. Never auto-submit an AI estimate.**

### 4.8 Collaboration / cloud (free win over PlanSwift)
PlanSwift has no real-time multi-user takeoff and only 30-day cloud storage. Being cloud-native with multi-user, persistent storage, and an audit trail is a structural advantage — design for it from the start (per-item audit fields are already in the model). Real-time co-editing (CRDT/OT) is a nice-to-have, not v1; multi-user with last-write-wins + locking is fine initially.

### 4.9 Explicit cut list (do NOT rebuild)
- Digitizer-tablet hardware integration (paper-plan-on-a-tablet era).
- COM/OLE Excel "live link."
- Ribbon-bar UI chrome, color themes, customizable toolbars (build a modern web UI instead).
- Per-machine license check-in/out, offline activation, "Storages on a network share" (replaced by cloud accounts + offline PWA cache).
- The desktop plugin SDK / COM plugin model (replace with a clean web API + trade-pack data, if we want an ecosystem later).
- Legacy ERP connectors (Sage Timberline, MC2, etc.) — only build integrations you actually need.

### 4.10 Suggested phasing (AI-first)
1. **Foundation — plan canvas + calibration + geometry kernel + editable `TakeoffItem` model + manual area/linear/count.** This is where AI output will land, so it comes first even in an AI-first build. Manual tools double as the correction UI. *(Useful to L&A for envelope area/linear on its own.)*
2. **Vector-PDF AI pipeline** (parse → classify → snap → propose items) **+ the correction-capture loop wired in from this step.** This is the AI-first demo: estimator reviews/corrects AI-proposed envelope items on vector plans. Add pitch correction + cutouts + organization tags here so it does *real* exterior takeoff.
3. **Parts/assemblies/formula engine + estimate rollup + Excel/PDF export.** Now it produces priced bids from AI-proposed quantities.
4. **SiteLayer bid-lifecycle integration.** Estimate flows into the bid (states, won/lost, revisions).
5. **Scan/raster AI pipeline** (deskew/denoise/OCR + vision detection model + vision-inferred calibration). Brings AI-first to scanned plan sets; matured on the correction data captured since step 2.
6. **Revision compare** (auto-diff versions) **+ multi-user/collaboration hardening + reporting depth + trade packs beyond exterior.**

### 4.11 Recommended stack summary
| Concern | Recommendation |
|---|---|
| PDF render | PDF.js (rasterize + vector op-list); pdfium-wasm fallback |
| Takeoff overlay | Canvas (Konva.js or custom canvas/WebGL); **not** SVG DOM at scale |
| Geometry math | turf.js + custom kernel (shoelace, pitch, arcs), fully unit-tested |
| Formula eval | mathjs / expr-eval, **sandboxed** (no `eval`) |
| State | Coords in world units; estimate as derived/reactive state |
| Offline | IndexedDB + Cache Storage; background sync (it's a PWA) |
| Backend | Postgres (relational + JSONB property bags); object storage for plan files |
| AI | Two pipelines → one `TakeoffItem`: **vector** (PDF.js op-list parse + classify + snap, geometry-accurate, ship first) and **scan** (deskew/OCR + CV detection model, fast-follow). VLM for classification, classical CV/geometry for edges. Reuse SiteLayer AI layer. Capture AI-vs-human correction deltas from commit one. |
| Export | SheetJS (xlsx), PDF report generator |

---

## 5. IP / legal note (brief, not legal advice — confirm with counsel)
Functionality and ideas aren't copyrightable; reimplementing PlanSwift's *features* (digital takeoff, assemblies, the report set) in your own clean code is generally fine and common in this market. What you must **not** do: copy their source code or assets, replicate their branding/trade dress, or reverse-engineer and import their proprietary file formats in violation of the EULA. Build clean-room from the functional description in this doc, not from their binaries. Get a real opinion before launch.

---

## 6. Decisions (locked) + remaining confirmations
Decisions 1–4 are **locked** per product owner. Item 5 still needs a call.

1. **Scope — LOCKED:** engine-for-web rebuilt into SiteLayer's bid lifecycle. Drop the desktop-isms (see cut list §4.9). No 1:1 desktop parity.
2. **First trade target — LOCKED:** exterior envelope (L&A) first; trade-agnostic engine underneath; other trade packs later.
3. **AI — LOCKED: AI-first from the start** (see §4.7). Review-and-correct AI output is the default workflow; manual is the fallback. Canvas/kernel still built first as the surface AI output lands on.
4. **Input — LOCKED: mixed vector + scans.** Two pipelines (§4.7). Vector ships first (geometry-accurate, fast); scan/vision pipeline is the parallel ML track. Correction-capture loop required from commit one.
5. **Collaboration — TO CONFIRM:** default is cloud-native, multi-user with locking in v1; real-time co-edit later. Confirm whether concurrent multi-estimator editing on the same plan is a launch requirement (it pushes toward CRDT/OT earlier and is non-trivial).

---

*Sources for factual claims about PlanSwift (features, architecture, pricing, competitive landscape): PlanSwift.com feature/pricing pages and ConstructConnect docs; PlanSwift developer/knowledge-base material on the COM/XML object model and "Storages"; Capterra/SoftwareAdvice/G2 for pricing and reviews; 2026 AI-takeoff comparisons (Togal.AI, Kreo, STACK). Engineering recommendations (stack, data model, phasing) are mine and open to debate.*
