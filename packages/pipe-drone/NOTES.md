# pipe-drone — implementation notes

## Three paths

| Path                   | What it does                                                                                             | Status                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **A — NodeODM live**   | POST images, poll `/task/:uuid/info`, fetch rasters, then extract `odm_report/stats.json` → coverage     | **End-to-end.** Emits a real, review-required site-coverage `TakeoffResult`. Raster geometry is the live boundary. |
| **B — Sidecar JSON**   | Read a precomputed sidecar JSON describing roof planes, footprint, sitework, surfacing → `TakeoffResult` | **Full-fidelity.** This is what the `npm run demo` target hits, and where the raster extractor's output flows in.  |
| **C — RANSAC fixture** | Run `segmentMultiplePlanes` on a hand-authored point cloud → synthetic `TakeoffResult`                   | Smoke test only. Proves the math at miniature scale.                                                               |

### Path A: report-JSON coverage extraction + the live-service boundary

`buildDroneTakeoff` with `imagesDir + nodeOdmUrl` now runs end-to-end:

1. Upload all images to NodeODM.
2. Wait for the task to reach status code 40 (or fail / time out).
3. Download `orthophoto.tif`, `dsm.tif`, `dtm.tif`, `georeferenced_model.laz` to `<imagesDir>/.odm-out/`.
4. Fetch the JSON-shaped report `odm_report/stats.json` (via `nodeOdmFetchJsonAsset`),
   validate it (`OdmReportSchema`), and derive a real `TakeoffResult`
   (`takeoffFromOdmReport`): a site-level **coverage area** quantity (UniFormat
   `G1010`, sqft) at an **average-GSD-driven confidence** (`droneConfidenceFromGsd`),
   always `reviewRequired = true`.

**Why coverage-only, and what the live boundary is.** The full-fidelity geometry —
per-roof-plane area (DSM−DTM footprint masks + LAZ point-cloud RANSAC), DTM
cut/fill against a target grade, and ortho HSV surfacing classification — operates
on the binary GeoTIFF/LAZ rasters and genuinely needs GDAL + Open3D / PDAL. Those
are Python-native; running them in a pure-TS package would mean spawning an
out-of-process Python subprocess. That raster extractor is the documented
**live-service boundary** (`odm-report.ts → LIVE_SERVICE_BOUNDARY`). Its richer
output is authored as a sidecar JSON and fed back through **Path B** (`--sidecarPath`).

So pipe-drone extracts everything the JSON report honestly knows (coverage area,
GSD confidence, reconstructed image/point counts) without fabricating roof planes
or cut/fill the rasters haven't been processed to compute. The emitted result
carries an `odm_report_coverage_only` warning naming exactly which quantities
require the raster path. If NodeODM completes without producing the report,
Path A throws a clear, actionable error rather than guessing.

## Convex-hull approximation for plane area

`planeAreaFromInliers` projects RANSAC plane inliers into a 2D plane-local basis, takes the **convex hull** (Graham scan), and applies the shoelace formula. This **overestimates concave roofs** (L-shaped, dormered, hipped-with-cutout). A real implementation should use an alpha-shape (e.g. CGAL `Alpha_shape_2`, Shapely `concave_hull`, or a Python helper). The spike documents this trade as acceptable for a synthetic two-plane gable.

The fixture `sample-pointcloud-two-planes.json` is rectangular — convex hull is exact for it. Real-roof error on hipped+dormered geometry can run +10–25% versus alpha-shape, biasing material quantities upward.

## Coordinate units in `geometry.surfaces[].polygon`

`TakeoffGeometry.surfaces[].polygon` accepts either 2D or 3D arrays in the contract. We store **lat/lon (WGS84)** for the drone slice — the same coordinates GeoJSON uses, lifted out of the `sourceArtifact.drone.buildings[].footprint` and `roofPlanes[].polygon`. This is a deliberate choice for the spike:

- The review UI already needs lat/lon to render a Leaflet ortho overlay.
- Local UTM coordinates would require carrying CRS metadata into `geometry`, which the contract doesn't currently support.
- Areas (`areaSqFt`) are still in imperial, computed by upstream extraction from local UTM — never derived from the lat/lon polygon directly.

