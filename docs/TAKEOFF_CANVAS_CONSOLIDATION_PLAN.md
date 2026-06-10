# Takeoff Canvas Consolidation & UX Plan

**Status:** Approved direction (consolidate). Planning only — no canvas code changed yet.
**Author:** agent session, 2026-06-09
**Scope:** the two parallel takeoff/canvas surfaces in `apps/web/`
**North star:** [`docs/PLANSWIFT_REBUILD_SPEC.md`](./PLANSWIFT_REBUILD_SPEC.md) (owner-provided) —
AI-first takeoff/estimating built on a single canvas. This consolidation is **step 1**
of that spec (build the surface AI output lands on, before the thing that produces it). See §5.

---

## 0. Problem statement

There are **two live, independently-navigable takeoff surfaces**, and which one a
user lands on depends on which screen cluster linked them there — not on their
persona or device:

| | **est-canvas** (Phase C) | **v1 `projects/takeoff-canvas`** |
| --- | --- | --- |
| Editor file | `screens/desktop/est-canvas.tsx` → `est-canvas/{desktop,mobile}-body.tsx` | `screens/projects/takeoff-canvas.tsx` |
| Desktop route | `/desktop/canvas/:id` | — |
| Mobile route | `/projects/:id/takeoff-mobile` | `/projects/:id/takeoff-canvas` |
| List screen | `screens/mobile/takeoff-list.tsx` | `screens/projects/takeoff-list.tsx` |
| Editor strength | **Strong** (snapping, pan/zoom, arc/rect, calibration, pitch, deduction, marquee, vertex edit, copy/array/mirror, conditions, assemblies, running totals, undo/redo, XState machine) | **Thin** (polygon/lineal/count, button zoom, single undo) |
| Capture/AI/IA strength | **None** | **Strong** (4 capture pipelines, AI quantity-review panel, multi-page page-strip, per-page calibration overlay, elevation tags, multi-condition tag sheet, revision compare, photo-measure) |

Phase C consolidated the desktop/mobile **editor** into est-canvas but never
folded in the v1 `projects/` IA, leaving two front doors (and two
`takeoff-list.tsx` screens).

**Shared foundation (already unified, fully tested):** both sit on
`lib/takeoff/*` (canvas-math, canvas-totals, snapping, copy-transform, geometry
artifacts, state snapshot) and `@sitelayer/domain` geometry. **All duplication
is at the React/interaction layer; the correctness-critical math is one source
of truth.**

## 1. Decision (owner-approved 2026-06-09)

**Make est-canvas the single takeoff editor.** Migrate v1's unique
capture/AI/multi-page/revision capabilities into the est-canvas engine, then
retire `projects/takeoff-canvas` and re-point its cluster. Rationale: est-canvas
already owns the hard editor capabilities and is already responsive
(desktop-body + mobile-body behind one `useIsDesktop()` gate); hardening v1's
thin editor would rebuild what exists.

**Capability parity: full. Mobile gets every desktop feature.** Owner's call:
mobile-body and desktop-body expose the *same* capability set — desktop simply has
more resolution, making dense editing easier; mobile presents the same features
through thumb-friendly affordances. There is no "desktop-only" tier. The current
gaps (pitch, scale calibration, conditions, assemblies, arc/rect missing on mobile)
are unbuilt parity, not deliberate scope — Phase 2 closes them.

After consolidation the steady state is: **one shared engine + data layer; two
view bodies (`desktop-body`, `mobile-body`) with identical capabilities, tuned
only for ergonomics/layout.**

---

## 2. Phased plan

### Phase 0 — De-fork the front door (small)
Stop users reaching two different takeoff screens.

- Decide the single canonical canvas per viewport (desktop → `/desktop/canvas/:id`;
  mobile → `/projects/:id/takeoff-mobile`, the est-canvas bodies).
- Repoint v1 cross-links that currently target `/projects/:id/takeoff-canvas`:
  - `screens/projects/takeoff-list.tsx` (2 links)
  - `screens/projects/takeoff-summary.tsx` (3 links)
  - `screens/projects/takeoff-detail.tsx` (1 link, preserves `?selected=`)
  - `screens/projects/takeoff-preview.tsx`, `photo-measure.tsx`,
    `estimate-builder.tsx`
- Keep `/projects/:id/takeoff-canvas` mounted (App.tsx:352) until Phase 3 so
  capture/AI/revision features stay reachable; treat it as "capture/IA surface"
  not "editor" in the interim.
- **Verify:** every takeoff entry point resolves to one editor per viewport;
  no screen links to both.

### Phase 1 — Bug fixes (small, high-confidence)
Candidate defects (from exploration) — **verified against `est-canvas/desktop-body.tsx`
on 2026-06-09; only #1 survived. Recorded so we don't re-chase the others.**

