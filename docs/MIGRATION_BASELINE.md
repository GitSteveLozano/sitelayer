# Migration baseline (squash) — build, verify, and per-environment cutover

**Status (2026-06-02):** tool + verification shipped; **squash EXECUTED for the
repo + disposable tiers** (boundary = migration 152; `docker/postgres/init/` now
holds only `000_baseline.sql`). The baseline captures **schema AND seed data**
(the tool dumps seed rows as idempotent INSERTs — `pg_dump --data-only --inserts
--on-conflict-do-nothing --disable-triggers`, excluding the `schema_migrations`
ledger — and the equivalence proof now checks per-table row counts in addition to
the schema diff). dev + demo were rebuilt fresh from the baseline (clean ledger =
1 row, seed data intact). **PROD ledger reconcile is the one remaining step.**
Prod is **behind the baseline boundary** — it was at migration **136** when the
squash happened (the disposable tiers were at 152) — so it does NOT take the
plain §3.3 reconcile. It must first be caught up to 152 via the individual
`137…152` migrations from the **pre-squash parent SHA `cb5dc432`** (the squash
commit's parent — the last commit with the full `init/` series; NOT `bc5735f1`,
which is prod's currently-running SHA and only has `init/` up to 136), and only
THEN reconciled (mark `000_baseline.sql` applied, delete the `< '153_'` rows);
the baseline file itself is **never executed against prod** (its
`--disable-triggers` data section needs superuser the prod app role lacks). See
**§3.5** for the full behind-boundary procedure. This doc is the runbook for collapsing the
`docker/postgres/init/*.sql` history into a single `000_baseline.sql` during the
learning phase, and the explicit rule for when that is no longer allowed.

> **REGEN NEEDED before the baseline is applied to a fresh PROD tier.** The
> shipped `000_baseline.sql` still carries e2e/demo/test seed rows (the
> `e2e-fixtures` company + its 5 role memberships from migration 072, etc.) in
> its seed-data section. `scripts/squash-migrations-baseline.sh` has since been
> updated to **tier-gate those rows OUT** of the data dump, but the baseline was
> NOT regenerated here (regen is a separate gated op — see §3.2). Before any
> baseline is applied to a fresh PROD tier, re-run the squash tool to regenerate
> `000_baseline.sql` so the e2e/demo rows are excluded. For the current
> behind-boundary prod cutover (§3.5) this is moot — prod is forward-migrated and
> the baseline is never executed there — but a fresh-prod bring-up from the
> baseline must use a regenerated, tier-gated file.

> **Context.** This is the operational procedure referenced by
> [`ENVIRONMENTS_AND_MIGRATIONS.md`](./ENVIRONMENTS_AND_MIGRATIONS.md) §3.2–3.4:
> how to periodically squash the numbered migration series into a single baseline
> during the learning phase, and the one condition (the maturity trigger) under
> which you must stop forever.

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
`<BOUNDARY>`. For the squash that actually shipped (2026-06-02) the boundary is
**152** (the last folded file was `152_company_settings.sql`; note the history
numbering skipped `151_`, so no `151_*` file ever existed). Every file
`≤ <BOUNDARY>` is represented by `000_baseline.sql`; anything `> <BOUNDARY>`
stays a normal forward migration applied after the baseline. The §3.3 reconcile
DELETE bound is **one past** the boundary — for boundary 152 that is `'153_'`,
NOT `'152_'` (which would orphan `152_company_settings.sql`).

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
#    For the boundary-152 squash the folded set is 0xx..152 (there is no 151_):
git rm docker/postgres/init/0[0-9][0-9]_*.sql docker/postgres/init/1[0-4][0-9]_*.sql \
       docker/postgres/init/15[0-2]_*.sql   # adjust the globs to your <BOUNDARY>
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
--
--    The bound is ONE PAST the highest folded migration number. The squash
--    boundary is 152 (the last folded file is 152_company_settings.sql; there
--    is NO 151_* file in the history — the numbering skipped it), so the bound
--    is '153_'. A common-and-wrong instinct is to write '151_' or '152_': both
--    string-compare BELOW '152_company_settings.sql', so they LEAVE that ledger
--    row orphaned (it points at a file the baseline already folded). Use '153_'.
--
--    Worked example (boundary 152, the real squash):
--      DELETE ... AND name < '153_';
--      -- '152_company_settings.sql' < '153_'  -> TRUE  (deleted, correct)
--      -- a future '153_*.sql'        < '153_'  -> FALSE (kept,    correct)
DELETE FROM schema_migrations
WHERE name <> '000_baseline.sql'
  AND name < '153_';   -- string compare works on the zero-padded NNN_ prefix;
                       -- set this bound to one past <BOUNDARY> (boundary 152 -> '153_').

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

### 3.5 Special case: PROD IS BEHIND THE BASELINE BOUNDARY (catch up FIRST)

The §3.3 reconcile assumes the target environment has **already applied the
history the baseline folds** — its belt-and-suspenders guard aborts unless a
late table (`budget_snapshots`, migration 143) exists. That guard is correct:
marking `000_baseline.sql` applied on a DB that is behind the boundary would
record "this DB is at 152" while it is really at, say, 136 — silently skipping
every migration in `(behind, 152]` forever. **Never reconcile a behind-boundary
environment.**

This is the **real** state of prod for the 2026-06-02 squash: prod was at
migration **136** when the squash happened (the disposable tiers were at 152).
Prod is therefore behind the boundary, so the plain §3.3 reconcile does **not**
apply to it. The safe procedure is **catch up to the boundary first, THEN
reconcile**:

1. **Catch prod up to 152 using the INDIVIDUAL migrations from the pre-squash
   SHA.** The squashed `main` no longer contains `137_*.sql … 152_*.sql`, so you
   cannot migrate prod forward from `main`. Use the **squash commit's parent**
   `cb5dc432` (= `<squash-commit>^`), which is the last commit that still holds
   the full `docker/postgres/init/0xx…152` series. (Do NOT confuse this with
   `bc5735f1` — that is the SHA prod is currently RUNNING, and its `init/` only
   goes up to `136_custom_roles.sql`, so it cannot carry prod to 152.) Check out
   the pre-squash parent and run the normal forward migrator against prod:

   ```bash
   git worktree add /tmp/sitelayer-presquash cb5dc432   # squash commit's parent
   cd /tmp/sitelayer-presquash
   # DATABASE_URL points at sitelayer_prod; this applies 137..152 normally and
   # ledgers each one, leaving prod at the boundary with a TRUE 137..152 history.
   # (There is no 151_* file — the history skipped that number; 150 then 152.)
   scripts/migrate-db.sh
   scripts/check-db-schema.sh
   ```

   This is an ordinary forward migration (additive, checksum-ledgered) — it is
   NOT a squash operation and does not touch the immutability gate.

2. **THEN run the §3.3 reconcile** on prod (mark `000_baseline.sql` applied +
   delete the `< '153_'` history rows). Because prod is now genuinely at 152,
   the §3.3 guard passes and the reconcile is a pure ledger swap.

3. **Do NOT run the baseline (`000_baseline.sql`) AS A SCRIPT against prod.** Two
   reasons:
   - prod is already at 152 after step 1, so running the schema half would be a
     no-op replay at best;
   - more importantly, the baseline's **seed-data section** is dumped with
     `pg_dump --disable-triggers`, which on restore issues `ALTER TABLE …
DISABLE TRIGGER` — that requires **table-owner or superuser**. The prod app
     role is a least-privilege login role and does **not** have it, so applying
     the baseline as prod would error out partway through the data section. The
     §3.3 reconcile sidesteps this entirely: it only marks the row applied and
     never executes the file. (This is also why the baseline must NOT carry e2e /
     demo seed rows into a fresh prod tier — see the tier-gating note in §5 and
     the `--exclude-table-data` work in `squash-migrations-baseline.sh`.)

In short, for a behind-boundary prod: **forward-migrate to the boundary from a
pre-squash SHA → reconcile the ledger → never execute the baseline on prod.**

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

> **Operator judgment 2026-06-02: the gate was OPEN and the squash is DONE.**
> On 2026-06-02 the operator judged prod to hold only seed/test/demo tenants
> (no irreplaceable customer data), declared the gate OPEN, and the boundary-152
> squash was **executed** for the repo + disposable tiers (`docker/postgres/init/`
> now holds only `000_baseline.sql`; dev + demo rebuilt fresh). The prod ledger
> reconcile is the one remaining step and follows the behind-boundary procedure
> in §3.5 (prod was at 136). This was a one-time, deliberate operation; it does
> NOT re-open the gate for future squashes — the trigger below still governs
> whether another squash is ever permitted, and the answer is "no" the moment
> prod holds real customer data.

### The trigger (state it explicitly)

Treat the squash path as **closed** the moment **any** of these is true for the
**prod** tier (`sitelayer_prod`):

1. A **real (non-test, non-demo) company** exists in prod — i.e.
   `SELECT count(*) FROM companies WHERE slug NOT IN (<allowlist>) > 0` for any
   genuine customer slug. The **test/demo/seed allowlist** (slugs that do NOT
   count as real customer data) must be kept current with what actually lives in
   prod. As of 2026-06-02 it is:

   ```sql
   SELECT count(*) FROM companies
   WHERE slug NOT IN (
     'la-operations',   -- seeded LA Operations template tenant
     'beta-build',      -- bootstrap fan-out shadow tenant
     'e2e-fixtures',    -- role-matrix Playwright tenant (migration 072)
     'demo',            -- demo-tier seed tenant
     'steve',           -- operator/dev smoke tenant
     'lastucco',        -- operator/dev smoke tenant
     'acme-prod-smoke'  -- prod smoke-test tenant
   ) > 0;
   ```

   Any row this query counts is a real customer and closes the gate. (The
   previous version of this doc listed only `e2e-fixtures`, `la-operations`,
   `demo` and was stale — prod also carries `steve`, `lastucco`, `beta-build`,
   and `acme-prod-smoke` as non-customer tenants.) **or**

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
