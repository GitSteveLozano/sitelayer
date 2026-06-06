# Catalog package — notes & spec deviations

## Contract gaps & how we handled them

### 1. Multiple SKUs at the same CSI code with the same unit

The CONTRACT.md / brief says: "If multiple SKUs match the code, pick the one whose `unit` matches the quantity's `unit`; if none match, pick the first and emit a warning". This rule under-specifies when **multiple SKUs match both code and unit** — which is the common case in our seed catalog (e.g. `08 14 16` has 30"/32"/36" hollow-core doors, all unit `ea`). Our matcher today picks **the first** of those by source order in `seed.yaml`. That means a "32" door" `TakeoffQuantity` may be priced as a 30" door if the 30" SKU appears earlier.

**Reconciliation needed:** the contract should grow either

- a `serviceItemCode` (SKU) hint on `TakeoffQuantity` (preferred — it's the explicit precedence-tier-1 the QBO mapping doc already calls for), or
- a richer matcher key (e.g. dimensional facets in description) and a tie-breaker rule.

Until that happens, the spike runs with first-by-source-order. We sorted `seed.yaml` so the more common variants appear first within each CSI block.

### 2. Unmatched quantities

The brief notes: "If no SKU matches the masterformatCode at all, **skip the quantity** but emit it in a returned `unmatched` warnings array." `PricedEstimate` has no place to put this. We chose to:

- keep `priceEstimate(takeoff, opts) → PricedEstimate` exactly per CONTRACT.md (no extra fields),
- add a sibling `priceEstimateWithDetails(takeoff, opts) → { estimate, unmatched }` that the CLI / orchestrator calls when it wants the warnings.

This keeps the canonical signature load-bearing without polluting the schema. Reconciliation suggestion: add an optional `warnings: TakeoffWarning[]` field to `PricedEstimate` next pass, mirroring `TakeoffResult.warnings`.

### 3. Confidence on lines with unit mismatch

Spec says "multiply by 0.7" when the matched SKU's unit doesn't equal the quantity's unit. We do exactly that, on top of `qty.confidence × catalogItem.confidence`. The result is clamped to `[0, 1]`.

### 4. CSI-code formatting in `csiCode`

The schema accepts both `NN NN NN` (Level 3) and `NN` (division-only) for `CatalogItem.csiCode`. We keep our seed at Level 3 across the board and rely on the matcher's fallback-to-division branch in `lookupByCsi` for division-only takeoff codes.

### 5. `confidence` on `CatalogItem`

The spec asks for `0.85` (manual entry, fresh prices) — applied uniformly to all rows. This decays line confidence on multiplication with `qty.confidence`, which is the right behaviour: nothing in this catalog is more reliable than the operator's confidence in the price.

## What we did **not** ship in v1

- **`toSitelayerEstimateLines` adapter** — research/05-pricing.md §7 calls this out as the seam for `apps/api/src/routes/estimate.ts:118-135`. Deferred to Phase 3 per CONTRACT.md Open Question 6.
- **BLS PPI freshness multiplier** — would multiply unit prices by a quarterly-published divisional index. Deferred; the per-row `pricedAt` flag is the freshness hook.
- **Per-region (city cost index) overrides.** Catalog assumes one region; the YAML loader could grow a `regionMultipliers` table later.

## Files in this package

```
src/index.ts          — loadCatalog, lookupBySku, lookupByCsi, priceEstimate, renderEstimateHtml
src/cli.ts            — tsx CLI: takeoff.json → PricedEstimate JSON + estimate.html
src/seed.yaml         — 40 hand-curated SKUs, MasterFormat 03/06/07/08/09/10
fixtures/             — sample-kitchen-takeoff.json (8 quantities)
test/catalog.test.ts  — vitest: round-trip, totals math, lookup, HTML render
```