1. ✅ **FIXED — Copy panel re-opens after leaving SELECT.** `copyOpen` stayed
   latched after a mode change, so the COPY panel silently re-opened on the next
   selection. Cleared `copyOpen` whenever `mode !== 'select'`.
2. ❌ **Not a bug — reassign already has an affordance.** "Reassign" sets
   `reassignIds` AND opens the item palette (`setItemPaletteOpen(true)`), which
   clears `reassignIds` on close. The open palette IS the pending indicator.
3. ❌ **Not a bug — the scale-overlay Escape handler is correct.** It's a
   deliberate hand-rolled handler (the scale box bypasses `DModal`/`useEscapeClose`)
   and covers scale + ai-count + ai-takeoff. Cosmetic refactor at most.
4. ❌ **Not present — marquee is already sheet-scoped.** It iterates
   `blueprintMeasurements`, which is filtered to the active blueprint (and empty
   when none is active), so it can't lasso across sheets.
5. ❌ **Not present — pointer-cancel is wired.** The SVG has
   `onPointerCancel={onPointerUpCanvas}`, which clears `editDragIdxRef`.
6. ❌ **Defensible — condition legend.** Measurements tied to a deleted condition
   still count in scope totals; the legend simply omits the missing condition
   object. Acceptable current behavior, not a silent data loss.

v1-side defects (address in Phase 3 when these features migrate, or sooner if
the v1 surface stays primary for capture):
- AI rejections are session-only (no backend persistence).
- Revision-compare "affected measurements" usually renders nothing (no diff
  worker populates `blueprint_page_diffs`); PDF pairs can't rasterize client-side.
- Photo-measure images are client-only (no upload).
- `blueprint_vision` is dry-run only on this surface.

- **Verify:** typecheck + lint + unit suites for the touched file.

### Phase 2 — Full mobile parity + UX polish on est-canvas (medium, in progress)
Now that est-canvas is the single editor, **bring mobile-body to full desktop
capability parity** (owner decision §1), then tune each body's ergonomics.

**Closing the mobile parity gaps** (build, not design-call): pitch, scale
calibration, conditions, assemblies, arc/rect — all currently desktop-only —
get thumb-friendly mobile surfaces wired to the *same* machine actions.

- ✅ **Quantity parity — world-scale + pitch (the accuracy core).** Verified a
  real data-correctness gap: the server recomputes a measurement's quantity from
  its geometry (`calculateGeometryQuantity`), reading `world_per_board_x/y`
  (per-axis page scale) + `pitch` off the JSONB. Desktop stamped both; **mobile
  stamped neither**, so a mobile-drawn measurement on a calibrated/pitched sheet
  silently persisted a *board-space* quantity (wrong sqft/lf). Fixed: mobile now
  reads the persisted page calibration via the same `solveWorldScale(activePage,
  …)` desktop uses (no mobile calibration-DRAWING UI needed — a sheet calibrated
  on either surface flows through), previews scaled+pitch-corrected quantities,
  and stamps `world_per_board_x/y` + `pitch` into saved geometry. Added a mobile
  `PitchPanel` (rise:run + roof presets). Extracted the stamp into the shared,
  unit-tested `lib/takeoff/measurement-geometry.ts` (`worldScaleStamp` /
  `pitchStamp`) and refactored desktop onto it so the two can't drift again.
  - **Known follow-up (pre-existing, separate):** the mobile wall-height→area
    path passes an explicit `quantity` with a plain lineal geometry, but the
    server overrides client quantity from geometry — so wall-height area doesn't
    round-trip server-side. Left unchanged here (needs a geometry representation
    for "lineal × height"); tracked, not regressed.
- ✅ **Scale-calibration *drawing* UI on mobile.** A phone can now calibrate an
  uncalibrated sheet itself (previously it could only *read* a sheet calibrated
  on desktop). Added a `scale` MobileMode + a "Set scale" segmented option (gated
  on an active sheet page), a two-tap reference-line surface (calibration points
  rendered on `MobileCanvasSurface`), and a `MobileScalePanel` (length + apply /
  cancel). Wired through the *same* machine events desktop uses
  (`START_CALIBRATION` / `PLACE_SCALE_POINT` / `SET_SCALE_LENGTH`) and the shared
  `useCalibratePage` mutation, so a phone-calibrated sheet persists identically.
- ✅ **Assemblies on mobile.** Rendered the existing, form-factor-agnostic
  `AssemblyAttachPanel` (already built on the mobile `@/components/m` primitives)
  in the mobile single-selected-measurement area — a drop-in. A phone estimator
  can now attach an assembly recipe to a takeoff and see the exploded
  material/labor/sub/freight cost preview inline, at parity with desktop.
