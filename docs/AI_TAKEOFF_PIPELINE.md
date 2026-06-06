# AI Takeoff Pipeline — status & continuation notes (2026-06-05)

PlanSwift gap **G1/G3**: AI-assisted blueprint takeoff (plan → rooms/walls/areas/
quantities). This note captures what was built, what we learned, and how to keep
improving it. **Come back to this** — it's an active, unfinished thread.

## The goal (read this first)

**Not** pixel-perfect extraction. The goal is to **reduce the human's takeoff
work** — hand the estimator a mostly-filled takeoff to review/trim instead of a
blank sheet. So when judging the model, **recall (work pre-done) matters more than
precision (cheap deletes)**: a missed room = the human hunts for it and draws it
(expensive); an extra room = the human deletes it (cheap). Optimize for "how much
did it correctly pre-fill," not "did it avoid every false positive."

## What's built (all in `packages/pipe-blueprint`)

- **Cost model** (`cost.ts`): prices a takeoff per provider/model, and computes the
  **shadow** metered cost even on the free path, so the free→paid jump is known
  up front. Verified Gemini Standard pricing (2026-06-05) + `BATCH_DISCOUNT`
  (Batch = 50% off, and takeoff is async → batch is the real scale rate) +
  `RECOMMENDED_TAKEOFF_MODEL`. **Pricing is volatile — re-verify the table against
  ai.google.dev/gemini-api/docs/pricing periodically.**
- **Provider abstraction** (`provider.ts`): one prompt+JSON contract, swappable
  backend — `createCliProvider` (gemini-cli/agy, $0 subscription, injectable
  runner, `@file` prompt, no `-m`), `createGeminiApiProvider` (paid, priced from
  real `usageMetadata`), `createStubProvider`. Mirrors the worker media-engine seam.
- **Provider-pluggable pipeline**: `buildBlueprintTakeoff({ visionProvider })`
  routes classify+extract through the provider (gemini) instead of Claude, via the
  same zod validation. Additive/opt-in — Claude stays the default.
- **Tools** (`scripts/takeoff-vision/`): `run-vision.ts` (one plan → takeoff +
  cost), `compare-models.ts` (all Gemini models, ranked by cost/quality/latency),
  `score-cubicasa.ts` (accuracy vs ground truth; `api`|`cli` provider arg).

## What we learned

### Model bang-for-buck (real 7-model run on a sample blueprint, ~$0.044)

- **The entire Gemini 2.5 generation FAILS this task** (invalid/empty; 2.5-pro
  returned nothing). Only **Gemini 3.x works.**
- **Winner: `gemini-3.1-flash-lite`** — cheapest ($0.003/takeoff Standard,
  **$0.0015 batch → $1.50/1000**), fastest (~1.5s API), best-balanced extraction.
  3.5-flash / 3.1-pro cost 4–5× more for worse/incomplete output.

### Accuracy baseline (3 CubiCasa plans, room count + type recall — scale-free)

| path                        | room recall | over-count | latency | cost    |
| --------------------------- | ----------- | ---------- | ------- | ------- |
| API `gemini-3.1-flash-lite` | 95%         | +3 rooms   | ~1.5s   | $0.0015 |
| CLI ($0 subscription)       | 95%         | +8.3 rooms | 20–85s  | $0      |

- **Both find the real rooms (95% recall)** → both give a strong human head-start.
- **API is the better assistant**: same recall, **less cleanup (+3 vs +8) and
  13–55× faster.** The free CLI auto-picks a heavier model that over-segments and
  is slow. Confirms the plan: **CLI for $0 dev/proving, paid API at scale.**
- The weakness is **over-counting** (spurious rooms: closets/halls/“other”,
  duplicate baths) — the cheap-to-fix direction, and tunable.

## Validation corpus (local only — internal benchmarking, NOT for bundling)

Stored on the big drive, reached via the gitignored symlink `data/takeoff-corpus`
→ `/mnt/backup/sitelayer-takeoff-corpus/` (manifest README in that dir).

- **CubiCasa5K** (5,000 real plans, vector room/wall GT, areas m²/lengths m) —
  downloaded (5.5 GB). `<id>/model.svg` holds GT (`<g class="Space <Type>">` rooms,
  `class="Wall"`), `F1_scaled.png` is the plan. Caveat: per-plan metric scale
  unreliable on a subset (GH issue #20) — QA the scale before absolute dimensions.
- **AUST CE 208 lab manual** (PDF) — dimensioned sketches + **worked quantity
  takeoffs** (bricks/cement/concrete) — the only true _quantity_-derivation answer
  key; validates areas/lengths→materials. Imperial.
- **Licensing**: every realistic corpus is non-commercial/academic — fine for
  internal accuracy measurement + prompt examples, **not** for shipping reference
  data. Only **ResPlan** (17k plans, claimed permissive) might be commercial-usable
  — its download URL is unconfirmed; chase it if we ever need shippable data.
- ~~Rent3D~~ (the “top metric pick”) — its data tar.gz 404s; host removed it. Needs
  an author email or a mirror.

## How to run

```bash
# one plan → takeoff + cost (free CLI)
npx tsx scripts/takeoff-vision/run-vision.ts <plan.pdf|png> gemini-cli
# rank every Gemini model by cost/quality (paid API, a few cents)
GEMINI_API_KEY=... npx tsx scripts/takeoff-vision/compare-models.ts <plan>
# accuracy vs CubiCasa ground truth (api or cli)
GEMINI_API_KEY=... npx tsx scripts/takeoff-vision/score-cubicasa.ts <sampleDir> gemini-3.1-flash-lite api
```

## How to continue / improve (priority order)

1. **Prompt-tune the over-counting** — "only enclosed habitable rooms; don't split
   closets/halls/dimension zones; merge duplicates." Re-score; expect +3/+8 → ~0.
   Cheap, directly improves the "less human cleanup" metric for both paths.
2. **Absolute-area accuracy** — parse CubiCasa's px→meter scale (the dimension
   labels / a wall whose `DimensionMeasureLabel` gives real length) so we score
   real **sqft error**, the number that actually drives the estimate. Add a
   QA/scale-recovery pass per issue #20.
3. **Scale to 50–100 plans** for a baseline we can trust (CubiCasa has 5,000 local).
4. **Per-room IoU matching** for true precision/recall + per-room area error.
5. **Wire into the capture endpoint** — env-gate `/takeoff-drafts/capture` to build
   a `createGeminiApiProvider('gemini-3.1-flash-lite')` and pass it as
   `visionProvider`, so a real takeoff DRAFT gets created from a plan (review-
   required, like the existing blueprint_vision path). This is what makes it usable.
6. **Batch tier** — route the real volume through the Gemini Batch API (50% off,
   takeoff is async).
7. **The scan/CV half** (G3) — raster site photos / scanned plans, not just clean PDFs.

## Open items / gotchas

- **Git push hold (2026-06-05)**: the provider-pluggable commit + these harnesses
  were developed in the `dev-land` worktree while ANOTHER agent had ~8 unpushed
  commits on `dev` (the steve-repro-reporting capture work). Pushing `dev` would
  also push their deferred work — left for the operator to coordinate. Don't blindly
  `git push origin dev` from here without checking `origin/dev..HEAD`.
- The paid `anthropic-api` provider isn't implemented (cost.ts prices it; only
  gemini-api + cli + stub providers exist).
- Re-verify model lineup + pricing before trusting absolute $ — the table is a
  dated snapshot and Gemini moves fast (training-data assumptions were stale).
