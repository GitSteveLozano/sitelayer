# pipe-photogrammetry — implementation notes

## Luma endpoint shape (assumed)

The Luma 3D Capture API is sparsely documented. As of this implementation:

- `https://docs.lumalabs.ai/docs/api` describes only the **Dream Machine**
  generation API (text/image/video → image/video). It does not document a 3D
  Capture endpoint.
- The first-party Python SDK (`lumalabs/lumaapi-python`) was **archived
  2024-09-18** and its README documents only the Python surface (`client.submit()`,
  `client.status(slug)`), not the underlying HTTP shape.
- The client docs at `https://lumalabs.ai/luma-api/client-docs/index.html`
  confirm the response shape — `{ slug, status, artifacts: [{type, url}] }` —
  and the auth header format (`Authorization: luma-api-key=<key>`), but do not
  publish raw endpoint paths; those live in a Postman collection we did not
  fetch.

What this package assumes (subject to change once the real API is exercised):

| Property       | Assumption                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------- | --- | --- | ---- | ---- | ---------------------------------- | --------- | ------------- | ----------------------------------------------------------------------------- |
| Base URL       | `https://webapp.lumalabs.ai`                                                                        |
| Submit         | `POST /api/v1/capture` with multipart body fields `file` + `title`                                  |
| Poll           | `GET /api/v1/capture/{slug}`                                                                        |
| Auth           | `Authorization: luma-api-key=<key>` (per archived Python client)                                    |
| Response       | `{ slug, status, artifacts: [{type, url}] }`                                                        |
| Status enums   | `NEW`, `UPLOADING`, `DISPATCHED`, `FINISHED`, `FAILED`, `COMPLETE` (collapsed to our 4-state shape) |
| Artifact types | We try `mesh                                                                                        | obj | glb | gltf | usdz | textured_mesh`for mesh and`preview | thumbnail | preview_image | image` for previews — best-guess from the public artifact-listing screenshots |

This is OK for the spike: every Luma call is mockable via `fetchImpl` /
`fileLoader` injection on the client functions. Tests pass without a live key
and without `LUMA_API_KEY`. When we exercise the real API, only
`src/luma-client.ts` needs adjusting.

## Path A: review-required by design

`fetchPhotogrammetryTakeoff` returns a `TakeoffResult` that:

1. Has exactly one placeholder `TakeoffQuantity` with `confidence: 0.05` and a
   description of "Mesh available; human labeling required". (We can't go to
   exactly `0.0` because the minimum useful signal needs to be representable
   as a quantity at all, but the pricing engine should treat anything below
   `REVIEW_REQUIRED_CONFIDENCE_FLOOR = 0.7` as gated.)
2. Has `reviewRequired: true` and a `photogrammetry_review_needed` warning.
3. Carries the Luma mesh URL in `sourceArtifact.photogrammetry.meshUrl` so the
   review UI can load the GLB into a Three.js viewer for the human to label.

Rationale — why not auto-segment? Per `research/02-photogrammetry.md` §3, only
Polycam Business auto-extracts walls/floors/ceilings/doors/windows. Luma
returns raw geometry. The honest options are:

- Run a server-side semantic segmentation model (Mask2Former on per-frame 2D,
  re-projected to mesh; or OpenScene zero-shot 3D). ~2 hr to wire up but adds
  a GPU dependency we don't want for the spike.
- Run RANSAC plane fitting → assign floor/ceiling/wall by normal direction.
  Cheap; works for box-shaped rooms; fails on slanted ceilings / curved walls.
- Punt to a human via a labeling UI — the chosen Path B input.

Path A says "we have a mesh, here's where it lives, ask a human." Path B says
"a human labeled it, here are the quantities."

## Path B: labeled-mesh JSON

The shape lives in `src/labeled-mesh.ts`. It is the contract with whatever UI
ends up doing the manual labeling. Surfaces carry a per-surface `confidence`
(0–1, mirroring the per-quantity confidence on the contract) and a `source`
discriminator (`"vendor-auto" | "ransac-planes" | "reprojected-2d-segmentation"
| "human-labeled"`) so future agents can mix automatic and manual labels in
the same fixture.

Confidence math is intentionally simple: per-quantity confidence is the min
across the contributing surfaces. That ensures a single low-confidence wall
drags down the whole drywall total — the right behaviour, since the estimator
needs to know if any of the inputs were shaky.

## Future: integrating Polycam (auto-segmented rooms)

Polycam Business auto-extracts rooms / walls / openings (per
`research/02-photogrammetry.md` §1, March 2026 update). Drop-in path:

1. Add `polycam-client.ts` next to `luma-client.ts`, with the same
   `submit / poll` shape but an additional `fetchAutoLabels()` call that
   returns the auto-segmented rooms + surfaces.
2. Map Polycam's auto-labels directly into the `LabeledMesh` shape in
   `src/labeled-mesh.ts` (set `source: "vendor-auto"` per surface and use
   Polycam's per-room confidence — likely a number in `[0,1]` already).
3. Pipe through `buildTakeoffFromLabeledMesh` exactly as the manual path does.
   No changes to the index.ts or CLI surface; the only change is which client
   produces the `LabeledMesh`.

That keeps the contract output shape stable across vendors and lets us swap
hosts without touching downstream pricing.

## Imperial-at-the-seam policy

Per the contract (`CONTRACT.md` §Implementation guardrails), pipelines emit
imperial. The labeled-mesh input is metric (m, m²) — we convert at the seam
using `1 m² = 10.7639 sqft` and `1 m = 3.28084 ft`. The
`PhotogrammetryArtifact.scale` block on the source artifact still records the
meters-per-unit factor for the mesh viewer.

## Open items

- The Luma API base URL and endpoint paths are guesses; bake them in when we
  exercise a real key.
- The `inferMeshFormat` heuristic looks for `.glb / .usdz / .obj` substrings in
  the URL. Luma's signed URLs may not include the extension; we'll need to
  honour an explicit `meshFormat` field from the API once we observe a real
  response.
- We do not currently emit `geometryRefs` linking each `TakeoffQuantity` back
  to the surface ids in `geometry.surfaces[]`. Easy to add once a downstream
  consumer needs it.