When the contract grows a `coordsystem` discriminator on `geometry.surfaces`, switch to local UTM for higher fidelity.

## Confidence model

- Per `CONTRACT.md` §Confidence: `confidence = reconstructorConfidence × min(1, 2/gsd_cm)`.
- We use `0.85` as a baseline reconstructor confidence (no per-pipeline calibration data yet).
- For roof planes, confidence is `baseline × (materialConfidence ?? 0.85)`. **The contract does not currently model per-roof-plane confidence**; we infer it from `materialConfidence`, which is a different signal. See the contract gap below.
- For sitework cut/fill, we apply a `× 0.8` discount against the baseline. DTM-vertical noise dominates volume error.
- For surfacing polygons, confidence is `baseline × surfacing.confidence` from the sidecar.

`applyReviewFloor` runs at the end of every emit; any quantity below 0.7 flips `reviewRequired = true` and emits a `low_confidence_quantities` warning.

## RANSAC stub limitations

- Single-plane sampling: pure brute-force, no KD-tree, O(iterations × N).
- `iterations=1000` is enough for the fixture (420 points, two planes). Real point clouds (millions of points) need either downsampling or a smarter search.
- The refit step uses a 3×3 covariance cofactor heuristic — not a true SVD. For nearly degenerate point sets it may fail; production code should call a proper linear-algebra library.
- No surface-normal estimation per point — we only fit equations from sampled triplets.
- No region growing: a single roof with a slight crease will be split or combined depending on the noise threshold.

The unit tests pass against the synthetic fixture with `|n_truth · n_recovered| > 0.99` and pitch within ±5° of truth, which is sufficient to prove the algebra. Production roof segmentation should use Open3D's `segment_plane` in a loop, then alpha-shape area, then a contour simplifier (Douglas-Peucker) before exporting GeoJSON.

## Contract gaps (suggest for v2)

1. **Per-roof-plane confidence.** `DroneArtifact.buildings[].roofPlanes[]` only has `materialConfidence`. We need a separate `geometricConfidence` (or just `confidence`) so plane-level reconstruction quality can flow into the quantity. Currently we approximate by re-using `materialConfidence`, which conflates two different uncertainties.
2. **Per-surfacing material → MasterFormat is incomplete.** `pavers`, `vegetation`, `bare-soil`, `other` map to no MasterFormat in v1. We emit an `info` warning per skipped polygon. v2 should either standardise mappings (e.g. pavers `32 14 13`) in a shared catalog or push the mapping into the catalog package.
3. **CRS in geometry.** `TakeoffGeometry.surfaces[].polygon` is silent on coordinate units. Drone polygons want lat/lon for a Leaflet review UI; RoomPlan polygons want metres or feet. v2: add a `crs?: "wgs84" | "imperial-local"` discriminator on each polygon.
4. **Sitework boundary in geometry.** `DroneArtifact.sitework.boundary` is GeoJSON in `sourceArtifact`, but we don't surface it in `TakeoffGeometry`. The review UI clicking on a `q-sitework-cut` quantity has no surface to highlight unless it deep-reads `sourceArtifact`. Consider attaching a `surfaces[]` entry with `kind: "sitework"` (new variant).
5. **Net cubic yards.** The sidecar carries `cutCubicYards`, `fillCubicYards`, and the signed `netCubicYards`. The contract treats them all as quantities ≥ 0 (`netCubicYards` is signed in TS but zod isn't checking sign). We emit cut and fill as separate quantities and let pricing apply two different rates (haul-out vs. compact-fill). Clarify in v2 whether `netCubicYards` is informational or load-bearing.

## What an estimator should sanity-check

Even with a perfect sidecar, a human estimator should:

- Confirm roof planes weren't double-counted with hips/dormers as separate planes.
- Confirm sitework `cutCubicYards` is bare-earth-to-target, not bare-earth-to-DSM (vegetation contamination).
- Confirm surfacing polygons don't overlap building footprints.
- Confirm the GSD claim is realistic for the flight altitude (≈1.5 cm/100 ft AGL is typical).

`reviewRequired = true` is the floor; manual review is always sensible for drone takeoffs.
