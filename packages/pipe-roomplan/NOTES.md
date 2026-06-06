# pipe-roomplan — implementation notes

## Source

Apple RoomPlan documentation referenced while authoring fixtures and the zod
schema:

- https://developer.apple.com/documentation/roomplan/ (framework overview)
- https://developer.apple.com/documentation/roomplan/capturedroom
- https://developer.apple.com/documentation/roomplan/capturedroom/encode(to:)
- https://developer.apple.com/documentation/roomplan/capturedroom/confidence
- https://developer.apple.com/documentation/roomplan/capturedroom/object/category-swift.enum
- https://developer.apple.com/documentation/roomplan/capturedroom/surface
- https://developer.apple.com/documentation/roomplan/structurebuilder/capturedstructure(from:)
- WWDC22 — Create parametric 3D room scans with RoomPlan
- WWDC23 — Explore enhancements to RoomPlan

## Confirmed vs. guessed JSON fields

Apple does not publish the exact JSON shape that `JSONEncoder().encode(capturedRoom)`
emits — they only publish the Swift struct definitions. The shape used in
`fixtures/sample-room.json` and `src/captured-room-types.ts` is reconstructed
from those struct fields, the WWDC sample code, and `research/01-roomplan.md`
§3. In particular:

| Field                          | Status    | Notes                                                                                                     |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------- | -------- | ------- |
| `version`                      | confirmed | `CapturedRoom.version` is `Codable`.                                                                      |
| `identifier`                   | confirmed | UUID, `Codable`.                                                                                          |
| `walls/doors/windows/openings` | confirmed | top-level `[Surface]` arrays per the Surface reference.                                                   |
| `floors`                       | confirmed | top-level `[Surface]` per CapturedRoom (added in iOS 16.1).                                               |
| `objects`                      | confirmed | `[CapturedRoom.Object]`.                                                                                  |
| `sections`                     | iOS 17+   | Optional; we leave it permissive.                                                                         |
| `Surface.identifier`           | confirmed | `UUID`.                                                                                                   |
| `Surface.category`             | confirmed | enum string.                                                                                              |
| `Surface.dimensions`           | confirmed | `simd_float3` → 3-tuple, **meters**. Per WWDC samples: `[width, height, length]`.                         |
| `Surface.transform`            | confirmed | `simd_float4x4` → 4×4 matrix in column-major. We accept either nested-array layout.                       |
| `Surface.confidence`           | confirmed | `"high"                                                                                                   | "medium" | "low"`. |
| `Surface.parent`               | confirmed | UUID? — host wall for openings.                                                                           |
| `Surface.curve`                | confirmed | optional, present on curved walls.                                                                        |
| `Surface.polygonCorners`       | iOS 17+   | optional `[simd_float3]` for slanted/non-rect walls.                                                      |
| `Object.category`              | confirmed | one of the 16 RoomPlan furniture categories.                                                              |
| `Object.parent`                | guessed   | the Swift docs don't explicitly mention `parent` on Object, but it appears in dumps; treated as optional. |

Anything we use is permissive (`.passthrough()` on container shapes), so
unknown future fields don't break parsing. We re-validate the final
`TakeoffResult` against the schema package's strict zod schema at the seam.

## Floor area derivation strategy

Two-tier:

1. **Preferred:** if the dump contains a `floors[]` surface, use
   `dimensions[0] * dimensions[2]` (X × Z extents in meters) summed over all
   floor surfaces. `dimensions[1]` for a floor is its _thickness_, not Y
   extent — confirmed from the Surface docs.
2. **Fallback:** axis-aligned bounding box across wall translations
   (`transform[3][0]` and `transform[3][2]`).

The fallback is **a simplification** — it only works for axis-aligned
rectangular rooms. Non-rectangular rooms would need polygon reconstruction
from wall endpoints. Our test fixtures all include `floors[]`, so the
fallback is exercised only by hypothetical inputs and is documented as a
known limitation.

The perimeter is always the sum of `walls[].dimensions[0]` (lengths). This
matches what `research/01-roomplan.md` §4 calls `perimeterLf` and is
robust to non-axis-aligned layouts (where bbox would lie).

## Multi-room handling

Apple's stock `CapturedRoom` is single-room. iOS 17 introduced
`CapturedStructure` (via `StructureBuilder.capturedStructure(from:)`) which
merges multiple `CapturedRoom`s. Apple's JSON shape for `CapturedStructure`
is not publicly documented, so we approximate it as a top-level wrapper:

