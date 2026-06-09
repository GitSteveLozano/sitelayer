# Takeoff Canvas Consolidation & UX Plan

**Status:** Proposed (planning only — no code changed yet)
**Author:** agent session, 2026-06-09
**Scope:** the two parallel takeoff/canvas surfaces in `apps/web/`

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

## 1. Decision

**Make est-canvas the single takeoff editor.** Migrate v1's unique
capture/AI/multi-page/revision capabilities into the est-canvas engine, then
retire `projects/takeoff-canvas` and re-point its cluster. Rationale: est-canvas
already owns the hard editor capabilities and is already responsive
(desktop-body + mobile-body behind one `useIsDesktop()` gate); hardening v1's
thin editor would rebuild what exists.

After consolidation the steady state is: **one shared engine + data layer; two
view bodies (`desktop-body`, `mobile-body`) tuned independently for form
factor.** Per-capability we decide which bodies expose it.

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
Concrete defects found in est-canvas (`est-canvas/desktop-body.tsx` unless noted):

1. Copy panel doesn't close on mode switch (SELECT→SCALE/DRAW leaves `copyOpen`
   floating). Clear `copyOpen` in the mode-change handler / tool-palette buttons.
2. Reassign has no pending-state indicator → silent failure if the machine
   update races. Surface a "REASSIGN PENDING" affordance while `reassignIds` set.
3. Scale overlay uses a hand-rolled Escape handler — align with the shared
   overlay/Escape convention.
4. Marquee bulk-select ignores active blueprint when `activeBlueprint` is null →
   can lasso measurements across sheets. Guard the `blueprintMeasurements` filter.
5. `editDragIdxRef` not cleared on pointer-cancel → next EDIT GEOM can start with
   a stale vertex index. Clear on cancel path.
6. Condition legend silently omits deleted-but-referenced conditions — reconcile
   legend vs picker.

v1-side defects (address in Phase 3 when these features migrate, or sooner if
the v1 surface stays primary for capture):
- AI rejections are session-only (no backend persistence).
- Revision-compare "affected measurements" usually renders nothing (no diff
  worker populates `blueprint_page_diffs`); PDF pairs can't rasterize client-side.
- Photo-measure images are client-only (no upload).
- `blueprint_vision` is dry-run only on this surface.

- **Verify:** unit/interaction coverage for each fix; `npm run verify` standard gate.

### Phase 2 — UX / interaction polish on est-canvas (medium)
Now that est-canvas is the single editor, tune each body. Prereq: a
**capability-parity audit** (desktop-body vs mobile-body) to decide, per
capability, which form factors expose it.

- Known parity gaps to resolve as design calls: pitch, scale calibration,
  conditions, assemblies, arc/rect are desktop-only today; manual-qty,
  wall-height→area, CSV import are mobile-only.
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

### Phase 3 — Capability migration + retire v1 (large)
Port v1's unique capabilities into the est-canvas engine, then delete the v1
editor.

- Bring into the shared layer (so both bodies can surface appropriately):
  capture pipelines (`useCaptureTakeoffDraft` + the 4 pipe-* invokers), AI
  quantity-review panel (`AgentSuggestionsPanel`), multi-page page-strip +
  per-page calibration overlay, elevation tags, multi-condition tag sheet,
  revision compare, photo-measure cross-link.
- Re-point the `screens/projects/takeoff-*` cluster (list/detail/summary/preview)
  at the est-canvas routes.
- Retire `screens/projects/takeoff-canvas.tsx` and remove its route (App.tsx:352).
- Address the v1-side defects from Phase 1 as the features land.
- **Verify:** full `npm run verify`; e2e takeoff flows on both viewports; confirm
  no orphaned routes/links.

---

## 3. Open questions for the owner

1. Confirm the consolidate-into-est-canvas direction (vs keep-both-de-forked).
2. Capability parity: which advanced editor features (pitch, calibration,
   conditions, assemblies, arc) should mobile-body expose vs stay desktop-only?
3. Is the v1 capture/AI/revision feature set pilot-critical now, or can Phase 3
   trail Phases 0–2?

## 4. Notes / invariants to respect
- Board space is 0–100 both axes; SVG `viewBox="0 0 100 100"`. Don't fork geometry.
- All persistence stays through existing `lib/api` hooks; measurements remain
  interchangeable across bodies.
- New reachable mobile routes go in `mobile-shell.tsx` before the catchalls;
  full-screen routes mount in `App.tsx` (per CLAUDE.md routing topology).
