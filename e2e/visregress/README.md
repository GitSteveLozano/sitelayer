# sitelayer visual-regression gate (`visregress`)

A **semantic** visual-regression gate over sitelayer's top screens. It kills the cosmetic-noise
false-fails that plague pixel-diff while still catching real breaks.

## Why this exists

Pixel-diff magnitude does not rank regressions — a 1px cosmetic shift can produce a _larger_ diff
than a missing control. So this is a **two-tier** gate (the shared `visregress` analyzer):

1. **Tier 0 — pixel gate (~8ms, $0, deterministic):** did anything change, and _where_ (bbox).
2. **Tier 1 — VLM judge (local `qwen3-vl-8b`, $0, only on a gated change):** is it a _real_
   regression? Returns `{is_regression, type, what_changed}`. Cosmetic shifts are dismissed.

A **gate-block floor** (`BLOCK_GATE_PCT`, default 2%) blocks large changes even when no VLM is
reachable, and the judge **fails closed** if the VLM is down — so a runner without the GPU still
gates instead of silently passing.

## Baselines

Baselines live in `e2e/visual/__baselines__/<id>.png`, captured by the visual config:

```bash
# capture/refresh against the persistent dev tier (default):
npx playwright test -c e2e/visual.config.ts
# or against a local stack:
E2E_BASE_URL=http://localhost:3100 npx playwright test -c e2e/visual.config.ts
```

Three gated screens (the top-value surfaces): `takeoff-3d-demo` (public, client-side fixtures →
byte-stable), `rental-billing-review`, `estimate-push-review`. The two financial review screens are
REAL, data-bearing captures of the seeded review surfaces (the billing run + estimate push from the
`e2e-fixtures` tenant, rendered against a seeded local stack via the `e2e/fixtures/auth.ts` act-as
admin identity) — NOT generic SPA-shell placeholders. Re-running the capture spec REFRESHES the
baselines — do it only when the current UI is the known-good reference, against a SEEDED stack:

```bash
npm run seed:e2e   # idempotent; seeds the e2e-fixtures tenant (billing run, estimate push, …)
E2E_BASE_URL=http://localhost:3000 npx playwright test -c e2e/visual.config.ts
```

If the seeded stack genuinely cannot be brought up, do NOT ship placeholder PNGs for the two auth
screens — drop them and scope the gate to `takeoff-3d-demo` until a seeded capture is available.

## Run the gate (end-to-end — renders a FRESH candidate, not a no-op)

```bash
npm run test:visregress     # exit 0 clean / exit 2 on a confirmed regression
```

`run.mjs` runs the gate end-to-end:

1. **clean** any stale candidates under `e2e/visual/__candidates__/`,
2. **render a fresh candidate** of each gated screen via this repo's Playwright
   (`e2e/visual.config.ts` + `top-screens.visual.spec.ts` with `VISUAL_SNAP_DIR=__candidates__`)
   against `E2E_BASE_URL` (defaults to the local app, `http://localhost:3000`),
3. **pair** each committed baseline with its fresh candidate and run the shared analyzer,
4. **exit 2** on a confirmed regression so CI / the pre-push hook fails.

Only screens that produced a fresh candidate are gated. If **no** candidate renders (no app
reachable), the gate exits **1** and refuses to "pass" on stale baseline-vs-baseline pairs — it
never reports a green no-op. The two financial review screens need a seeded stack
(`npm run seed:e2e`, app at `E2E_BASE_URL` with the `e2e/fixtures/auth.ts` act-as identity);
`takeoff-3d-demo` is public and renders without auth.

Env: `VISREGRESS_HOME` (shared analyzer checkout, default `~/projects/model-bench`),
`E2E_BASE_URL` (app to capture candidates from, default `http://localhost:3000`),
`JUDGE` (`local`|`deepinfra`|`gemini`, default `local`/$0), `SIGNAL_URL` (relay to emit to),
`BLOCK_GATE_PCT` (default `0.02`), `VISREGRESS_SKIP_CAPTURE=1` (reuse existing `__candidates__`,
e.g. CI already rendered them or to gate an injected break).

## Pre-push gate

The repo-tracked pre-push hook (`.githooks/pre-push`, active via `git config core.hooksPath
.githooks` — installed by `scripts/install-git-hooks.sh` / `npm run hooks:install`) runs
`npm run test:visregress` on a push to `dev`/`main`. A confirmed regression (analyzer exit 2)
**blocks the push**. If no app is reachable (exit 1), the visual sub-gate is a non-blocking SKIP
(bypass that sub-gate only: `PREPUSH_SKIP_VISREGRESS=1`; bypass the whole hook: `git push
--no-verify`).

## Emit (envelope format — relay-conformant)

On a confirmed regression (and only when `SIGNAL_URL` is set), the adapter POSTs a
`visual.regression.detected` ProjectEvent through sitelayer's existing `/api/signal` relay.

**The shape matters.** `apps/api/src/routes/signal.ts` runs `@operator/projectkit`
`validateProjectEvent` on every inner event, which **requires** `schema_version`, `event_type`,
`project_key`, `occurred_at` (+ optional `payload`). The shared analyzer builds exactly that with
`--emit-format envelope --project-key sitelayer`, so `run.mjs` lets the analyzer emit — it passes
`--emit-url $SIGNAL_URL --emit-format envelope --project-key sitelayer` and no longer hand-rolls an
envelope (the old local `buildEnvelope` was removed). sitelayer emits; mesh (or any sink at
`SIGNAL_URL`) subscribes; this code never imports mesh.

## The analyzer is shared, not vendored

`run.mjs` is a thin adapter; the gate+judge engine lives in the shared `visregress` analyzer
(invoked via `VISREGRESS_HOME`), the same one used by chess/nhl/learn/sandolab/winwar. Do not copy
the engine into this repo.
