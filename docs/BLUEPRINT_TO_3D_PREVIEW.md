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
- Blueprint pages store two-point calibration, but manual measurements do not
  currently expose `page_id` to the web payload.
- Capture drafts already support `blueprint_vision`, `roomplan`,
  `photogrammetry`, and `drone`.
- `@sitelayer/capture-schema` already has `TakeoffGeometry`, `SourceArtifact`,
  and `BlueprintArtifact` types that can become richer 3D inputs later.

## V1

Route: `/projects/:id/takeoff-preview`

Properties:

- Read-only.
- Derived from `useProjectMeasurements(projectId, { draftId })`.
- Filters to the selected blueprint document.
- Uses the selected page calibration when available.
- Uses Three.js in a lazy project route so the main app shell does not pay the
  WebGL cost.
- Shows polygons as low extrusions, lineal runs as tubes, count points as posts,
  and volume rows as dimension boxes.
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

## Later Phases

1. Carry `page_id` through manual measurement writes and the web API.
2. Render actual blueprint page imagery behind the 2D canvas.
3. Normalize `takeoff_drafts.takeoff_result_json.geometry` into the preview,
   especially RoomPlan walls and drone roof planes.
4. Add a read-only derived endpoint if the web payload needs capture geometry
   without overfetching full draft JSON.
5. Only add physics if there is a concrete scaffold/layout/safety workflow.

## Language Guardrail

Use "3D takeoff view", "3D takeoff visualization", or "extruded draft".
Avoid "digital twin", "full house", "physics model", or "structural model"
until the product actually contains validated BIM-grade geometry.
