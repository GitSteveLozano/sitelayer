# Migration baseline (squash) — build, verify, and per-environment cutover

**Status:** tool + verification shipped; **cutover NOT executed**. This doc is
the runbook for collapsing the `docker/postgres/init/*.sql` history into a
single `000_baseline.sql` during the learning phase, and the explicit rule for
when that is no longer allowed.

> **One-line rule:** squash-baselining is allowed **only while prod holds no
> irreplaceable customer data**. The moment it does, stop — the history goes
> strictly forward-only, forever. See [§5 Maturity-curve gate](#5-maturity-curve-gate).

---

## 0. Why this exists

`docker/postgres/init/*.sql` is forward-only, immutable, and checksum-ledgered
(`scripts/migrate-db.sh`, the immutability gate `scripts/check-migrations-immutable.sh`).
That discipline is correct and must never be relaxed for prod. But during the
learning phase the operator runs heavy agent churn — frequent schema changes —
and the history is **151 files and growing**. A long history is fine for prod
(it is the audit trail), but it makes every fresh-DB bring-up (dev resets,
preview schemas, the verify gate's throwaway Postgres, CI integration) slower
and the init directory harder to read.

The fix _while there is nothing irreplaceable to protect_ is a **baseline
squash**: replace N applied migrations with one `000_baseline.sql` that
reproduces the exact same schema, then retire the old files. This is a
**one-time, deliberate, per-environment** operation — not something a deploy or
a tool run does by itself.

---

## 1. The tool (build + verify, never execute)

`scripts/squash-migrations-baseline.sh`:

1. applies **all** current `docker/postgres/init/*.sql` to a throwaway
   `postgres:18` container (the "history" DB);
2. `pg_dump --schema-only --no-owner --no-privileges --schema=public` of that
   DB, rewritten to an **idempotent** form, into a candidate at
   `docker/postgres/baseline-candidate/000_baseline.sql`
   (deliberately **outside** `init/` — see [§2](#2-why-the-candidate-is-not-in-init));
3. **proves equivalence**: builds a second throwaway DB from **only** the
   candidate, dumps its schema the same way, and diffs the two. The diff **must
   be empty** — identical tables, columns, indexes, constraints, RLS policies +
   `FORCE` flags, functions, sequences, triggers, comments;
4. **proves idempotency**: re-applies the candidate to the fresh DB a second
   time, and applies it on top of the full-history DB — both must succeed
   without error (this is what makes the cutover's "mark applied" path safe).

```bash
scripts/squash-migrations-baseline.sh               # build candidate + prove
scripts/squash-migrations-baseline.sh --verify-only # re-prove an existing candidate
scripts/squash-migrations-baseline.sh --keep        # leave throwaway containers for inspection
```

It needs only Docker (a throwaway `postgres:18` is spun up; `pg_dump`/`psql` run
**inside** the container, so the dump matches the server version exactly).
Nothing it does touches a real environment.

The candidate is made idempotent so it can run against an **already-migrated**
DB: every object is `CREATE ... IF NOT EXISTS` / `CREATE OR REPLACE`; each
policy is preceded by `DROP POLICY IF EXISTS`; each `ADD CONSTRAINT` is wrapped
in a duplicate-tolerant `DO` block; RLS `ENABLE`/`FORCE` are no-ops when already
set.

---

## 2. Why the candidate is NOT in `init/`

Anything under `docker/postgres/init/` is auto-applied:

- `scripts/migrate-db.sh` applies every `*.sql` there and records a checksum row
  in `schema_migrations`;
- `docker-compose.yml` mounts the directory as `/docker-entrypoint-initdb.d`, so
  a fresh container runs every file at first boot.

If the baseline lived in `init/`, the next deploy of **every** environment would
run an 11k-line schema replay and add a checksum row — with no operator
decision. So the tool writes the candidate to
`docker/postgres/baseline-candidate/`. **Promoting it into `init/` is a manual
step of the cutover below**, done per environment in a controlled order, not a
side effect of regenerating the file.

---

## 3. The cutover (per environment, idempotent, NO schema change)

The delicate part. After a squash, `docker/postgres/init/` has **fewer files**
than the `schema_migrations` ledger has rows (the ledger currently holds 151
rows; after the squash the directory holds `000_baseline.sql` + whatever
post-baseline files you keep). If you just deployed that, `migrate-db.sh` would:

- see `000_baseline.sql` as a brand-new file and **apply** it (idempotent, so it
  would not corrupt data — but it would do a full 11k-line replay), and
- **leave** the 151 now-orphaned ledger rows pointing at files that no longer
  exist (harmless to `migrate-db.sh`, which only reads rows by name, but
  misleading and a checksum-immutability landmine if any of those names is ever
  reused).

The cutover makes the ledger match the new directory **without changing the
schema**: mark `000_baseline.sql` as already-applied and retire the
superseded history rows. Do it **once per environment**, in increasing order of
blast radius: **preview → dev → demo → prod**.

### 3.1 Decide the baseline boundary

Pick the highest migration number folded into the baseline — call it
`<BOUNDARY>` (e.g. `150`, the current max). Every file `≤ <BOUNDARY>` is
represented by `000_baseline.sql`; anything `> <BOUNDARY>` stays a normal
forward migration applied after the baseline.

### 3.2 Promote the candidate (repo change, once)

> Do this in a branch and run the verify gate before merge.

```bash
# 1. Re-prove the candidate is current and equivalent.
scripts/squash-migrations-baseline.sh

# 2. Move the proven candidate into the applied directory.
git mv docker/postgres/baseline-candidate/000_baseline.sql \
       docker/postgres/init/000_baseline.sql

# 3. Retire the folded history files (everything you squashed, ≤ <BOUNDARY>).
#    Keep any post-baseline migrations (> <BOUNDARY>) untouched.
git rm docker/postgres/init/0[0-9][0-9]_*.sql docker/postgres/init/1[0-4][0-9]_*.sql \
       docker/postgres/init/150_*.sql   # adjust the globs to your <BOUNDARY>
git checkout -- docker/postgres/init/000_baseline.sql  # keep the baseline
```

This deletion **will** trip `scripts/check-migrations-immutable.sh` (it flags
removed migration files). That is the gate working as designed — a squash is the
**one** sanctioned reason to remove applied migrations, and it is only safe
under the [§5 maturity gate](#5-maturity-curve-gate). Run the promote commit
with `MIGRATION_GUARD_OVERRIDE=1` for the verify gate, and record the override
in the commit message:

```bash
MIGRATION_GUARD_OVERRIDE=1 npm run verify
```

### 3.3 Reconcile each environment's ledger (idempotent SQL)

For **each** environment, against that environment's DB, run the reconcile
below. It is idempotent: re-running it is a no-op. It does **not** touch any
table other than `schema_migrations` and makes **no** schema change.

Set `DATABASE_URL` (and `PREVIEW_DB_SCHEMA` for a preview slug) to the target
environment first, exactly as `scripts/migrate-db.sh` expects, then:

```sql
BEGIN;

-- Belt-and-suspenders: the schema must already be at-or-past the baseline
-- boundary, i.e. this environment has applied the history we are folding. If a
-- core late table is missing, ABORT — this environment is not ready to cut over.
DO $$
BEGIN
  -- companies = the tenant root (present since 001); budget_snapshots = a LATE
  -- table (migration 143) that only exists once the history we are folding has
  -- been applied. Pick whatever your <BOUNDARY> makes the newest folded table.
  IF to_regclass('public.companies') IS NULL
     OR to_regclass('public.budget_snapshots') IS NULL THEN
    RAISE EXCEPTION 'refusing baseline cutover: schema is behind the baseline boundary';
  END IF;
END $$;

-- 1. Mark 000_baseline.sql as applied, with the SAME checksum migrate-db.sh
--    computes (sha256 of the file). Compute <BASELINE_SHA256> on the box:
--      sha256sum docker/postgres/init/000_baseline.sql
--    Idempotent: if the row exists with the same checksum, do nothing; if it is
--    somehow absent, insert it. Never overwrite a DIFFERENT checksum here — that
--    would mask a real drift; investigate instead.
INSERT INTO schema_migrations (name, checksum, applied_at)
VALUES ('000_baseline.sql', '<BASELINE_SHA256>', now())
ON CONFLICT (name) DO NOTHING;

-- 2. Retire the folded history rows (everything the baseline now represents,
--    i.e. files <= <BOUNDARY> that we removed from init/). We delete by the
--    EXACT set of names we removed; never a blanket "delete everything but the
--    baseline", which could nuke a legitimately-newer migration row.
DELETE FROM schema_migrations
WHERE name <> '000_baseline.sql'
  AND name < '151_';   -- string compare works on the zero-padded NNN_ prefix;
                       -- set this bound to one past <BOUNDARY>.

COMMIT;
```

> Why `INSERT ... ON CONFLICT DO NOTHING` and not "mark applied": the migrate-db
> runner keys purely on the row's `name`. A present row with the right name is
> all it needs to **skip** re-applying `000_baseline.sql`. The idempotent
> baseline means even if you _do_ let it apply (e.g. a fresh environment), the
> result is identical — so this is correct whether the row exists or not.

### 3.4 Order and safety

- **preview first.** Preview schemas are ephemeral; if the reconcile is wrong,
  drop the slug schema and redeploy — zero cost.
- **dev next**, then **demo** (both disposable; `scripts/reset-dev-db.sh` and the
  demo reseed are the escape hatches).
- **prod LAST**, and only after the three disposable tiers are green, and only
  while the [§5 gate](#5-maturity-curve-gate) still permits a squash at all. Take
  the normal pre-migration `pg_dump` backup the prod deploy already takes
  (`scripts/deploy-production-local.sh`) before the reconcile.

---

## 4. Verify after each environment

After the reconcile on an environment, prove it is correct and that a
**subsequent deploy is a no-op** (no schema change):

```bash
# 1. The ledger matches the directory: 000_baseline.sql is present, the folded
#    rows are gone, post-baseline rows remain.
psql "$DATABASE_URL" -c \
  "SELECT name FROM schema_migrations ORDER BY name;"

# 2. A re-run of the runner applies nothing new (every file already ledgered).
scripts/migrate-db.sh        # expect: 'Skipping already-applied migration ...'

# 3. The schema readiness check still passes (all expected tables/columns).
scripts/check-db-schema.sh

# 4. (strongest) The post-cutover schema equals the pre-cutover schema. Diff a
#    schema-only pg_dump taken BEFORE the cutover against one taken after; it
#    must be empty. The squash tool already proved baseline≡history offline; this
#    confirms THIS environment did not drift during the ledger swap.
```

If any check fails on a disposable tier, rebuild it from scratch
(`reset-dev-db.sh` / demo reseed / drop+redeploy the preview slug) and re-run
the reconcile. If a check fails on **prod**, restore the pre-migration backup —
do **not** fix-forward by hand-editing the ledger.

---

## 5. Maturity-curve gate

This is the load-bearing rule.

> **Squash-baselining is allowed ONLY while prod has no irreplaceable customer
> data.** Once prod holds data you cannot recreate from seeds/fixtures, STOP.
> The migration history is then **strictly forward-only, forever** — you add
> migrations, you never squash, you never remove an applied file.

### The trigger (state it explicitly)

Treat the squash path as **closed** the moment **any** of these is true for the
**prod** tier (`sitelayer_prod`):

1. A **real (non-test, non-demo) company** exists in prod — i.e.
   `SELECT count(*) FROM companies WHERE slug NOT IN ('e2e-fixtures','la-operations','demo', ...) > 0`
   for any genuine customer slug; **or**
2. prod holds **customer-authored blueprint documents** (uploaded PDFs in
   `blueprint_documents` whose `storage_path` points at the prod Spaces bucket),
   takeoffs, estimates, or QBO-synced financial rows that are not reproducible
   from a seed; **or**
3. the first pilot customer has been **onboarded** (CLAUDE.md "Phase 3 — Pilot
   Customer Onboarding": first company + memberships provisioned), regardless of
   row counts.

Whichever comes first **closes the gate**. From that point:

- the squash tool may still run for **analysis** (it never touches a real env),
  but you do **not** promote a baseline into `init/` and you do **not** delete
  applied migrations;
- new schema changes are **expand → backfill → contract**, additive, one new
  numbered file each, exactly as the prod discipline already requires;
- the immutability gate is **not** overridden for prod again.

### Why the asymmetry

Before there is irreplaceable data, the worst case of a bad squash is "rebuild a
disposable environment" — cheap. After, a bad squash risks customer data with no
clean rollback. The whole point of the four-tier model (disposable
dev/demo/preview, durable prod) is to take all the migration-churn risk in the
disposable tiers; the squash is the same bet, and it expires for the same
reason.

---

## 6. Quick reference

| Action                             | Command / location                                                  |
| ---------------------------------- | ------------------------------------------------------------------- |
| Build + prove a candidate          | `scripts/squash-migrations-baseline.sh`                             |
| Re-prove an existing candidate     | `scripts/squash-migrations-baseline.sh --verify-only`               |
| Candidate artifact (NOT applied)   | `docker/postgres/baseline-candidate/000_baseline.sql`               |
| Baseline checksum (for the ledger) | `sha256sum docker/postgres/init/000_baseline.sql`                   |
| Ledger table                       | `schema_migrations (name PK, checksum, applied_at)`                 |
| Runner                             | `scripts/migrate-db.sh`                                             |
| Immutability gate                  | `scripts/check-migrations-immutable.sh`                             |
| Schema readiness                   | `scripts/check-db-schema.sh`                                        |
| Disposable-tier rebuild            | `scripts/reset-dev-db.sh` (dev) / demo reseed / drop preview schema |
| One-migration-per-feature rule     | `CLAUDE.md` → Deploy procedure                                      |