- ✅ **Conditions on mobile.** Rendered the reusable, form-factor-agnostic
  `ConditionPicker` (pick/create the typed/named/colored template the next draw
  is tagged against) in the mobile scope-entry section, wired to `useConditions`
  / `useCreateCondition`, and stamp `condition_id` on save — parity with desktop.
- ✅ **True arc tool on mobile.** Added `arc` to `MobileTool`, an ARC chip to the
  tool toolbar, a 3-control-point drawing flow that tessellates via the shared
  `arcPolyline` into a lineal curve (preview rendered on `MobileCanvasSurface`),
  scaled + pitch-corrected length, and the same scale/pitch geometry stamps as
  the other sloped tools. Full parity with desktop's arc.

**Phase 2 status:** ✅ **complete.** Mobile is now at full capability parity with
desktop — world-scale, pitch, sheet calibration, conditions, assemblies, and the
arc tool, on top of the pre-existing manual-qty, draw, deduct, bulk-select,
copy/array/mirror, edit-geom, snapping, wall-height, CSV import. The UX-polish
sub-bullets below (collapse `CopyPanel`/`MobileCopyPanel` duplication, document
the `mode`↔machine mapping, dead-code removal) remain as optional tidy-ups.
**Note:** the parity UI was verified by typecheck/lint/unit suites only — the
interaction surfaces (calibration two-tap, arc 3-point draw, pickers) want a
device-review pass before pilot use.
- Since both bodies already share the machine + geometry, the remaining parity
  work is mostly surfacing existing capabilities in mobile-body, not
  reimplementing logic.
- Collapse internal duplication: `CopyPanel`/`MobileCopyPanel`,
  `RunningTotals`/`MobileRunningTotals` share a data model — extract shared
  components, keep body-specific layout.
- Interaction-model clarity: document/extract the `mode` ↔ machine-state mapping
  (the sync effect is currently implicit).
- Remove dead code: hardcoded `SHEET_CALLOUTS` (extraction pipeline never built),
  tombstoned `buildMobileScopeTotals` comment.
- Targeted feel work per view (desktop: dense floating palettes; mobile:
  thumb-reach, larger hit targets).
- **Verify:** interaction tests; manual pass on both viewports.

### Phase 3 — Capability migration + retire v1 (large; can trail Phases 0–2)
Port v1's unique capabilities into the est-canvas engine, then delete the v1
editor. **This is the on-ramp to the AI-first north star (§5):** v1's capture
pipelines + AI quantity-review panel are an early version of "AI proposes items
the estimator reviews on the canvas." Folding them into the single est-canvas
engine is exactly the surface the north-star AI pipeline lands on — so this is
deferrable but not throwaway. Owner confirmed it can wait.

Bring v1's unique capabilities into the shared est-canvas layer, then retire v1:

- ✅ **Elevation tags + helper relocation.** Moved `ELEVATION_TAGS` /
  `ElevationTag` / `readElevation` / `prettyElevation` out of v1
  `takeoff-canvas.tsx` into the shared, unit-tested `lib/takeoff/elevation.ts`,
  and repointed the `projects/*` cluster (detail/list/summary) at it — **a real
  step toward retiring v1** (those three screens no longer import code from it).
  Added a shared `ElevationPicker` to BOTH est-canvas bodies and now stamp
  `elevation` on the primary save (neither body did before, despite the machine
  owning the `draft.elevation` slice + `SET_ELEVATION`). Tags the next draw with
  a building face (N/S/E/W/roof) so the per-elevation rollup works.
- ⏳ **Remaining to migrate:** capture pipelines (`useCaptureTakeoffDraft` + the
  4 pipe-* invokers), AI quantity-review panel (`AgentSuggestionsPanel`),
  multi-page page-strip + per-page calibration overlay, multi-condition tag
  sheet, revision compare, photo-measure cross-link. Several are dry-run/stub on
  v1 and are the on-ramp to the AI-first north star (§5).
- ⏳ Then: re-point the rest of the `projects/*` cluster, retire
  `screens/projects/takeoff-canvas.tsx`, remove its route (App.tsx:352).
- **Verify:** typecheck + lint + unit suites per increment; full
  `npm run verify` + e2e before the final v1 deletion.

---

## 3. Open questions — resolved 2026-06-09

1. ✅ **Consolidate into est-canvas.** Confirmed.
2. ✅ **Full mobile parity.** Mobile gets every desktop feature; desktop just has
   more resolution for dense editing. No desktop-only tier.
3. ✅ **Phase 3 can trail.** v1's capture/AI/revision set is not pilot-critical
   now; it lands later as the AI on-ramp (§5).

