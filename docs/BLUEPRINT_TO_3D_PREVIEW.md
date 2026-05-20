# Blueprint To 3D Preview

Status: v1 implementation started 2026-05-20.

## Position

The first shippable feature is **3D takeoff visualization**, not an automatic
"full house" generator. The preview renders existing reviewed measurements as a
deterministic 2.5D scene. It is useful after takeoff because a contractor can
inspect the shape, quantity, service item, and elevation tags spatially without
trusting a model to invent construction geometry.

## Existing Substrate

- Blueprint uploads and downloads already exist in `apps/api/src/routes/blueprints.ts`.
- Draft-scoped takeoff measurements already exist in `takeoff_measurements`.
- Manual geometry is stored as normalized board-space `0..100` points.
- Blueprint pages store two-point calibration, and manual measurements now
  carry `page_id` through create/list/patch payloads. Legacy rows with null
  `page_id` are treated as page 1 by convention.
- Capture drafts already support `blueprint_vision`, `roomplan`,
  `photogrammetry`, and `drone`.
- `@sitelayer/capture-schema` already has `TakeoffGeometry`, `SourceArtifact`,
  and `BlueprintArtifact` types that can become richer 3D inputs later.

## V1

Route: `/projects/:id/takeoff-preview`

Properties:

- Read-only.
- Derived from `useProjectMeasurements(projectId, { draftId })`.
- Filters to the selected blueprint document and selected blueprint page.
- Uses the selected page calibration when available.
- Uses Three.js in a lazy project route so the main app shell does not pay the
  WebGL cost.
- Loads selected image-backed blueprint pages through an authenticated blob
  fetch, then renders the source sheet as a muted underlay beneath the 3D scene.
- New PDF uploads rasterize page 1 server-side into
  `blueprint_pages.storage_path` when `pdftoppm` is available, so the same
  authenticated image-underlay path works for uploaded PDFs. If rasterization
  fails, upload still succeeds and the page reports the PDF fallback state.
- Shows polygons as flat floor/area highlights, lineal runs as vertical
  wall/trim panels, door/window counts as elevated opening markers oriented
  toward the nearest lineal run, and volume rows as dimension boxes.
- Emits explicit warnings when scale/page ownership is ambiguous.

No new write path, no new backend API, no physics library, and no new model
integration are required for this version.

## Gemini Role

Gemini should be used as an extraction critic and structured-scene proposer, not
as a direct geometry writer.

Safe workflow:

1. Copy the blueprint image/PDF into a local workspace.
2. Run Gemini CLI in read-only plan mode with the file referenced by `@path`.
3. Ask for strict JSON containing rooms, walls, openings, scale clues,
   confidence, and uncertainty notes.
4. Validate that JSON against a local schema.
5. Convert the validated JSON to deterministic `TakeoffResult` /
   `TakeoffGeometry`.
6. Keep the result in a review-required draft until the operator promotes it.

Example:

```bash
gemini --approval-mode plan -m gemini-3-flash-preview --output-format json \
  -p '@input/blueprint.png Extract rooms, walls, openings, dimensions, scale clues, confidence, and uncertainty notes as strict JSON for a review-gated 3D takeoff preview. Do not edit files.'
```

## Public Demo Harness

Route: `/demo/takeoff-preview-3d`

This route is intentionally outside the authenticated Sitelayer project flow. It
uses synthetic fixture data only, so it is safe to send to a collaborator or run
through model critique without exposing customer data or requiring a Clerk
session.

The public demo has three fixture modes:

- **House plan**: baseline mixed takeoff rows for walls, lineal runs, count
  markers, and volume boxes.
- **Floor plan**: room-shaped polygons plus doors/windows/partitions. Use this
  for blueprint-extraction critique.
- **Exterior**: simple massing, roof, facade, porch, and opening cues. Use this
  for photo-reference critique.

The route exposes a deterministic scene payload through **Copy JSON** and
**Download** controls. That payload contains the selected fixture, calibration
page, source measurements, and derived scene items. The intended loop is:

1. Open the public demo and select a fixture.
2. Capture a screenshot of the rendered scene.
3. Copy or download the JSON payload.
4. Give the screenshot plus JSON to Gemini/Claude/Codex and ask what the scene
   fails to preserve from the intended blueprint/photo interpretation.
5. Convert only reviewable, deterministic improvements into fixture rows or
   mapper changes.

Suggested prompt:

```text
You are reviewing a Sitelayer 3D takeoff preview. Inputs: a screenshot of the
rendered scene and the JSON scene payload. Identify concrete mismatches between
the intended fixture and the rendered 2.5D takeoff visualization. Do not propose
new auth, backend storage, BIM, or physics work. Focus on measurement geometry,
calibration, selection affordances, labels, and what data would need to be
captured before this could represent the real structure.
```

## Later Phases

1. Expand PDF rasterization beyond the first page: detect page count, create one
   `blueprint_pages` row per sheet, and rasterize selected pages on upload or
   background backfill.
2. Normalize `takeoff_drafts.takeoff_result_json.geometry` into the preview,
   especially RoomPlan walls and drone roof planes.
3. Add a read-only derived endpoint if the web payload needs capture geometry
   without overfetching full draft JSON.
4. Only add physics if there is a concrete scaffold/layout/safety workflow.

## Language Guardrail

Use "3D takeoff view", "3D takeoff visualization", or "extruded draft".
Avoid "digital twin", "full house", "physics model", or "structural model"
until the product actually contains validated BIM-grade geometry.
