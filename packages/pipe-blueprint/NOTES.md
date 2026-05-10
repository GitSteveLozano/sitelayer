# pipe-blueprint — implementation notes

Author-time notes for `@sitelayer-capture/pipe-blueprint@0.1.0` (sitelayer-capture spike, May 2026).

## Render-DPI assumption

Anthropic's PDF support docs say each page is converted to an image + extracted text before being fed to the model, but **they do not publish a guaranteed pixel resolution or DPI for that conversion**. Empirical reports in research/04 suggest the long-edge cap is around 1568 px (matches the standalone-image documentation). Concretely, a US-letter page (8.5 × 11 in) hitting a 1568-px cap on the long edge implies roughly 142 DPI; a D-size 17 × 11 sheet hits the same cap at ~92 DPI.

**Decision:** default `assumedDpi = 100` and expose `--assumed-dpi` on the CLI plus `assumedDpi` in `BuildBlueprintTakeoffOptions`. This is the dominant source of error when scale is recovered from titleblock text alone (no user known dimension). The pipeline penalises that path with `scale.confidence = 0.6`, which combined with the `confidence < 0.70` floor means **every quantity derived from titleblock-only scale is automatically flagged for review**. That's correct behaviour — we are openly admitting we don't know the page's true DPI.

The user-known-dimension path doesn't depend on DPI at all (we measure pixel length of a wall whose annotated dimension matches the user's known feet) and therefore returns `confidence ≥ 0.9`.

I did not have an `ANTHROPIC_API_KEY` in this harness, so I have **not** measured the actual rendered image size on the live API. The `assumedDpi` is a working hypothesis; first thing to do once a key is available is render the Warde sheet, ask the model for `imageSize`, and recompute.

## All-non-drawing PDFs throw

The schema requires `quantities.length ≥ 1`. Two of three sample PDFs in `~/projects/sitelayer/blueprints_sample/` are not drawings at all (an email and a stucco quote). Three options were on the table:

1. Synthesise a placeholder quantity (`value: 0`, low confidence) so the schema validates.
2. Make `quantities` allow empty arrays in the schema.
3. Throw a typed error.

**Chosen: throw `NoDrawingsFoundError`**. Rationale:

- The schema is the contract; weakening it to admit empty quantity arrays would let bugs in the other four pipelines through silently.
- A zero-value placeholder pollutes `PricedEstimate` with rows that mean nothing.
- Throwing forces the orchestrator to surface "this PDF isn't a blueprint" to the user as a first-class error, not a silent zero. The CLI maps it to exit code 3 so callers can distinguish from a normal failure.

Per-page warnings of severity `info` are still emitted for every non-drawing page, and those pages still appear in `sourceArtifact.blueprint.pages` so the review UI can show "we saw page 1 and skipped it (email, conf 0.95)".

## Per-region scale (deferred)

Per CONTRACT.md Open Question §7, v1 lives with one `scale` per page. The Warde scaffolding sheet has a plan view + two detail callouts at different scales, so quantities derived from anything in the detail callouts will be wrong on a real run. The extract prompt asks the model to add a `multi_scale_sheet` warning when it spots this — that warning will surface to the reviewer. v2 grows regional scale.

## Live demo not run

`npm run demo -- ~/projects/sitelayer/blueprints_sample/1580_Warde_estimate.pdf --dry-run` was tested and prints a valid TakeoffResult. The live demo (without `--dry-run`) was **not** run because no `ANTHROPIC_API_KEY` was available in this session. Acceptance criteria explicitly allows this.

## Confidence math

Per CONTRACT.md §Confidence:

```
confidence = min(scale.confidence, classification.confidence) × dimensionSourceTypeBoost
```

With `boost = { measured: 1.0, annotated: 0.95, inferred: 0.6 }` and a hard floor of `0.10`. Implemented in `extract.ts::pageToArtifactAndQuantities`.

## Prompts

`PROMPT_VERSION = "blueprint-vision/v0.3"`. The same string lands in `BlueprintArtifact.promptVersion` and in every quantity's `provenance.detectorVersion`, so a future re-prompt can be diffed against earlier outputs by comparing this string.

Two prompts:

- `CLASSIFY_PROMPT`: per-page kind + confidence + reasoning. One call, all pages at once.
- `EXTRACT_PROMPT`: only run on pages classified `floor_plan` or `site_plan`. Asks for image-pixel polygons + verbatim dimension strings. Explicitly tells the model **not** to compute feet — we do that deterministically.

I did not iterate prompts on real model output (no API key); the prompts will likely need at least one revision once we see a real Opus 4.7 response and find the JSON shape it prefers to emit. Bumping the prompt version is a one-liner.

## Contract gaps

None encountered while implementing — `BlueprintArtifact`, `ProvenanceBlueprint`, and `applyReviewFloor` covered everything I needed. One ergonomic note for future work: the schema's `BlueprintArtifact.pages[].titleblock` is optional but its inner fields are mostly optional too, so the model may emit partial titleblocks. The current implementation of `cleanTitleblock` strips `null`/`undefined` fields before serialising.

## Files

- `src/prompts.ts` — the two prompt strings + `PROMPT_VERSION`.
- `src/responseSchemas.ts` — zod schemas for the model's classify + extract responses.
- `src/dimensions.ts` — `parseDimensionToFeet`, `parseArchitecturalScale`, `pixelsPerFootFromScaleText`, `dimensionMatches`.
- `src/geometry.ts` — `polygonAreaPx2` (shoelace), `polygonPerimeterPx`, `polygonBbox`, `segmentLengthPx`.
- `src/anthropicClient.ts` — `callClaudePdfJson` wrapper + tolerant JSON parser (strips a stray ```json fence if the model leaks one).
- `src/extract.ts` — `buildBlueprintTakeoff`, `calibrateScale`, `NoDrawingsFoundError`, dry-run mocks.
- `src/cli.ts` — commander-based CLI; supports `--known-dim`, `--wall-height`, `--out`, `--project-id`, `--model`, `--assumed-dpi`, `--dry-run`.
- `src/index.ts` — public exports.
- `fixtures/` — `tiny.pdf` (2-page minimal PDF for hashing), `mock-claude-classify-response.json`, `mock-claude-extract-response.json`, `expected-takeoff-from-mock.json`.
- `test/` — `dimensions.test.ts`, `geometry.test.ts`, `buildBlueprintTakeoff.test.ts`.
