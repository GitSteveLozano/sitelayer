# Environments & Migrations — the durable design

> **What this answers.** "How do environments and migrations work under heavy
> agent churn?" The operator runs a large fleet of agents while still _learning_
> the product, so code **and** the DB schema change constantly. This document is
> the durable design that makes that sustainable: **non-prod is disposable so
> migration churn is free**, **prod's forward-only/immutable discipline stays
> sacred**, and **multi-company config evolves with no migration at all**.
>
> Companion docs: [`DEPLOYMENT_STRATEGY.md`](./DEPLOYMENT_STRATEGY.md) (the
> deploy/verify/handoff plane), [`MIGRATION_BASELINE.md`](./MIGRATION_BASELINE.md)
> (the baseline-squash runbook referenced in §3),
> [`MULTI_TENANCY.md`](./MULTI_TENANCY.md) (RLS + membership invariants),
> [`DEV_ENVIRONMENT.md`](./DEV_ENVIRONMENT.md),
> [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md), and
> [`PREVIEW_DEPLOYMENTS.md`](./PREVIEW_DEPLOYMENTS.md).
>
> DigitalOcean facts in this doc are verified against the live account: ONE
> managed Postgres 18 cluster `sitelayer-db`
> (`9948c96b-b6b6-45ad-adf7-d20e4c206c66`), size **`db-s-1vcpu-2gb`** (1 vCPU / 2
> GB, ~47 max connections, 1 node, `tor1`), with prod reaching it through the
> managed pool **`sitelayer-prod-pool`** (transaction mode, size 11).

---

## 1. The four environments — sorted by DATA DURABILITY

The organizing principle is **not** "what's the URL" — it is **"if this database
vanished, would a customer lose data?"** Exactly one tier answers _yes_.

- **prod is the only durable tier.** It holds real customers' money-movement
  data. Its DB lives on the DO **managed** cluster, and its migrations are
  **immutable once applied** (forward-only, checksum-ledgered).
- **dev / demo / preview are disposable.** They exist to let agents iterate. The
  design goal is that any of them can be **dropped and rebuilt** from migrations
  plus seed without anyone caring. (Today they still sit on the managed cluster;
  the durable design moves them to **Docker Postgres on the preview droplet** —
  see §2.)

| Tier        | URL                                   | DB home (durable design)                                  | Durability                               | Deploy                                                 | Tracked branch         |
| ----------- | ------------------------------------- | --------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ | ---------------------- |
| **prod**    | `sitelayer.sandolab.xyz`              | DO **managed** cluster `sitelayer-db`, via pool (size 11) | **DURABLE — customer data, never lost**  | Immutable image, `deploy.sh prod`, backup+migrate+swap | `main`                 |
| **dev**     | `dev.sitelayer.sandolab.xyz`          | **Docker Postgres on the preview droplet**                | Disposable — persistent-but-resettable   | Source-mount watch-mode, `deploy.sh dev` or watcher    | `dev` (the churn line) |
| **demo**    | `demo.preview.sitelayer.sandolab.xyz` | **Docker Postgres on the preview droplet**                | Disposable — **reseeded every deploy**   | Watch-mode + idempotent `seed:demo`                    | `main` (promoted)      |
| **preview** | `pr-N.preview.sitelayer.sandolab.xyz` | **Docker Postgres on the preview droplet** (per-PR)       | Disposable — **ephemeral, self-reaping** | Watch-mode, per-PR, `deploy-preview.sh`                | the PR branch          |

> **STALE (2026-06-12) — migration window note below is overtaken by events.**
> The cutover has been executed for the tiers that matter day-to-day: **demo
> runs the local Docker-Postgres backend** (`PREVIEW_DB_BACKEND=local`
> persisted in `/app/previews/.env.demo.shared` → container `preview-db`, DB
> `sitelayer_demo`), and per-PR **preview stacks default to the local
> backend** (tier default in `scripts/deploy-preview.sh`). The "DB home"
> column above describes the live state for those tiers, not just a target.
> Original note kept for history:
>
> **Migration window note.** As of the verified inventory, dev/demo/preview DBs
> (`sitelayer_dev`, `sitelayer_demo`, `sitelayer_preview`) still physically live
> on the managed cluster alongside `sitelayer_prod`. The "DB home" column above is
> the **durable target** in §2; the cutover is the db-split work and is tracked in
> [`DEPLOYMENT_STRATEGY.md`](./DEPLOYMENT_STRATEGY.md) §5. The durability and
> branch columns are already true today.

---

## 2. The split — managed cluster is PROD ONLY; non-prod is Docker on the preview droplet

**Rule:** the **DO managed Postgres cluster hosts prod, and only prod.** Every
non-prod environment runs its database as a **Docker Postgres container on the
`sitelayer-preview` droplet** (`s-2vcpu-4gb`, `137.184.169.208` / reserved
`159.203.53.218`), the same droplet that already runs the dev/demo/preview app
stacks behind Traefik.

