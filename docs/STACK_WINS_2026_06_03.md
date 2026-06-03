# Stack improvements — 2026-06-03

A pass over the stack ("make it better") landed a coherent set of resilience /
security / observability / dev-velocity wins. This records what shipped, what
was deliberately deferred (with rationale), and the operator-account follow-ups
that need a human (they're console config, not code).

## Shipped + live (main → dev + demo, prod untouched)

| Win                                | Where                                                                                         | Why it matters                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queue exponential backoff + jitter | `packages/queue/src/index.ts` (both claim paths)                                              | Flat 5-min retry was a thundering-herd risk; now `min(6h, 5s·2^attempt)·jitter`. First retry ~2.5–5s.                                            |
| Zod request-validation boundary    | ~50 `apps/api/src/routes/*.ts`                                                                | Untrusted JSON now validated before SQL / outbox / reducers. Permissive (optional/nullish/loose) — no valid client 400s.                         |
| Sentry single-pane logs            | `apps/{api,worker}/src/instrument.ts`, `packages/logger`                                      | `enableLogs` + Pino→`Sentry.logger.*` keyed by the existing trace_id. Logs + traces in one pane. No-op without DSN.                              |
| Worker heartbeat                   | `apps/worker/src/worker.ts` (`WORKER_HEARTBEAT_URL`)                                          | External uptime monitor can watch the worker drain loop.                                                                                         |
| tsgo fast typecheck                | `npm run typecheck:fast` (`@typescript/native-preview`)                                       | ~4× faster local typecheck. Stock `tsc` stays the release gate; tsgo is typecheck-only.                                                          |
| Periodic-job-fleet observability   | `001_job_runs.sql` + worker `runners/job-runs.ts` + `GET /api/admin/jobs` + web `/admin/jobs` | ~20 runners had cadence but no visibility. New GLOBAL `job_runs` ledger (no scheduler added) + read-only admin page (job status + queue health). |

All gated by `scripts/verify-local.sh` (static+build+unit+integration) and
verified live (dev/demo `SMOKE-OK`, db healthy, `/api/admin/jobs` → 401 unauth).
`001_job_runs.sql` is the first post-baseline migration (additive: one global
table, no RLS — mirrors `dispatch_lanes`).

## Deliberately deferred (rationale, not fatigue)

These were on the candidate list but are poor-ROI / high-friction for this
codebase **right now**. Each has a concrete unblock condition.

- **SafeQL (`@ts-safeql/eslint-plugin`)** — built for tagged-template `` sql`...` ``;
  this codebase uses plain `client.query(text, params)` deliberately (raw-SQL is
  the chosen path — see CLAUDE.md "Database ORM"). SafeQL would (a) need a **live
  DB at lint time**, which fights the no-DB `static` gate stage, (b) match
  arbitrary `.query()` across many client var names → false-positive-prone, and
  (c) add a heavy native dep (libpg-query/node-gyp). _Unblock:_ only worth it
  alongside a SQL-extraction retrofit (tagged template or `.sql` files). At that
  point evaluate **PgTyped** (CLAUDE.md already names it the better fit — a
  build-time SQL→TS generator) instead. Either way it's a multi-day retrofit, not
  a slice.
- **OpenAPI codegen (Zod → openapi-typescript)** — the Zod schemas just added are
  intentionally **permissive** (everything optional/nullish/loose to avoid 400ing
  valid clients). Generating types from them now yields all-optional frontend
  types with near-zero compile-time value. The prerequisites are a central schema
  **registry** (schemas are inline per-route today) **and tightening** the
  schemas. _Unblock:_ do the registry + tighten high-traffic write schemas first;
  codegen is the last step, not the first.
- **`tsc -b` project references** — composite build across 17 tsconfigs. Real
  incremental-build win but error-prone to set up, and the build already uses
  `scripts/build-parallel.sh` (tiered). _Unblock:_ a focused, separately-gated PR
  when build time becomes a measured pain.
- **vitest `projects`** — attempted and **reverted**: projects-mode fights the
  repo's `npm run test --workspaces` per-package invocation ("No projects found").
  Don't retry without moving the whole repo to a single root vitest run.

## Operator-account follow-ups (human / console — not code)

The observability we can do in-repo is shipped; these flip on external services:

1. **Grafana Cloud Free — scrape `/api/metrics`.** The Prometheus endpoint exists
   (gated by `API_METRICS_TOKEN`) but nothing scrapes it. Add a Grafana Cloud
   (free tier) hosted scrape / agent against `https://sitelayer.sandolab.xyz/api/metrics`
   with the bearer token → dashboards + alerting for free.
2. **Better Stack (or any) uptime monitor** — point at prod `/health` and the new
   `WORKER_HEARTBEAT_URL` (set the env on the worker to a Better Stack heartbeat
   URL) so a stalled worker pages you.
3. **DO Managed-DB Insights alerts** — enable connection/CPU/disk alerts in the
   DigitalOcean console for `sitelayer-db`. Free, no code.
4. **DO PgBouncer (transaction mode)** — confirmed SAFE for this app (no
   session-level state that transaction pooling breaks; RLS GUC is `SET LOCAL`,
   tx-scoped). Front the managed DB with PgBouncer in the DO console for
   connection headroom; no code change required.

## Postgres ↔ client sync: skip-but-watch

No action needed now. DO managed PG has **no logical-replication publications**
configured and the app's RLS relies on a per-tx `app.company_id` GUC, so a naive
logical-replication consumer would see a GUC mismatch. If a real-time external
consumer is ever needed, design it explicitly (dedicated replication role +
publication + a consumer that sets the GUC or bypasses RLS deliberately) rather
than turning on replication ad hoc.
