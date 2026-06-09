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
byte-stable), `rental-billing-review`, `estimate-push-review`. Re-running the capture spec REFRESHES
the baselines — do it only when the current UI is the known-good reference.

## Run the gate

```bash
npm run test:visregress     # exit 0 clean / exit 2 on a confirmed regression
```

Candidate resolution: the adapter pairs each baseline with a fresh capture of the same id under
`e2e/visual/__candidates__/` or `e2e/visual/.artifacts/`, falling back to the baseline itself (a
clean no-op pair) so the gate is always runnable.

Env: `VISREGRESS_HOME` (the shared analyzer checkout, default `~/projects/model-bench`),
`JUDGE` (`local`|`deepinfra`|`gemini`, default `local`/$0), `SIGNAL_URL` (relay to emit to),
`BLOCK_GATE_PCT` (default `0.02`).

## Emit (envelope format — relay-conformant)

On a confirmed regression (and only when `SIGNAL_URL` is set), the adapter POSTs a
`visual.regression.detected` ProjectEvent through sitelayer's existing `/api/signal` relay.

**The shape matters.** `apps/api/src/routes/signal.ts` runs `@operator/projectkit`
`validateProjectEvent` on every inner event, which **requires** four string fields:
`schema_version`, `event_type`, `project_key`, `occurred_at` (+ optional `payload` object). A
flat envelope, or the analyzer's own `--emit-url` envelope (which omits `schema_version` /
`project_key`), **422s** here. So this adapter does NOT pass `--emit-url` to the shared analyzer —
it reads the analyzer's JSON verdict and emits its own **envelope-format** event with all required
fields (`buildEnvelope` in `run.mjs`). sitelayer emits; mesh (or any sink at `SIGNAL_URL`)
subscribes; this code never imports mesh.

## The analyzer is shared, not vendored

`run.mjs` is a thin adapter; the gate+judge engine lives in the shared `visregress` analyzer
(invoked via `VISREGRESS_HOME`), the same one used by chess/nhl/learn/sandolab/winwar. Do not copy
the engine into this repo.