### Why

- **Free.** A Postgres container on a droplet we already pay for costs nothing
  extra; a managed-cluster connection slot is a scarce, paid resource (§6).
- **Disposable.** A container DB can be `down -v`'d and recreated in seconds.
  That is what makes migration churn free (§3) — you cannot "edit a migration in
  place" against a DB you are afraid to drop.
- **Frees prod's capacity.** While non-prod shares the managed cluster, dev +
  demo + every PR preview compete for the same ~47 raw connections that prod
  needs (§6). Moving them off **hands the entire cluster to prod.**
- **No shared-cluster credential risk.** Today a misconfigured non-prod
  `DATABASE_URL` (e.g. one pointed at `doadmin`) is a _cluster-wide_ blast radius
  because `sitelayer_prod` lives in the same cluster (see the `doadmin` warning in
  [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md)). Once non-prod is on a separate
  Docker Postgres, a non-prod credential **cannot reach prod at all.**

### The flag / cutover mechanism

The cutover is already _permitted_ by the tier guard. `assertDatabaseMatchesTier`
in `packages/config/src/index.ts` enforces, at startup, that the DB name matches
the tier (`APP_TIER=dev` ⇒ name contains `sitelayer_dev`, etc.) **except** when
the DB host is local (`LOCAL_HOSTS = localhost | 127.0.0.1 | ::1 | postgres |
db`). That `isLocalHost` exemption is the seam: when a non-prod stack points its
`DATABASE_URL` at the in-compose `postgres` / `db` service on the droplet, the
guard passes and the env runs against the container DB.

The `prod` branch of the same function has **no** local-host exemption and
additionally **refuses to start** if any non-prod tier's `DATABASE_URL` resolves
to a `sitelayer_prod` database. The cutover is therefore: stand a Postgres
service up in the dev/demo/preview compose files, repoint each non-prod
`DATABASE_URL` at it, and run migrations into the container — no app code change,
prod stays sacred by construction.

---

## 3. The migration-churn model — the heart

This is the part that makes heavy agent churn survivable.

### 3.1 Mutable-until-main

Migrations are **forward-only, immutable, and checksum-ledgered _in prod_**:
`scripts/migrate-db.sh` records every applied file's `sha256` in a
`schema_migrations` ledger and **aborts the next deploy with exit 3** if an
already-applied file's checksum changed. That gate is what guarantees prod never
silently re-runs or mutates history.

The key realization: **the gate only binds once the migration has been applied to
a durable DB — i.e. once it reaches prod (from `main`).** Against a **disposable**
non-prod DB, the ledger is just as droppable as the data: reset the DB and the
checksum constraint evaporates. So a migration is **mutable until it lands on
`main`/prod**, and **immutable forever after.**

In practice:

- **ONE migration file per feature, edited in place.** While a feature is on
  `dev`, its migration is a _living_ file. An agent adds a column, realizes the
  type is wrong, edits the same `NNN_*.sql`, and **resets the disposable dev DB**
  (`scripts/reset-dev-db.sh`, or just recreate the container) to re-apply it
  clean. No "fix-up migration to undo yesterday's migration" pile-up.
- **Disposable non-prod DBs remove ledger friction.** Because non-prod DBs are
  reset freely, the checksum ledger never fights the agent during iteration. The
  ledger does its real job exactly once: at the prod boundary.
- **The discipline only flips at `main`.** A migration that has merged to `main`
  and shipped to prod is **frozen**. From then on, changes are **new** numbered
  files — never an edit to an applied file.

### 3.2 The periodic BASELINE-SQUASH (learning phase)

During the learning phase, "one file per feature, edited in place" still
accumulates **many** files over weeks of churn (the init dir is already 151 files,
numbered to `150`). Because non-prod is disposable and prod has **no
irreplaceable data yet**, the whole numbered series can periodically be
**squashed to a single baseline** — collapse `001..NNN` into one
`000_baseline.sql` representing the current schema, drop the old files, and reset
every non-prod DB from the baseline.

The full procedure (how to regenerate the baseline from the live schema, how to
re-stamp the ledger, the safety checks) lives in
[`MIGRATION_BASELINE.md`](./MIGRATION_BASELINE.md). The point here is _why_ it is
safe: a squash rewrites migration history, and **rewriting history is only safe
while every DB that ran the old history is disposable.**

### 3.3 The maturity-curve trigger — when to STOP squashing

Squashing is a **learning-phase** privilege, not a permanent practice. The
trigger to retire it is a single condition:

> **The moment prod holds irreplaceable customer data, baseline-squash stops.**

Once a real customer's data lives in `sitelayer_prod`, that DB is no longer
reset-able, its ledger is load-bearing, and history can no longer be rewritten.
From that point:

- prod migrations are **append-only forever**;
- schema change uses **expand → backfill → contract** (§3.4);
- the baseline is frozen as the historical floor and never re-squashed.

