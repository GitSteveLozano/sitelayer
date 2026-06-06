# Migration baseline candidate (NOT applied)

`000_baseline.sql` in this directory is a **generated, not-yet-adopted**
squash baseline. It is produced by
[`scripts/squash-migrations-baseline.sh`](../../../scripts/squash-migrations-baseline.sh)
and reproduces — exactly — the schema you get from applying the full
`docker/postgres/init/*.sql` history (151 files at time of generation).

## Why it lives here and not in `docker/postgres/init/`

Anything under `docker/postgres/init/` is auto-applied:

- `scripts/migrate-db.sh` applies every `*.sql` there and records a checksum row
  in `schema_migrations`;
- the `docker-compose.yml` `db` service mounts the directory as
  `/docker-entrypoint-initdb.d`, so a fresh container runs every file.

Dropping the baseline into `init/` would therefore apply an 11k-line schema
replay on the next deploy of **every** environment, with no operator decision.
The squash cutover is deliberate and per-environment — it is **not** a side
effect of regenerating this file. The mechanics live in
[`docs/MIGRATION_BASELINE.md`](../../../docs/MIGRATION_BASELINE.md).

## Properties (proven by the generator before this file was written)

- **Equivalent:** a fresh DB built from only `000_baseline.sql` has an identical
  schema-only `pg_dump` to a DB built from the full 151-file history (empty
  diff). Tables, columns, indexes, constraints, RLS policies + `FORCE` flags,
  functions, sequences, triggers, comments.
- **Idempotent:** safe to re-run against an already-migrated DB. Every object is
  `CREATE ... IF NOT EXISTS` / `CREATE OR REPLACE`; each policy is preceded by a
  `DROP POLICY IF EXISTS`; each `ADD CONSTRAINT` is wrapped in a
  duplicate-tolerant `DO` block; RLS `ENABLE`/`FORCE` are no-ops when already
  set. This is what lets the cutover "mark applied" path run it against existing
  environments without a schema change.

## Do not hand-edit

Regenerate instead:

```bash
scripts/squash-migrations-baseline.sh            # rebuild + re-prove equivalence
scripts/squash-migrations-baseline.sh --verify-only  # re-prove an existing candidate
```

## Maturity-curve gate

Squash-baselining is allowed **only while prod holds no irreplaceable customer
data**. Once it does, stop: the migration history goes strictly forward-only,
forever. The exact trigger is stated in
[`docs/MIGRATION_BASELINE.md`](../../../docs/MIGRATION_BASELINE.md).