Remaining (north-star, not blocking this consolidation):
- Collaboration model (spec §6 item 5): cloud-native multi-user w/ locking in v1,
  real-time co-edit later — confirm before that work starts.
- Overlay renderer migration SVG → Canvas/Konva (see §5 divergence) — schedule
  before the large-plan-set / AI-volume goals, not during Phase 0.

## 4. Notes / invariants to respect
- Board space is 0–100 both axes; SVG `viewBox="0 0 100 100"`. Don't fork geometry.
- All persistence stays through existing `lib/api` hooks; measurements remain
  interchangeable across bodies.
- New reachable mobile routes go in `mobile-shell.tsx` before the catchalls;
  full-screen routes mount in `App.tsx` (per CLAUDE.md routing topology).

---

## 5. Relationship to the PlanSwift / AI-takeoff north star

The owner-provided spec ([`docs/PLANSWIFT_REBUILD_SPEC.md`](./PLANSWIFT_REBUILD_SPEC.md))
is the destination: **AI-first takeoff + estimating**, where the default
workflow is *review-and-correct AI-proposed items* on a single plan canvas, with
a correction-capture flywheel from commit one. This consolidation is **Phase 1 of
that spec** — "build the place the answers land before the thing that produces
them" (spec §4.7). Mapping:

| Spec phase (§4.10) | This plan |
| --- | --- |
| 1. Foundation: plan canvas + calibration + geometry kernel + editable `TakeoffItem` + manual area/linear/count | **Phases 0–2** — collapse to one est-canvas editor, full mobile parity, polish. est-canvas already has the canvas/calibration/geometry kernel + manual tools; we're making it *the* surface. |
| 2. Vector-PDF AI pipeline + correction-capture loop | builds on **Phase 3** (the capture/AI surface folded into est-canvas) then extends |
| 3. Parts/assemblies/formula engine + estimate rollup + export | est-canvas already has conditions/assemblies primitives to grow into the formula engine |
| 4. SiteLayer bid-lifecycle integration | existing estimate/`lib/api` wiring |
| 5. Scan/raster AI pipeline | later ML track |
| 6. Revision compare + collaboration + reporting + trade packs | v1 has a revision-compare seed (migrate in Phase 3); collaboration is spec §6-item-5 (open) |

### What already aligns (don't rebuild)
- **Geometry kernel in world/board space, pure + tested** (`lib/takeoff/*`) — matches
  spec §4.3. Pitch correction, cutouts/deductions, arcs already exist on desktop.
- **Editable typed item model** — `takeoff_measurements` + `takeoff_drafts` with a
  capture `source` column is the spec's `TakeoffItem` with `source = manual|AI`.
  The spec's "`props` JSON bag for AI confidence/source" maps onto existing
  draft/measurement metadata — extend, don't replace.
- **Capture pipelines exist** — `packages/pipe-{blueprint,roomplan,drone,photogrammetry}`
  on shared `capture-schema` types, with an AI quantity-review panel. That is the
  seed of spec §4.7's "AI proposes, human reviews."

### Known divergences to schedule (honest gaps vs the spec)
1. **Overlay renderer: SVG today vs Canvas/Konva in spec §4.1/§4.11.** est-canvas
   draws items as SVG (`viewBox 0 0 100 100`). The spec explicitly warns SVG DOM
   "dies on big takeoffs" and mandates a canvas/WebGL overlay for 100+ MB sets and
   AI-volume item counts. **Recommendation:** keep SVG through Phases 0–2 (correct
   for current scale), plan a renderer swap behind the stable `lib/takeoff` data
   model before the large-plan-set / AI-volume goals. The world-unit data model
   makes this swap localized to the render layer.
2. **AI is dry-run / not the default path.** `blueprint_vision` is dry-run on the
   v1 surface; the spec wants AI-first as the primary workflow. This is the bulk of
   post-consolidation work, gated behind the single canvas existing first.
3. **Correction-capture flywheel not built.** Spec calls it the highest-leverage
   non-obvious decision ("build it in from commit one"). Nothing logs AI-proposed
   vs human-final deltas yet. Should land *with* Phase 3's AI surface, not after.
4. **Formula/assembly engine is partial.** est-canvas has conditions/assemblies as
   tagging, not the sandboxed formula evaluator (mathjs/expr-eval) the spec §4.5
   specifies. Grows in spec-phase 3.

**Bottom line:** the consolidation is directly on the critical path to the north
star and reuses the spec's hardest already-built pieces (canvas, geometry kernel,
typed item model, capture pipelines). The big net-new work — AI-first default,
correction flywheel, formula engine, canvas renderer swap — all sits *after* a
single canvas exists, which is exactly what Phases 0–3 deliver.