Until then — during discovery, with synthetic/seed data only — squash freely.

### 3.4 expand/backfill/contract — a PROD-only concern

The careful three-step rollout (add the new shape, backfill it tolerating both
old and new, only later remove the old shape) **only matters for prod**, and only
**after** §3.3's trigger. It exists to keep a _running_ deploy with _real data_
healthy across the change. Non-prod never needs it: there is no old data to
preserve and no uptime to protect — you simply reset and re-apply the final
shape. Spending expand/backfill/contract ceremony on disposable environments is
wasted effort; reserve it for the one durable tier.

---

## 4. Multi-company config is migration-FREE — `company_modules`

A separate-but-related churn source is **per-company configuration**: which
feature packs a tenant sees, what their portal exposes, etc. The durable answer
is that **none of this requires a migration per setting.**

The convention is the `companies.modules` and `companies.portal_settings` JSONB
columns (migration `062_company_modules_and_bookkeeper.sql`). A new per-company
toggle is **a new key in that JSONB**, not a new column and not a new migration:

- The column already exists with conservative defaults
  (`takeoff`/`estimating`/`field_labor` on, scaffold-specific surfaces off until a
  tenant opts in).
- Reading/writing it is a runtime concern: `GET`/`PATCH
/api/companies/:id/modules` (admin-gated) merges a patch with the JSONB `||`
  operator and writes an audit row (`apps/api/src/routes/companies.ts`,
  `entityType: 'company_modules'`).
- A genuinely _new kind_ of setting with a narrow whitelist lands at
  `/api/companies/:id/settings` rather than widening the modules blob — also no
  migration.

So "evolve multi-company config" = **edit a JSONB key + a permission gate**, with
**zero schema churn**. The migration ledger never sees per-company configuration
at all. (Tenant _isolation_ — RLS + membership — is the orthogonal invariant; see
[`MULTI_TENANCY.md`](./MULTI_TENANCY.md).)

---

## 5. The promotion model

Two lines, three derived environments:

- **`dev` is the churn line.** Agents push here constantly; the dev environment
  tracks it. Migrations are mutable here (§3.1); the dev DB is reset freely.
- **`main` is the promoted line.** Work is promoted `dev → main` once it is real.
  Crossing into `main` is the moment a migration **freezes** (§3.1) and the moment
  the schema is considered production truth.
- **demo and prod both come from `main`.** demo is deployed from `main` as an
  `APP_TIER=demo` environment (reseeded each deploy), and prod ships the immutable
  image built from `main`. demo is _not_ a long-lived code branch — it is `main`'s
  code with demo config + demo seed (per
  [`BRANCH_ENVIRONMENT_AUDIT_2026-06-01.md`](./BRANCH_ENVIRONMENT_AUDIT_2026-06-01.md)).

```
        churn                 promote                derive
  agents ──▶ dev ───────────────▶ main ──┬─────────▶ demo  (reseeded each deploy)
            (mutable migs,               └─────────▶ prod  (immutable image)
             resettable DB)
  preview ◀── any PR branch (ephemeral, per-PR DB)
```

Net: **churn is loud and cheap on `dev`; `main` is the quiet, frozen, promoted
truth; demo and prod are both faithful renderings of `main`.**

---

## 6. Capacity reality (corrected)

The customer-facing database is **one managed node**, and the numbers below are
the verified facts (an earlier draft said `db-s-1vcpu-1gb` / ~22 connections —
**both wrong**).

- The managed cluster `sitelayer-db` is **`db-s-1vcpu-2gb`** (1 vCPU / 2 GB, **~47
  max connections**, 1 node, `tor1`).
- **prod reaches it through a managed connection pool** — `sitelayer-prod-pool`,
  **transaction mode, size 11**, database `sitelayer_prod`, user
  `sitelayer_prod_app`. So prod's footprint against the raw cluster is bounded by
  the pool (11), not by however many app/worker connections sit behind it.
- **dev / demo / preview connect _directly_ today** (no pool) and compete for the
  remaining raw ~47 connections — which is exactly the pressure §2 removes.
- **Once non-prod leaves the cluster (§2), prod owns the whole ~47-connection
  node** behind its size-11 pool. That is comfortable headroom for the current
  load.
- **Bumping the node is a cost choice, not a fleet limit.** If prod's own load
  outgrows `db-s-1vcpu-2gb`, resizing to `db-s-2vcpu-4gb` (and/or growing the pool)
  is an on-demand DO operation — a deliberate spend on the product-hosting
  footprint, fully decoupled from the build/verify/e2e fleet, which has ample
  capacity of its own.

Roles, for completeness: `doadmin` (cluster primary/superuser) plus the
non-superuser, per-tier app roles `sitelayer_{prod,dev,preview,demo}_app`. prod
connecting as a non-owner `NOBYPASSRLS` role is what makes RLS `FORCE` bind (see
[`MULTI_TENANCY.md`](./MULTI_TENANCY.md)).
