# PlanSwift Phase 2 — Parts / Assembly Engine: Implementation Plan

> Source brief: `docs/PLANSWIFT_PARITY_PLAN.md` §2-C / §4 — "drag an assembly
> onto a takeoff and it explodes into material + labor + equipment + sub
> quantities with formulas and waste."
>
> This is the file-level build plan synthesized from the 5 Phase-2 research
> reports. It is **build-order ordered**. Each step marks exactly what is
> **REUSED** (already in the repo, do not duplicate) vs **NEW**.

---

## 0. Design decisions (resolved up front)

These are the product/engineering calls the research flagged as open. They are
**decided here** so the build is unambiguous.

| Decision                                                | Choice                                                                                                                                                                                                                                                                                             | Why                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where does explosion live?**                          | In the existing recompute path `createEstimateFromMeasurements()` (`apps/api/src/routes/estimate.ts`), at the seam _after_ `resolvePrices` and _before_ the `estimate_lines` insert.                                                                                                               | Report 2 identified this as the single clean seam. One transaction already wraps it (`withMutationTx`). No new orchestration.                                                                                                                                                                                   |
| **How is an assembly attached to a measurement?**       | Add a nullable `assembly_id` FK column to `takeoff_measurements`. `NULL` → current flat-line behavior; set → explode.                                                                                                                                                                              | Report 1 §1. Smallest possible change; the measurement is the natural anchor and already flows through recompute.                                                                                                                                                                                               |
| **Reuse the existing assembly tables or add new ones?** | **REUSE** `service_item_assemblies` + `service_item_assembly_components`. Do **not** introduce `catalog_parts` / generic `assembly_components` for Phase 2.                                                                                                                                        | Reports 1 & 3 agree the existing schema is correct and the resolver (`resolveAssembly`) is already written against it. A separate parts catalog + nested assemblies (Report 3's proposal) is **deferred** — it is a bigger refactor with no pilot demand. The wedge (cladding pack) needs flat components only. |
| **Equipment kind?**                                     | Reuse the existing 4-kind enum `material \| labor \| sub \| freight`. Map "equipment" onto `sub` lines for the pilot (scaffolding is already modeled as `sub` in Report 5's pack). Do **not** widen the CHECK constraint.                                                                          | Widening an enum touches the immutable-constraint surface and the markup buckets. The cladding pack has zero true "equipment" lines that aren't sub-lettable. Revisit only if a pilot assembly genuinely needs it (forward migration, expand markup buckets).                                                   |
| **Formulas?**                                           | **Ship** the formula evaluator as a new `packages/formula-evaluator` package, and add nullable `quantity_formula` + `formula_vars` columns. `NULL formula` → use static `quantity_per_unit` (fully backward compatible).                                                                           | Report 4. The evaluator is small and the live-preview UX is the PlanSwift selling point. Keep it optional so the cladding seed (static quantities) ships even if formula UI slips.                                                                                                                              |
| **Markup / waste application**                          | The per-component `waste_pct` stays applied inside `resolveAssembly` (board-level scrap). `applyMarkup` (pricing-profile burden/margin) is applied **on top** of the per-kind subtotals at recompute time and persisted as part of the explosion math.                                             | `markup.ts` is REUSED exactly as-is. Per-component waste and profile-level waste/burden are different layers — both already modeled.                                                                                                                                                                            |
| **Provenance / live-link vs frozen**                    | Estimate lines carry `assembly_id` + `assembly_component_id` (nullable). Lines are a **frozen snapshot at recompute time** — editing an assembly does NOT retroactively rewrite existing lines; the estimator re-runs recompute to pick up changes (recompute already wipes+rebuilds draft lines). | Matches the existing recompute contract (it already deletes+reinserts every line per draft). No new "regenerate" concept needed.                                                                                                                                                                                |
| **count-kind measurements**                             | Assemblies are per-unit recipes; allow attaching to any measurement. The resolver multiplies by `measurement.quantity` regardless of unit. Unit _mismatch_ between assembly header and measurement is surfaced as a soft warning in the UI, not a hard block.                                      | Pilot estimators know their units; a hard block creates friction.                                                                                                                                                                                                                                               |

---

## 1. Data model + Migration 109 (NEW — immutable)

**File:** `docker/postgres/init/109_assembly_explode_and_formulas.sql` (NEW)

Next number is **109** (108 is the latest). This migration is **forward-only,
additive, idempotent** (expand step). Every existing row keeps its exact
current behavior because all new columns are nullable / defaulted.

It touches three existing tables — **no new tables** (reuse decision above):

### 1a. `takeoff_measurements` — add assembly attach point

```sql
ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS assembly_id uuid;

-- Composite FK keeps the assembly company-scoped (matches the
-- (company_id, project_id) composite FK pattern already on this table).
-- service_item_assemblies already has UNIQUE(company_id, id)? -> it does NOT
-- today; it only has PK(id). So reference by id with a company guard enforced
-- in the app layer + a plain FK to the assembly id. ON DELETE SET NULL so
-- soft-deleting an assembly never orphans a measurement write.
ALTER TABLE takeoff_measurements
  ADD CONSTRAINT takeoff_measurements_assembly_fk
  FOREIGN KEY (assembly_id) REFERENCES service_item_assemblies(id) ON DELETE SET NULL
  NOT VALID;  -- NOT VALID: skip the full-table scan on a large table; new rows
              -- are checked. (No legacy rows have a non-null assembly_id.)

-- Partial index for the recompute lookup ("which measurements have assemblies").
CREATE INDEX IF NOT EXISTS takeoff_measurements_assembly_idx
  ON takeoff_measurements (company_id, assembly_id)
  WHERE assembly_id IS NOT NULL AND deleted_at IS NULL;
```

> **Note for implementer:** confirm whether `ADD CONSTRAINT ... IF NOT EXISTS`
> is supported on the target PG18 — if the runner re-applies, wrap the
> constraint add in a `DO $$ ... EXCEPTION WHEN duplicate_object THEN null; END $$;`
> block (the same defensive idiom used in 101_v2_rls.sql). The index and column
> use `IF NOT EXISTS` directly.

### 1b. `service_item_assembly_components` — add optional formula columns

```sql
ALTER TABLE service_item_assembly_components
  ADD COLUMN IF NOT EXISTS quantity_formula text,            -- e.g. "measurement_quantity * 1.1 / coverage_rate"
  ADD COLUMN IF NOT EXISTS formula_vars jsonb;               -- e.g. {"coverage_rate": 32}

ALTER TABLE service_item_assembly_components
  ADD CONSTRAINT service_item_assembly_components_formula_len_chk
  CHECK (quantity_formula IS NULL OR length(quantity_formula) <= 500);  -- DoS guard (Report 4)
```

Semantics: when `quantity_formula IS NOT NULL`, the resolver evaluates it with
`measurement_quantity` + `formula_vars` bound, and that result replaces
`quantity_per_unit` for that component. When NULL, the static
`quantity_per_unit` path runs unchanged (backward compatible).

### 1c. `estimate_lines` — add provenance columns

```sql
ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS assembly_id uuid,                 -- which assembly produced this line (NULL = hand/flat line)
  ADD COLUMN IF NOT EXISTS assembly_component_id uuid,       -- which component within it
  ADD COLUMN IF NOT EXISTS kind text;                        -- material|labor|sub|freight for assembly-sourced lines; NULL for flat lines

ALTER TABLE estimate_lines
  ADD CONSTRAINT estimate_lines_kind_chk
  CHECK (kind IS NULL OR kind IN ('material', 'labor', 'sub', 'freight'));

CREATE INDEX IF NOT EXISTS estimate_lines_assembly_idx
  ON estimate_lines (company_id, project_id, assembly_id)
  WHERE assembly_id IS NOT NULL;
```

No FK from `estimate_lines.assembly_component_id` to the component table — lines
are a **frozen snapshot**; a later component delete must not cascade-wipe a
historical estimate line. Provenance is informational (UI grouping), not
referential.

### 1d. RLS for new columns

No new tables → **no new RLS policies needed**. The three tables already have
`company_isolation` enabled+forced (estimate_lines and takeoff_measurements via
the 066/085 rollout; assembly tables via 036 + the rollout). New columns inherit
the existing row-level policy. **Verify** with `scripts/audit-pg-schema-parity.py`
(or the repo's equivalent) after applying — do not add a redundant policy block.

### 1e. Expand / backfill / contract

- **Expand:** this migration (all columns nullable/defaulted; old readers ignore
  them; old writers never set them).
- **Backfill:** none required — every legacy measurement intentionally has
  `assembly_id = NULL` (flat-line behavior).
- **Contract:** none — nothing is removed. The old `total_rate` cache on the
  assembly header stays valid for the non-exploded "single flat rate" preview.

**Immutability:** once committed, 109 is checksummed in `schema_migrations`.
Any later correction is a new 110+ file.

---

## 2. Formula evaluator (NEW package)

**Decision:** new shared package `packages/formula-evaluator` (Report 4), depend
on `expr-eval` (~60KB, zero deps, no `eval()`, safe sandbox). NOT in
`packages/domain` (domain is types + business math; this is a sandboxed utility
imported by both API and web).

### Files (all NEW)

```
packages/formula-evaluator/
├── package.json                 # name "@sitelayer/formula-evaluator"; dep: expr-eval ^2.0.2
├── tsconfig.json                # extends the repo base tsconfig (match packages/domain)
├── README.md                    # formula syntax + examples
└── src/
    ├── index.ts                 # public API re-exports
    ├── types.ts                 # FormulaContext, FormulaResult, FormulaValidationError
    ├── evaluator.ts             # expr-eval wrapper: parseFormula / evaluateFormula
    ├── validator.ts             # validateFormula (syntax + required-var preflight)
    └── evaluator.test.ts        # Vitest
```

### Public API (`src/index.ts`)

```typescript
export interface FormulaContext {
  measurement_quantity: number
  measurement_unit: string
  [customVar: string]: number | string
}

export interface FormulaValidationError {
  code: 'SYNTAX_ERROR' | 'UNDEFINED_VARIABLE' | 'DIVIDE_BY_ZERO' | 'INVALID_RESULT' | 'TOO_LONG'
  message: string
}

export interface FormulaResult {
  ok: boolean
  value?: number
  error?: FormulaValidationError
}

export interface ParsedFormula {
  /* opaque wrapper over expr-eval Expression + referenced var names */
}

export function parseFormula(formula: string): ParsedFormula // throws on >500 chars / malformed
export function validateFormula(formula: string, requiredVars?: string[]): { valid: boolean; errors: string[] }
export function evaluateFormula(parsed: ParsedFormula, ctx: FormulaContext): FormulaResult
export function evaluateFormulaUnsafe(formula: string, ctx: FormulaContext): FormulaResult // one-shot parse+eval
```

### Implementation rules (`evaluator.ts`)

- `> 500 chars` → `TOO_LONG` (DoS guard).
- Reference a variable not in `ctx` → `UNDEFINED_VARIABLE` (expr-eval's
  `.variables()` is intersected against the supplied context keys _before_
  eval; do not silently treat missing vars as 0).
- Result `NaN` / `±Infinity` → `INVALID_RESULT` (covers divide-by-zero and
  `sqrt(-1)`). Surface `DIVIDE_BY_ZERO` specifically when a literal `/0` is in
  the AST if cheap; otherwise `INVALID_RESULT` is acceptable.
- Negative result is allowed (the caller signs by `is_deduction`), but clamp the
  absolute magnitude sanity bound at 1e9 → `INVALID_RESULT` (typo guard).
- Supported ops/functions: `+ - * / % ^`, comparisons, `&& || !`, ternary,
  `if(cond, a, b)`, and expr-eval builtins (`abs ceil floor round sqrt min max`).

### Tests (`evaluator.test.ts`)

- `"5 + 3"` → 8; `"x * 2"` with `{x:4}` → 8.
- `"measurement_quantity * 1.1 / coverage_rate"` with `{measurement_quantity:500, coverage_rate:32}` → 17.1875.
- `"x + y"` with only `{x:1}` → `UNDEFINED_VARIABLE`.
- `"1 / 0"` → error; `"sqrt(-1)"` → `INVALID_RESULT`.
- 501-char string → `TOO_LONG`.
- Locale: `"1.5 + 2.5"` → 4 (decimal-point parsing, no comma grouping).

### Wiring

- Add `@sitelayer/formula-evaluator` to root workspace package list and to the
  `dependencies` of `apps/api`, `apps/web`. (The web import must land in an
  already-lazy chunk or the `vendor-*` group so it doesn't break the bundle
  budget — see the PlanSwift Phase 1 bundle gotcha in `CLAUDE.md` memory; route
  the est-assemblies screen's formula import through the existing desktop lazy
  route.)

---

## 3. Domain resolver extension + API (REUSE + NEW)

### 3a. `packages/domain/src/assembly.ts` — extend the resolver (REUSE + edit)

`resolveAssembly()` is **REUSED**. Extend it to accept an optional per-component
resolved quantity override so formula evaluation (which depends on the
`@sitelayer/formula-evaluator` package — domain must stay dependency-light) is
done by the **caller**, not inside domain.

Add to `AssemblyComponent`:

```typescript
  quantity_formula?: string | null
  formula_vars?: Record<string, number | string> | null
```

Change the per-component quantity line so a caller-supplied resolved quantity
wins over the static one. Cleanest shape: add an optional 4th arg
`resolvedQuantities?: Map<componentId, number>` to `resolveAssembly`. When a
component id is present in the map, use that value as the **per-unit** quantity
(i.e. it replaces `c.quantity_per_unit`); waste_pct still applies on top. When
absent, the existing `c.quantity_per_unit` path runs. This keeps the formula
dependency out of `packages/domain` and keeps the function pure.

`selectActiveAssembly` is REUSED unchanged.

### 3b. `apps/api/src/routes/estimate.ts` — explode at recompute (REUSE path + edit)

This is the core wiring. Inside `createEstimateFromMeasurements`
(`apps/api/src/routes/estimate.ts:159`), at the seam **after** `resolvePrices`
(line ~213) and **before** the `estimate_lines` INSERT (line ~242):

1. **New helper `loadAssembliesByMeasurement(executor, companyId, measurementRows)`**
   (add to `estimate.ts` or a small new `apps/api/src/assembly-explode.ts`):
   collect distinct non-null `assembly_id` values from the measurement rows, then
   one query joining `service_item_assemblies` + `service_item_assembly_components`
   (active, `deleted_at IS NULL`), returning
   `Map<assembly_id, { header, components }>`.
2. **Per measurement in the build loop:**
   - If `measurement.assembly_id` is null OR the assembly was not found (e.g.
     soft-deleted after attach) → **current flat-line path unchanged** (one line
     from the pricing chain). This is the safe fallback.
   - If found → for each component with a `quantity_formula`, call
     `evaluateFormulaUnsafe(formula, { measurement_quantity: Number(measurement.quantity), measurement_unit: measurement.unit, ...formula_vars })`.
     On error throw `HttpError(400, "Assembly <name> component <name>: <msg>")`
     (recompute aborts cleanly in-tx). Build a `resolvedQuantities` map from the
     OK results, then call `resolveAssembly(quantity, header, components, resolvedQuantities)`.
   - Apply sign: multiply every resolved line quantity + amount by
     `measurement.is_deduction ? -1 : 1` (Report 2 — deductions stay correct).
   - Emit **N estimate lines** (one per component) instead of one. Each line:
     `service_item_code` = the _component's_ mapped code if present, else the
     measurement's `service_item_code`; `quantity`, `unit`, `rate` =
     `component.unit_cost`, `amount` = signed component amount, `division_code` =
     the measurement's effective division, plus `assembly_id`,
     `assembly_component_id`, `kind`.
3. **Markup layer (REUSE `applyMarkup`)**: after building the per-kind subtotals
   for an exploded measurement, look up the project's effective pricing profile
   `config` (the same profile resolution the pricing chain already uses — pull
   `pricing_profiles.config` for the company default unless a project override
   exists) and call `applyMarkup(by_kind, profileConfig)`. For Phase 2, persist
   the **profit/burden uplift** by storing each component line at its raw cost
   and recording the markup breakdown on the response only (the estimate panel
   renders it) — OR, if the pilot wants the burden baked into stored line
   amounts, scale each kind's lines by that kind's `multiplier` from the
   breakdown before insert. **Pick the baked-in approach for Phase 2** (stored
   amounts already include waste+burden) so scope-vs-bid totals, the PDF, and the
   QBO push — which all just `sum(amount)` — stay correct with zero downstream
   changes. Return the `MarkupBreakdown` in the recompute response for UI
   transparency.

The unnest()-based multi-row INSERT is **REUSED** — just extend the parallel
arrays with `assembly_ids`, `assembly_component_ids`, `kinds` and add the three
columns to the INSERT/SELECT/`unnest` signature.

**Catalog guard:** the catalog is enforced on the **input** side (takeoff write
validates `service_item_code`). Exploded estimate lines are _derived_ and do not
re-validate (Report 2). Confirm the component's `service_item_code` (if a
component carries one) is not used to bypass the guard — components are
company-curated recipe rows, so no new catalog check is added. **If** a future
component points at an arbitrary catalog code, gate it through
`assertServiceItemCatalogStatus` (`apps/api/src/catalog.ts`) at _assembly edit
time_, not at recompute time.

### 3c. `apps/api/src/routes/assemblies.ts` — CRUD extensions (REUSE + edit)

The existing 8-branch handler is **REUSED**. Three edits:

1. **Component POST + PATCH:** accept optional `quantity_formula` (string,
   `<=500` chars, validated via `validateFormula` before insert → 400 on bad
   syntax) and `formula_vars` (object of number/string). Add both to
   `COMPONENT_COLUMNS`, the insert/update column lists, and the `ComponentRow`
   interface. `recomputeAssemblyTotal` (the cached header `total_rate`) should
   treat formula components as "indeterminate per-unit" — keep using
   `quantity_per_unit` for the cached header preview (the cache is only a
   display hint; the real math runs at explode time with a concrete
   `measurement_quantity`). Document this in a comment.
2. **NEW route `POST /api/assemblies/:id/explode`** (preview only, no DB write):
   body `{ measurement_quantity: number, measurement_unit?: string, is_deduction?: boolean }`.
   Loads the assembly + components, runs the same formula+`resolveAssembly`+`applyMarkup`
   pipeline as recompute, returns `{ resolution: AssemblyResolution, markup: MarkupBreakdown }`.
   This powers the UI live-preview and the "what will this cost" affordance
   without committing an estimate. `GET`-style read role (any company member).
3. **NEW route `PATCH /api/takeoff/measurements/:id` already exists** in
   `takeoff-write.ts` — **extend it** (do not add a new route) to accept
   `assembly_id` (uuid or null) in the body. Validate the uuid belongs to the
   company + is an active assembly (`select 1 from service_item_assemblies where
company_id=$1 and id=$2 and deleted_at is null`); reject otherwise. This is
   the "attach assembly to measurement" write. Bump the measurement `version`
   (optimistic lock already in place) and record the mutation ledger.

### 3d. `apps/api/src/routes/dispatch.ts` (REUSE + edit)

The explode preview route lives inside `handleAssemblyRoutes`, which is already
registered (dispatch.ts:519) — **no new dispatch entry needed**, just the new
branch inside the handler. The measurement-attach write is in the already-routed
`handleTakeoffWriteRoutes`. **Net dispatch change: none** (both handlers already
registered). Note this explicitly in the PR description so reviewers don't expect
a dispatch diff.

---

## 4. Web UI (REUSE + edit + NEW)

### 4a. `apps/web/src/lib/api/assemblies.ts` (REUSE + edit)

- Extend `AssemblyComponent` type with `quantity_formula?: string | null` and
  `formula_vars?: Record<string, number|string> | null`.
- Add `useExplodeAssembly()` mutation hook → `POST /api/assemblies/:id/explode`.
- Add `useAttachAssemblyToMeasurement()` hook → `PATCH /api/takeoff/measurements/:id`
  with `{ assembly_id }`, invalidating the estimate + measurements queries so the
  estimate panel recomputes.

### 4b. `apps/web/src/screens/desktop/est-assemblies.tsx` (REUSE + edit)

The editor (`AssemblyEditor`, ~line 254) is **REUSED**. Per-component-row edits:

- Add a **Formula** field to each `DraftRow` (alongside `quantity_per_unit`).
  When a formula is present, the static qty input is disabled/dimmed.
- Add a small **named-vars** editor (key/value rows) feeding `formula_vars`.
- **Live preview:** add a "preview quantity" input (a sample
  `measurement_quantity`, default 100) at the editor footer. On change (debounced
  / on blur per Report 4), call `evaluateFormulaUnsafe` from
  `@sitelayer/formula-evaluator` **client-side** for each row and render the
  resolved qty + line total inline. This reuses the existing footer
  `rowLineTotal`/preview-rate logic — extend it to prefer the formula result
  when a formula is set.
- The kind-pill `$$` aggregation (material/labor/sub/freight) is REUSED; it now
  reflects formula-driven quantities at the sample measurement.

### 4c. "Drop assembly onto measurement" — estimator flow (NEW UI in existing screens)

Two surfaces, both editing **existing** screens (do not create a new route):

1. **`apps/web/src/screens/desktop/est-quantities.tsx` (REUSE + edit)** — the
   quantities/estimate table. For each measurement-derived row, add an
   **"Assembly"** affordance: if an assembly exists for that
   `service_item_code` (reuse `useAssemblyByServiceItem`), show an "Apply
   assembly ▾" control; selecting it calls `useAttachAssemblyToMeasurement`,
   which triggers a recompute. When a row is already assembly-sourced (line has
   `assembly_id`), group its component lines under a collapsible parent showing
   the `applyMarkup` breakdown ("Materials +10% waste $2,750; Labor +15% burden
   $1,380; …") returned by recompute. This is the visible PlanSwift "explode"
   moment.
2. **`apps/web/src/screens/desktop/est-canvas.tsx` (REUSE + edit)** — the takeoff
   canvas. When a measurement is selected, add an inline "Assembly: [none ▾]"
   selector in the measurement detail/inspector. Selecting an assembly attaches
   it (same hook). Show a soft warning chip if the assembly's unit differs from
   the measurement's unit. Disable nothing — just warn.

> Routing note (from `CLAUDE.md`): these are desktop estimator screens already
> mounted; no `mobile-shell.tsx`/`App.tsx` route additions. The `vendor-pdf` /
> lazy-chunk discipline applies if the formula evaluator is imported here —
> ensure it lands in the existing desktop lazy bundle, not the main chunk.

---

## 5. Cladding starter pack seed (NEW)

Source: Report 5 — 6 exterior-cladding assemblies (EIFS Complete, 3-Coat Stucco,
Cultured Stone, Cementboard+Battens, EIFS Integral Color, Paper & Wire Envelope).
All `unit = 'sqft'`, flat components (no formulas needed for the seed — static
`quantity_per_unit` + `waste_pct`), mapping to existing LA divisions D1–D5.

**Two delivery mechanisms (do both):**

### 5a. New-company onboarding (NEW code, REUSE pattern)

`apps/api/src/onboarding.ts` → add `seedExteriorCladdingAssemblies(client, companyId)`
called from `seedCompanyDefaults` (after `service_items` are seeded, since
assemblies reference `service_item_code`). Insert each header into
`service_item_assemblies` then its components into
`service_item_assembly_components`, then `recomputeAssemblyTotal`-equivalent (or
just let the create path's recompute run). Idempotent: guard with a
`WHERE NOT EXISTS` on `(company_id, name)` so re-running onboarding doesn't
duplicate. Store the 6 assemblies as a typed constant
`EXTERIOR_CLADDING_PACK` in `packages/domain/src/index.ts` (next to
`LA_TEMPLATE` — REUSE that location) so both onboarding and any future seed
migration share one source of truth.

### 5b. Backfill seed migration for the existing LA Operations company (NEW)

The pilot company already exists, so onboarding won't fire for it. Add a small
data-only forward migration `docker/postgres/init/110_seed_cladding_assemblies.sql`
(NEW, after 109) that inserts the 6 assemblies for the LA Operations company
**only if absent** (`INSERT ... SELECT ... WHERE NOT EXISTS`, scoped by the
company slug/id lookup). Keep it idempotent and additive. (Numbered 110 because
it depends on 109's columns existing and is logically a separate concern.)

> The exact component numbers (qty_per_unit, unit_cost, waste_pct per the Report
> 5 JSON) are SME-tunable — they are seed defaults, not contract. Land them as-is;
> the pilot (Steve / LA Operations) adjusts via the editor.

---

## 6. Test plan + verify checklist

### 6a. Domain / unit (Vitest)

- **`packages/formula-evaluator/src/evaluator.test.ts`** (NEW) — see §2 cases.
- **`packages/domain/src/assembly.test.ts`** (REUSE/extend) — add cases:
  - resolver with `resolvedQuantities` override beats static `quantity_per_unit`.
  - waste_pct still applies on top of an overridden quantity.
  - deduction sign propagation across all component lines.
  - sample cladding assembly (EIFS Complete) at 1000 sqft → expected per-kind
    subtotals (assert against Report 5's `total_rate` math).
- **`packages/domain/src/markup.test.ts`** (REUSE) — confirm an exploded
  by-kind map produces the expected baked-in multipliers.

### 6b. API (Vitest, the existing localhost-pg pattern)

- **`apps/api/src/routes/assemblies.test.ts`** (NEW or extend) —
  - POST component with valid formula → 201; with bad formula → 400.
  - `POST /api/assemblies/:id/explode` returns resolution + markup; deduction
    flips signs.
- **`apps/api/src/routes/estimate-explode.test.ts`** (NEW) — the integration
  proof:
  - measurement with `assembly_id` null → one flat line (regression: existing
    behavior unchanged).
  - measurement with `assembly_id` set → N component lines, correct
    `assembly_id`/`kind`/`amount`, `sum(amount)` matches `explode` preview.
  - soft-deleted assembly attached → falls back to flat line, no crash.
  - formula error in a component → recompute returns 400, no partial write
    (tx rollback).
- **`apps/api/src/routes/takeoff-write.test.ts`** (extend) — PATCH measurement
  `assembly_id` to a valid/invalid/cross-company id → accept / 400 / 404.

### 6c. Verify checklist (pre-merge, per CLAUDE.md production rules)

1. `npm run typecheck` clean (exactOptionalPropertyTypes + noUncheckedIndexedAccess on).
2. `npm run format` (prettier `--check` is a separate Quality gate that silently
   skips the droplet deploy — see memory `sitelayer-prettier-quality-gate`).
3. `npm run lint` + `npm test` (api + domain + formula-evaluator + web units).
4. Migration 109 applies cleanly on a fresh ephemeral PG18
   (`scripts/migrate-db.sh`), checksum recorded; re-run is a no-op (idempotent).
5. `scripts/check-db-schema.sh` / schema-parity audit passes — new columns
   present, RLS still enabled+forced on all three touched tables (no new policy
   added, inherited).
6. Manual smoke (dev tier `dev.sitelayer.sandolab.xyz` via `dev` branch first,
   per CLAUDE.md deploy rule #4): create EIFS assembly → attach to a 1000 sqft
   measurement → recompute → estimate shows exploded material/labor/sub lines
   with the markup breakdown panel; detach → reverts to flat line.
7. Confirm `/api/version` build_sha advanced after the droplet deploy ran
   (don't trust a silent skip).

### 6d. Build order (summary)

1. **Migration 109** (columns) — land first; it's inert until code reads it.
2. **`packages/formula-evaluator`** — standalone, tested in isolation.
3. **`packages/domain/src/assembly.ts`** resolver override + `EXTERIOR_CLADDING_PACK`
   constant + tests.
4. **`apps/api`**: assemblies CRUD formula fields + `/explode` route +
   measurement-attach in takeoff-write + recompute explosion in estimate.ts +
   onboarding seed + tests.
5. **Migration 110** (cladding backfill seed for LA Operations).
6. **`apps/web`**: assemblies client hooks → est-assemblies formula UI +
   live preview → est-quantities/est-canvas attach + explosion breakdown.
7. Verify checklist, dev smoke, PR to `main`.

---

## Appendix — REUSE vs NEW index

**REUSE (do not duplicate):**
`service_item_assemblies` + `service_item_assembly_components` (036),
`resolveAssembly` / `selectActiveAssembly` (`packages/domain/src/assembly.ts`),
`applyMarkup` / `normalizeMarkupConfig` (`packages/domain/src/markup.ts`),
`createEstimateFromMeasurements` recompute seam + unnest INSERT
(`apps/api/src/routes/estimate.ts`), `resolvePrices`/pricing chain
(`apps/api/src/pricing.ts`), catalog guard (`apps/api/src/catalog.ts`),
the 8-branch `handleAssemblyRoutes` + its dispatch registration, the
`AssemblyEditor` UI + `useAssemblyByServiceItem`/`useAssemblies` hooks,
`withMutationTx`/`recordMutationLedger`, RLS policy bodies (066/085/101),
`LA_TEMPLATE` location in `packages/domain/src/index.ts`,
`handleTakeoffWriteRoutes` PATCH measurement path.

**NEW:**
Migration 109 (assembly attach + formula + provenance columns), Migration 110
(cladding seed backfill), `packages/formula-evaluator` package,
`POST /api/assemblies/:id/explode` route branch, `assembly_id` handling in the
measurement PATCH, the recompute explosion block + `loadAssembliesByMeasurement`
helper (optionally `apps/api/src/assembly-explode.ts`),
`seedExteriorCladdingAssemblies` + `EXTERIOR_CLADDING_PACK` constant,
`useExplodeAssembly`/`useAttachAssemblyToMeasurement` hooks, formula fields +
live preview in `est-assemblies.tsx`, attach + explosion-breakdown UI in
`est-quantities.tsx` and `est-canvas.tsx`, the new test files.

**DEFERRED (explicitly out of Phase 2 scope):**
generic reusable `catalog_parts` table, nested assemblies
(`component_type='assembly'`), a true `equipment` kind / widened CHECK enum,
live-linked (auto-regenerating) estimate lines, multi-unit conversion math,
custom company-defined function library.