```json
{
  "version": 1,
  "identifier": "<structure-uuid>",
  "rooms": [ <CapturedRoom>, <CapturedRoom>, ... ]
}
```

The parser auto-detects: if the input has a top-level `rooms[]` array, treat
as a structure; otherwise treat the whole object as a single CapturedRoom.
See `normalizeToRooms()` in `captured-room-types.ts`.

For real iOS 17+ output, we'd need to either (a) ingest one CapturedRoom per
file and merge in our own pipeline, or (b) reverse-engineer the actual
`CapturedStructure.encode()` output and adjust the schema. Both paths
preserve the top-level `TakeoffResult` shape — only the input parser
changes.

## Section labels

`sections[]` (iOS 17+) provides `category` (e.g. `"bedroom"`, `"bathroom"`)
and an optional `label`. We pick the first section's `label ?? category`
for `geometry.rooms[].label` and `sourceArtifact.roomplan.rooms[].sectionLabel`.
Open-concept rooms with multiple sections will pick only the first; the data
contract doesn't yet support multi-section rooms (`research/01-roomplan.md`
§5 calls this out as a limitation).

## Wall thickness

Per `research/01-roomplan.md` §5, RoomPlan wall thickness defaults to ~16 cm
and isn't trustworthy. We never use `dimensions[2]` for walls — we use
`length × height` (gross side area) and subtract opening areas for net.

## CSI MasterFormat mapping for fixtures

| RoomPlan category                                  | MasterFormat     | UniFormat | Notes                                                                                          |
| -------------------------------------------------- | ---------------- | --------- | ---------------------------------------------------------------------------------------------- |
| toilet, sink, bathtub                              | 22 40 00         | D2010     | Plumbing fixtures.                                                                             |
| refrigerator, stove, oven, dishwasher, washerDryer | 11 31 00         | E1090     | Residential appliances.                                                                        |
| fireplace                                          | 10 31 00         | C1030     | Manufactured fireplaces.                                                                       |
| stairs                                             | 06 43 00         | B1080     | Wood stairs.                                                                                   |
| television, storage, sofa, chair, table, bed       | (UniFormat only) | E2010     | FF&E — emitted with UniFormat only so pricing skips unit-cost lookup (per CONTRACT.md rule 5). |

If a category isn't in the table we skip emitting a quantity (per the task
spec: "skip if uncategorized"). The fixture is still represented in
`geometry.objects[]` so the review UI can show it.

## Confidence scoring

Per the schema package's `roomplanConfidenceToScore()`:

- high → 0.95
- medium → 0.75
- low → 0.45

Per-quantity:

- **Drywall (per room):** min over contributing walls. Walls inherit the
  worst confidence of themselves and their host openings (so a `medium`
  door drags a `high` wall down to `medium`).
- **Baseboard:** same as drywall (shares wall confidence).
- **Flooring:** floor surface confidence (or fallback wall-bbox aggregate).
- **Ceiling:** `derivedConfidence([floor])` — `min(parents) * 0.9`.
- **Door/window count:** min over contributing features.
- **Per fixture:** the fixture's own confidence.

## Contract gaps / questions for reconciliation

None blocking, but for the record:

1. The contract requires `sourceArtifact.roomplan.rooms[].walls[]` to carry
   `lengthLf`. Curved or slanted walls don't have a single straight length;
   we currently emit the `dimensions[0]` value, which is the bounding-box
   length. Curve handling is deferred — would only matter for real-world
   round bay windows etc.
2. `walls[].polygonCorners` is parsed but not yet consumed for area; we use
   `length × height` gross. Slanted walls (kneewalls under a roof) will be
   over-counted by this — not a bug for v1 spike but a future TODO.
3. The schema's `RoomplanArtifact.rooms[].features[].parentWallId` is
   required (not optional). If a real CapturedRoom emits an opening without
   a parent (rare), we'd need to either fabricate a synthetic wall or
   relax that field. Currently we emit empty string, which the schema
   allows.
4. RoomPlan emits no ceiling surfaces; we always derive ceiling area from
   floor. The contract supports this via `provenance.kind = "derived"`.

## Tests

```
npm --workspace @sitelayer-capture/pipe-roomplan run typecheck
npm --workspace @sitelayer-capture/pipe-roomplan test
npm --workspace @sitelayer-capture/pipe-roomplan run demo -- packages/pipe-roomplan/fixtures/sample-room.json
```
