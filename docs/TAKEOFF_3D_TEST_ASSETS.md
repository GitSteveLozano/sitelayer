# Takeoff 3D Test Assets

Status: initial research pass, 2026-05-20.

## What We Need

The 3D takeoff preview needs two different fixture classes:

1. **Deterministic geometry fixtures** for CI. These should be tiny mocked
   `takeoff_measurements` rows with known board-space coordinates. They test
   the renderer and mapper without depending on a live DB or model output.
2. **Public blueprint/image fixtures** for manual demos and model-evaluation
   spikes. These can be downloaded on demand and should not block CI.

Do not use random web images or current commercial plan-set PDFs unless the
license is explicit. For a customer-facing product, ambiguous fixture provenance
creates unnecessary cleanup work later.

## Recommended Public Blueprint Sources

### 1. Library of Congress HABS/HAER/HALS

- URL: <https://www.loc.gov/pictures/collection/hh/>
- Example house records/sheets to vet first:
  - Eames House floor plans:
    <https://www.loc.gov/pictures/item/ca4169.sheet.00002a/>
  - Colonel John Cox House first-floor plan:
    <https://www.loc.gov/pictures/item/dc0329.sheet.00003a/>
  - Robie House survey:
    <https://www.loc.gov/pictures/item/il0039/>
- License posture: item-level rights review required. The collection is a good
  first place to look because it contains measured drawings, large-format
  photographs, and written histories from the National Park Service / Library of
  Congress survey programs.
- Format: mixed JPEG/TIFF/PDF-style measured drawing sheets plus photos and
  reports.
- Use: best customer-demo source when we need a credible public blueprint and
  optional paired building photos.
- Limitation: historic drawings are not the same as modern contractor plan sets.
  Use them as public fixtures, not as evidence that modern ReLease PDFs are
  solved.

### 2. Wikimedia Commons: `House plans.pdf`

- URL: <https://commons.wikimedia.org/wiki/File:House_plans.pdf>
- Original file: linked from the Commons file page.
- License posture: public domain in the United States. Commons records it as
  published before January 1, 1931.
- Format: PDF, 2,150 x 1,404 px preview, 3.25 MB.
- Use: best first manual fixture. It is a house plan, public-domain, small
  enough to download quickly, and useful for Gemini/Claude extraction tests.
- Limitation: historical drawing style; not representative of modern ReLease
  construction PDFs.

### 3. Wikimedia Commons: Floor plans of houses category

- URL: <https://commons.wikimedia.org/wiki/Category:Floor_plans_of_houses>
- License posture: per-file; must inspect each file page before use.
- Format: mixed PNG/JPG/PDF/TIF/SVG.
- Use: source pool for a small manually-vetted fixture pack: one clean raster,
  one scanned historical plan, one multi-sheet HABS/LOC drawing, one PDF.
- Limitation: category membership is not a license. Each file needs its own
  license check.

### 4. MLStructFP

- URL: <https://github.com/MLSTRUCT/MLSTRUCT-FP>
- License posture: MIT license for the repo; dataset includes 954 floor-plan
  images plus wall annotations per README.
- Format: images plus JSON-style annotations through the loader.
- Use: model-evaluation substrate for wall/room extraction and geometry
  comparison.
- Limitation: larger dependency and dataset workflow; not a quick CI fixture.

### 5. CubiCasa5K

- URL: <https://github.com/CubiCasa/CubiCasa5k>
- License posture: non-commercial/share-alike dataset license; do not use for a
  Sitelayer product or customer demo without a separate rights decision.
- Format: floor-plan images with dense polygon annotations.
- Use: internal CV benchmark/reference only.
- Limitation: not suitable for product assets or commercial-facing demos.

### 6. Hugging Face `JoaoMigSilva/floorplans`

- URL: <https://huggingface.co/datasets/JoaoMigSilva/floorplans>
- License posture: MIT license on the dataset card.
- Format: PNG images in `images/`; dataset card lists 9,560 rows.
- Use: broad visual diversity for Gemini/Claude prompt testing.
- Limitation: card says it is intended for research/prototyping and not
  production without cleanup.

### 7. Zillow Indoor Dataset

- URL: <https://github.com/zillow/zind>
- License posture: code Apache-2.0; data under ZInD Terms of Use with explicit
  unacceptable product-use cases.
- Format: panoramas, room layouts, merged layouts, 2D floor plans.
- Use: research reading only for this project unless there is explicit approval.
- Limitation: not suitable for Sitelayer product/test fixtures under the current
  terms.

## House Photos

House photos are not required for v1. The preview renders reviewed takeoff
geometry. Photos become useful only for later "image(s) to floor plan" or
"photo plus blueprint consistency" research.

If photos are needed for a demo, prefer Wikimedia Commons / Library of Congress
files with explicit public-domain or permissive licenses, and record the file
page URL next to the downloaded asset. Avoid Zillow/Matterport-style residential
photo datasets unless the license explicitly permits product development.

## Gemini / Multimodal Use

Use Gemini or Claude multimodal to extract constrained 2D annotations only:

- room or wall polygons in board coordinates;
- lineal runs for walls, trim, or insulation;
- count points for doors, windows, fixtures, or openings;
- scale/calibration candidates with confidence and cited visual evidence.

Do not ask the model to generate a full house, structural assembly, roof system,
OBJ/GLTF mesh, or physically correct reconstruction from a single plan page. The
Sitelayer-safe path is: multimodal model proposes 2D takeoff geometry, a human
reviews it, and the deterministic preview extrudes that reviewed geometry into a
2.5D scene.

## Testing Approach From Sources

- Playwright visual comparisons can create baseline screenshots with
  `toHaveScreenshot`, but the docs warn rendering can vary by OS, browser,
  hardware, power source, and headless mode. For this route, avoid committing a
  fragile pixel-perfect baseline first.
- Playwright screenshots can be captured into a buffer and post-processed. The
  smoke test uses that route: element screenshot of the canvas, then PNG pixel
  signal checks.
- WebGL `readPixels` exists, but framebuffer reads can be sensitive to render
  timing and context settings. Element screenshots are the more robust first
  CI signal for "nonblank canvas".

## Current In-Repo Coverage

- `apps/web/src/lib/takeoff/geometry-3d.test.ts`: pure mapper coverage.
- `e2e/tests/takeoff-preview.smoke.spec.ts`: mocked API + WebGL canvas smoke,
  plus public demo fixture switching and debug-payload coverage.
- `apps/web/src/screens/projects/takeoff-preview-demo-fixtures.ts`: synthetic
  public demo fixtures for house-plan, floor-plan, and exterior-reference
  critique loops.

Command:

```bash
npm run takeoff-preview:smoke
```

The smoke fixture intentionally does not download public blueprints. It proves
that Sitelayer can render a deterministic project/draft/blueprint scene. Public
blueprints should be used in a separate manual/model-evaluation workflow.

The public route at `/demo/takeoff-preview-3d` is the current manual bridge for
that workflow. It does not embed third-party images yet; instead it provides
fixture switching plus exportable JSON so model critiques can be run before we
commit to asset provenance, storage, or customer-data handling.
