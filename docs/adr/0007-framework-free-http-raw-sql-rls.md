# ADR 0007 — Framework-free Node HTTP + raw parameterized SQL + RLS (no ORM)

**Status:** accepted
**Date:** 2026-06-13 (documents a decision in force since the MVP)
**Supersedes:** —
**Superseded by:** —

## Context

The backend (`apps/api`, `apps/worker`) could be built on a framework
(Express/Fastify/Hono/Nest) with an ORM (Prisma/Drizzle), or on Node's core
primitives with direct SQL. SiteLayer chose the latter from the start. This ADR
records that choice and — more importantly — why introducing an ORM is a
**regression**, not an upgrade, so it doesn't get relitigated each time the route
count grows.

## Decision

**Use only Node's core `http` module (no web framework) and direct
parameterized `pg` SQL (no ORM). Postgres RLS + explicit `company_id` predicates
are the multi-tenant isolation.**

Concretely:

1. **No framework.** `apps/api/src/server.ts` owns HTTP + auth + middleware and
   hands each request to `routes/dispatch.ts`, which dispatches to ~107
   per-feature handler modules via an order-sorted descriptor registry (each
   route now exports its own `*RouteDescriptor` — the merge-magnet shrink of
   2026-06-13). Cross-cutting concerns are discrete modules (rate-limit,
   version-guard, catalog, LWW).
2. **Raw parameterized SQL.** Queries are written as parameterized strings in the
   handler modules; SQL-injection is mitigated by parameterization (enforced, not
   optional). String interpolation only ever uses internal column-list constants,
   never user input.
3. **RLS + `company_id` everywhere.** Writes flow through `withMutationTx`, which
   sets the `app.company_id` GUC; reads carry explicit `company_id = $1`
   predicates (600+ sites) with the RLS policy as a backstop.

## Why not an ORM

This codebase deliberately relies on patterns ORMs fight: `FOR UPDATE SKIP
LOCKED` (the `@sitelayer/queue` lease), `SET LOCAL app.company_id` (the RLS GUC),
closeout/analytics CTEs, optimistic `version` / `state_version` guards, and
`withMutationTx` transaction control. An ORM would force constant `$queryRaw`
escapes (no benefit) **and** want to own migrations — replacing the locked-down,
checksummed, immutable forward-only SQL migration discipline
(`docker/postgres/init`, `DEPLOY_RUNBOOK.md`), which is a safety regression. The
"unsustainable past N endpoints" claim is false for this style. If compile-time
type-safety ever becomes a measured pain, the only thing worth evaluating is a
**SQL-first type generator** (PgTyped / pg-to-ts) that types existing SQL without
touching migrations or RLS — never an ORM.

## Consequences

**Positive:** transparent, reviewable queries; full control over RLS, lease
queue, CTEs, and tx boundaries; minimal container/runtime overhead; the migration
discipline stays immutable and checksummed.

**Negative:** manual routing and no query builder. The routing cost is mitigated
by the dispatch descriptor registry (adding a route touches one module). The
type-safety cost is accepted; a SQL-first generator is the only sanctioned future
mitigation.

## References

- `CLAUDE.md` — "Architectural Decisions: No Framework" + "Database ORM / Query
  Layer" + "Direct SQL".
- `apps/api/src/routes/dispatch.ts`, `mutation-tx.ts`, `packages/queue/`,
  `docker/postgres/init/`, `DEPLOY_RUNBOOK.md`.
- ADR [0006](0006-deterministic-workflow-engine.md) — the workflow engine that
  depends on this raw-SQL/tx control.
