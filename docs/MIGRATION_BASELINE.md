# Migration baseline-squash runbook

> **Scope.** This is the procedure referenced by
> [`ENVIRONMENTS_AND_MIGRATIONS.md`](./ENVIRONMENTS_AND_MIGRATIONS.md) §3.2–3.3:
> how to periodically **squash the numbered migration series into a single
> baseline** during the learning phase, and the one condition under which you must
> **stop**.
>
> **Read this first.** Squashing **rewrites migration history**. It is only safe
> while **every database that ran the old history is disposable** — i.e. during
> the learning phase, when prod holds no irreplaceable customer data. The moment a
> real customer's data lives in `sitelayer_prod`, **baseline-squash is retired
> forever** and all schema change becomes append-only
> (expand → backfill → contract).

---

## When this applies

- ✅ **Learning phase only.** prod contains synthetic / seed data you are willing
  to drop and rebuild.
- ❌ **Stop the moment prod holds irreplaceable customer data.** From then on the
  `001..NNN` series is frozen, the prod `schema_migrations` ledger is load-bearing,
  and history must never be rewritten.

The trigger is binary: _"would a real customer lose data if `sitelayer_prod` were
reset?"_ Yes → never squash again.

## Why squashing is safe before the trigger

`scripts/migrate-db.sh` records each applied file's `sha256` in the
`schema_migrations` ledger and aborts the next deploy (exit 3) if an
already-applied file's checksum changes. A baseline-squash deliberately changes
the set of files **and** their checksums. That is only acceptable when every DB
carrying the old ledger can be **dropped and rebuilt from the new baseline** —
which, during the learning phase, all of them can be (non-prod is disposable by
design, prod still has only seed data).

## The procedure

1. **Confirm the trigger has NOT fired.** Verify `sitelayer_prod` holds no
   irreplaceable customer data. If unsure, **stop** and treat the schema as frozen.
2. **Pick the squash point.** Choose the highest applied migration number `NNN`.
   Everything `001..NNN` collapses; anything authored after the squash continues
   from `NNN+1`.
3. **Regenerate the baseline from the live schema.** Produce a single
   `000_baseline.sql` (or your chosen baseline name that sorts first) that
   recreates the **current** schema in one file — tables, indexes, constraints,
   RLS enable/force + policies, functions, seed-independent defaults. Generate it
   from a freshly-migrated disposable DB (apply `001..NNN` to an empty Docker
   Postgres, then dump the schema) so the baseline provably equals the series.
4. **Replace the series.** Remove `001..NNN_*.sql` and keep only the baseline.
   Keep numbering room so future files clearly follow the baseline.
5. **Reset every non-prod DB from the baseline.** Recreate each disposable Docker
   Postgres (dev / demo / preview) and run `scripts/migrate-db.sh` so its
   `schema_migrations` ledger now records only the baseline.
6. **Re-stamp prod (learning phase only).** Because prod still has only seed data,
   reset it the same way (drop, apply baseline, reseed). The prod ledger now
   records only the baseline. **This step is exactly what becomes impossible once
   the maturity trigger fires** — which is the whole reason the trigger exists.
7. **Verify.** A clean checkout migrating an empty DB must reach the identical
   schema, and `scripts/verify-local.sh` (standard) — which boots a real
   `postgres:18`, applies migrations, and runs the integration suite — must pass.

## After the trigger fires

- The baseline is the **historical floor** and is never re-squashed.
- Every schema change is a **new** numbered file appended after the baseline.
- Changes follow **expand → backfill → contract** so a running prod with real data
  stays healthy across the rollout (see
  [`ENVIRONMENTS_AND_MIGRATIONS.md`](./ENVIRONMENTS_AND_MIGRATIONS.md) §3.4).
- Editing an applied file is now a hard error by design (the checksum ledger,
  exit 3) and must never be bypassed.
