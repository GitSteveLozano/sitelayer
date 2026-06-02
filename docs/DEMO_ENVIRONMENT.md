# Sitelayer Demo Environment

**Status:** Provisioning. Workflow + compose path shipped 2026-05-31. The shared
env file installation is the operator step below.
**URL:** `https://demo.preview.sitelayer.sandolab.xyz` (web + API on one host,
same routing model as prod, preview, and dev)

## Why this exists

A dedicated, persistent DEMO tier for prospect-facing showcases — distinct from
the agent/scratch `dev` tier and the ephemeral per-PR previews:

- **Public showcase on a stable URL.** A long-running stack that survives PR
  lifecycles so prospects can be sent one link.
- **Fake, disposable data.** Backed by its own `sitelayer_demo` database so
  visitor edits never touch real customer or agent-iteration data.
- **Clerk-ON real sign-in.** Unlike dev (which leans on the act-as
  RoleSwitcher), demo signs prospects in with real Clerk sessions minted as
  sign-in tokens against the shared Clerk **test** instance.

## Hierarchy

| URL                                           | Tier      | Database             | Lifecycle                        |
| --------------------------------------------- | --------- | -------------------- | -------------------------------- |
| `https://sitelayer.sandolab.xyz`              | `prod`    | `sitelayer_prod`     | Permanent. Real customers.       |
| `https://demo.preview.sitelayer.sandolab.xyz` | `demo`    | `sitelayer_demo`     | Permanent. Tracks `demo` branch. |
| `https://dev.sitelayer.sandolab.xyz`          | `dev`     | `sitelayer_dev`      | Permanent. Tracks `dev` branch.  |
| `https://main.preview.sitelayer.sandolab.xyz` | `preview` | `sitelayer_preview`† | Permanent smoke. Tracks `main`.  |
| `https://pr-N.preview.sitelayer.sandolab.xyz` | `preview` | `sitelayer_preview`† | Per PR; dropped on close.        |

† Each preview slug owns an isolated schema `sitelayer_<slug>` inside the shared DB.

## Deploy contract

Deploy the demo tier from the fleet (e.g. taylor-pc-ubuntu) with
`scripts/deploy.sh demo` → `scripts/deploy-preview.sh` on the preview droplet.
There is no push-trigger and no GitHub Actions in this path; the deploy
invokes `scripts/deploy-preview.sh` with:

```
PREVIEW_SLUG=demo
PREVIEW_HOST=demo.preview.sitelayer.sandolab.xyz
PREVIEW_TIER=demo                 # selects shared-public-schema mode (like dev)
PREVIEW_SHARED_ENV=/app/previews/.env.demo.shared
PREVIEW_ENABLE_WORKER=1
```

The demo tier is a behavioral clone of the dev tier. In `scripts/deploy-preview.sh`,
`PREVIEW_TIER=demo` takes the same non-`preview` path the `dev` tier uses:

1. Skips per-slug schema derivation; writes no `PREVIEW_DB_SCHEMA` / `DB_SCHEMA`
   / `PGOPTIONS` to the rendered `.env`. Migrations land in `public`.
2. Skips the `ensure-preview-schema.sh` step.
3. Writes `VITE_SENTRY_ENVIRONMENT=demo` to the rendered `.env`.

Everything else — rsync to `/app/previews/demo/`, env-file merge from the shared
file, container restart via `docker-compose.preview.yml` (the SAME compose file
the preview/dev tiers use; parameterized by `PREVIEW_SLUG` / `PREVIEW_HOST` /
`APP_TIER` / `VITE_APP_TIER`), Traefik routing with the same `letsencrypt` cert
resolver, and the health check at `https://demo.preview.sitelayer.sandolab.xyz/health`
— is identical to the dev/preview path.

The Traefik router rule resolves to `Host(\`demo.preview.sitelayer.sandolab.xyz\`)`because that host is supplied as`PREVIEW_HOST`. No DNS change is needed: the
hostname already resolves via the existing `\*.preview.sitelayer.sandolab.xyz`wildcard pointed at the preview droplet`159.203.53.218`.

## Database story

- **Dedicated database:** `sitelayer_demo` on the existing managed cluster
  `sitelayer-db` (`9948c96b-b6b6-45ad-adf7-d20e4c206c66`). Already provisioned.
- **App role (REQUIRED state — least privilege, NOT `doadmin`):** the demo tier
  MUST connect as the scoped `sitelayer_demo_app` role, **never** as `doadmin`.
  `doadmin` is the cluster superuser and `sitelayer-db` also hosts
  `sitelayer_prod`, so a `doadmin` demo `DATABASE_URL` is a cluster-wide
  blast-radius risk: a leak would let an attacker read or mutate prod at the SQL
  layer, bypassing the `APP_TIER` boot guard (the app-layer guard does NOT cover
  this — see `docs/steve-handoff/demo-design/R5-security-isolation.md` §1.3/§4).
  `sitelayer_demo_app` is scoped to `CONNECT` on `sitelayer_demo` only and is
  granted exactly `SELECT,INSERT,UPDATE,DELETE` on tables + `USAGE,SELECT,UPDATE`
  on sequences in `public` — it has **no** `CONNECT` on `sitelayer_prod`. This
  mirrors the dev/preview tiers, which already use `sitelayer_dev_app` /
  `sitelayer_preview_app`.
- **Schema:** `public` — there is no per-slug isolation here. The `APP_TIER=demo`
  guard in `packages/config/src/index.ts` enforces that this database name
  contains `sitelayer_demo` at startup.
- **Reset workflow:** treat `sitelayer_demo` as fully destructible. A nightly
  reseed/reset is recommended so visitor edits don't degrade the demo (see Open
  questions in R5). The demo seed is owned by the demo-seed unit (R4).

### Provisioning the least-privilege role

`scripts/provision-demo-db-role.sh` creates/updates `sitelayer_demo_app` and
grants it the least set the app needs. It is **idempotent** — safe to re-run, and
a password rotation is just a re-run with a new `DEMO_DB_APP_PASSWORD`. It reads
the admin connection string and the role password **from the environment only**
and never prints either. The operator runs it once against the cluster; nothing
in this repo connects to the DB on its own.

```bash
# 1. Generate a strong app-role password (keep it out of shell history / files).
DEMO_DB_APP_PASSWORD="$(openssl rand -base64 24)"

# 2. Provision (connect AS an admin role — e.g. the doadmin URI). The admin URL
#    and the password are env-only and are never echoed.
ADMIN_DATABASE_URL="$(doctl databases connection 9948c96b-b6b6-45ad-adf7-d20e4c206c66 --format URI --no-header)" \
DEMO_DB_APP_PASSWORD="$DEMO_DB_APP_PASSWORD" \
  scripts/provision-demo-db-role.sh

# 3. Report current grants only (no writes, no password needed) at any time:
ADMIN_DATABASE_URL="$(doctl databases connection 9948c96b-b6b6-45ad-adf7-d20e4c206c66 --format URI --no-header)" \
  scripts/provision-demo-db-role.sh --check
```

The script prints a final verification block of **counts** (role exists + can
login, `CONNECT` on `sitelayer_demo`, table/sequence grant counts, and the
default-privilege rows that cover FUTURE migration-created objects) — never the
password.

> **Prod-isolation caveat (`PUBLIC` CONNECT — read this).** A freshly-created
> Postgres database grants `CONNECT` to `PUBLIC` by default, so the
> `REVOKE CONNECT ON DATABASE sitelayer_prod FROM sitelayer_demo_app` the script
> runs is **not sufficient on its own** — the demo role can still reach prod via
> the `PUBLIC` grant. The script DETECTS this and prints a loud `WARNING` with
> the exact statement to close it. The script does **not** apply it
> automatically because it changes PROD's ACL cluster-wide; that is an
> operator-approved, prod-wide action. To truly fence demo off prod, run (as an
> admin, with approval):
>
> ```sql
> REVOKE CONNECT ON DATABASE sitelayer_prod FROM PUBLIC;
> ```
>
> Prod's own roles (`sitelayer_prod_app`, etc.) connect via explicit `GRANT`, so
> revoking the `PUBLIC` connect is safe for them — but verify prod stays healthy
> after. Until this is done, the demo role inherits `PUBLIC`'s connect to prod.

> **Managed-PG caveat (default privileges for future tables).** New tables
> created by later migrations only inherit the role's grants if
> `ALTER DEFAULT PRIVILEGES` was set **for the role that owns (creates) those
> objects**. On managed Postgres, migrations run as the cluster default user
> (e.g. `doadmin`), not necessarily the connection you provisioned from. The
> script sets `ALTER DEFAULT PRIVILEGES FOR ROLE <owner>` best-effort (owner
> derived from the admin URL's username, override with `DEMO_DB_OWNER_ROLE`); if
> it lacks privilege it prints the exact two `ALTER DEFAULT PRIVILEGES` lines to
> re-run **while connected AS the owner role**. After any new migration that
> creates tables/sequences, either re-run this script or run a one-off
> `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO sitelayer_demo_app;`
> to backfill existing objects.

### Point the demo tier at the new role and bounce it

Once the role exists, update the demo shared env so `DATABASE_URL` uses
`sitelayer_demo_app` instead of `doadmin`, then recreate the demo containers.
The demo env file lives at `/app/previews/.env.demo.shared` on the preview
droplet (`159.203.53.218`, private `10.118.0.2`):

```bash
ssh sitelayer@159.203.53.218
# Edit /app/previews/.env.demo.shared — set DATABASE_URL to the scoped role:
#   DATABASE_URL=postgres://sitelayer_demo_app:<password>@<cluster-host>:25060/sitelayer_demo?sslmode=require
# (the <password> is the DEMO_DB_APP_PASSWORD you provisioned with; the host is
#  the cluster's private/public host from `doctl databases connection`.)
sudo -u sitelayer nano /app/previews/.env.demo.shared
```

Then bounce the demo stack so it re-reads the env (no image build needed — demo
is source-mounted watch-mode):

```bash
cd /app/previews/demo && docker compose -p sitelayer-demo up -d --force-recreate
```

Verify the demo still boots (the `APP_TIER=demo` guard requires the DB name to
contain `sitelayer_demo`, so a wrong-tier URL fails loudly):

```bash
curl -s https://demo.preview.sitelayer.sandolab.xyz/api/version | grep -i demo
# → tier: "demo"
```

Re-run `scripts/provision-demo-db-role.sh --check` afterwards to confirm the
grant counts are non-zero.

### `doadmin` password rotation runbook (operator-approved, cluster-wide)

> **Blast radius: the ENTIRE `sitelayer-db` cluster.** `doadmin` is the managed
> Postgres superuser shared by `sitelayer_prod`, `sitelayer_demo`,
> `sitelayer_dev`, and `sitelayer_preview`. Rotating it is an **incident-style,
> operator-approved** action, not routine maintenance. Do NOT rotate `doadmin`
> casually — rotate the per-tier scoped app roles instead (that is what
> `provision-demo-db-role.sh` and the `DATABASE_URL` flow in
> `docs/SECRET_ROTATION.md` §9 do).

Rotate `doadmin` only when it is genuinely compromised (e.g. the superuser URI
leaked into a transcript). Hard pre-requisites before you touch it:

1. **Every non-prod tier must already be OFF `doadmin`.** Confirm demo uses
   `sitelayer_demo_app` (this doc, above), and that dev/preview use
   `sitelayer_dev_app` / `sitelayer_preview_app`. Grep each tier's env:
   ```bash
   for f in .env.demo.shared .env.dev.shared .env.shared; do
     ssh sitelayer@159.203.53.218 "grep -H '^DATABASE_URL=' /app/previews/$f" | grep -q doadmin \
       && echo "BLOCKER: $f still uses doadmin — move it to a scoped role first"
   done
   ```
2. **Confirm prod's own role.** Prod connects as `sitelayer_prod_app` (see
   `docs/SECRET_ROTATION.md` §9), NOT `doadmin`. Verify `/app/sitelayer/.env`
   on the prod droplet does not embed `doadmin` before rotating.
3. **Operator approval + incident note.** Because this is cluster-wide, get
   explicit approval and write an incident note (per the production change
   rules) BEFORE running the reset.

Once all tiers are confirmed off `doadmin`, rotate via DO:

```bash
# Cluster id: 9948c96b-b6b6-45ad-adf7-d20e4c206c66
# Option A (CLI): reset doadmin's auth/password.
doctl databases user reset-auth 9948c96b-b6b6-45ad-adf7-d20e4c206c66 doadmin
#   (older doctl uses: `doctl databases user reset <cluster> doadmin`)

# Option B (DO Console): Databases → sitelayer-db → Users & Databases →
#   doadmin → "Reset password".
```

After the reset, re-pull any admin tooling that embeds the old `doadmin` URI
(e.g. local `doctl databases connection` callers, the
`provision-demo-db-role.sh` `ADMIN_DATABASE_URL` you export) — there is no
stored copy in this repo, so nothing in-repo needs patching. The scoped app
roles are unaffected: their passwords are independent of `doadmin`, so no
tier needs to be bounced just because `doadmin` rotated.

See `docs/SECRET_ROTATION.md` §9 (per-tier `DATABASE_URL` / app-role rotation)
and `docs/INCIDENT_RESPONSE.md` §8 (compromised credential — revoke first) for
the surrounding procedures.

## Web UI signal

- **Tier ribbon:** `'DEMO - sample data, public showcase'` in the dedicated
  `demo` tone, defined by `ribbonForTier` in `packages/config/src/index.ts`.
- **Auth:** Clerk-ON — `VITE_CLERK_PUBLISHABLE_KEY` points at the Clerk test
  pool and the prospect is signed in with a real session. The dev-mode
  `<RoleSwitcher />` stays un-mounted whenever a Clerk key is present, but the
  `x-sitelayer-act-as` header is still honored by the API (`tier !== 'prod'`)
  for internal QA.

## Access control

The demo URL is public on the wildcard. Per the demo-design decision a **light
shared access code** keeps casual crawlers and bots out. This is enforced at the
EDGE (Traefik basicAuth in front of the demo host, or Cloudflare Access — see
`docs/steve-handoff/demo-design/R3-cloudflare-dns-edge.md` and `R5-security-isolation.md`),
NOT inside this app stack, so `docker-compose.preview.yml` stays byte-identical
to the dev/preview tiers. The `DEMO_ACCESS_CODE` env var in
`ops/env/demo.env.example` is documented for the operator's reference; wiring the
credential is the edge unit's responsibility.

## Sendable Email Links

For a simple prospect email, generate a one-click Clerk ticket and email the
printed body:

```bash
DEMO_ACCESS_CODE=<shared-code> npm run demo:email -- --role owner --name "Steve"
```

The default sign-in-token TTL is 24 hours (`DEMO_SIGN_IN_TOKEN_TTL_SECONDS=86400`)
and shorter env values are clamped back up to 24 hours. The generated email also
includes the durable fallback path (`/demo` + access code + role), so a stale
ticket does not require a developer to rescue the demo.

## Operator setup (one-time)

These steps are not automated; the operator runs them once.

### 1. DNS — none required

`demo.preview.sitelayer.sandolab.xyz` already resolves via the existing
`*.preview.sitelayer.sandolab.xyz` wildcard at `159.203.53.218`. No new record.

### 2. Install the shared env file on the preview droplet

```bash
ssh sitelayer@10.118.0.2     # private IP from PREVIEW_DEPLOYMENTS.md
sudo install -m 0600 -o sitelayer -g sitelayer \
  /dev/null /app/previews/.env.demo.shared
sudo nano /app/previews/.env.demo.shared
# Paste a filled-in copy of ops/env/demo.env.example
```

Required values to fill in (the others can be left as the example):

- `DATABASE_URL` — least-privilege `sitelayer_demo_app` role connection string
  for `sitelayer_demo` (NOT `doadmin`). Provision the role first with
  `scripts/provision-demo-db-role.sh` (see "Database story" → "Provisioning the
  least-privilege role"), then use
  `postgres://sitelayer_demo_app:<password>@<host>:25060/sitelayer_demo?sslmode=require`.
- `DEMO_ACCESS_CODE` — shared access code required by `/api/demo/sign-in-link`.
- `DEMO_SIGN_IN_TOKEN_TTL_SECONDS` — one-click email-link validity; defaults to
  86400 seconds and is clamped to at least one day.
- `DEMO_APP_ORIGIN` — demo origin for Clerk ticket redirects; the deploy wrapper
  writes the generated value too, but keep this set for manual API runs.
- `CLERK_SECRET_KEY` — the Clerk **test** instance secret (`sk_test_…`), for
  minting prospect sign-in tokens. Never commit it.
- `DO_SPACES_*` — only if you've created the `sitelayer-blueprints-demo` bucket.
  Otherwise leave commented; uploads will use the per-stack Docker volume.

### 3. First deploy

Run `scripts/deploy.sh demo` from the fleet (`demo` is an `APP_TIER=demo`
environment deployed from a chosen ref, not a long-lived code branch). The
first deploy bootstraps everything.

### 4. Verify

```bash
curl https://demo.preview.sitelayer.sandolab.xyz/health
# → JSON with version + tier=demo
curl -s https://demo.preview.sitelayer.sandolab.xyz/api/version | grep -i demo
# → tier: "demo"
```

Web app should load and display the "DEMO - sample data, public showcase" ribbon.

## What's intentionally NOT here

- **Promotion workflow.** There's no `demo → main` auto-promote. The `demo`
  branch is a showcase lane, not a release candidate.
- **Backup retention.** Treat `sitelayer_demo` as destructible; no off-host
  logical copy is taken for it.
- **Cleanup workflow.** The demo stack is not auto-torn-down. To wind it down:
  ```bash
  ssh sitelayer@10.118.0.2
  cd /app/previews/demo && docker compose -p sitelayer-demo down --volumes
  ```

## Cross-references

- `scripts/deploy-preview.sh` — the parameterized deploy script (serves
  preview, dev, and demo tiers)
- `scripts/provision-demo-db-role.sh` — provisions the least-privilege
  `sitelayer_demo_app` DB role (idempotent; `--check` reports current grants)
- `ops/env/demo.env.example` — shared env template
- `docs/SECRET_ROTATION.md` §9 — per-tier `DATABASE_URL` / app-role rotation
  (and the `doadmin` rotation runbook above for the cluster-wide superuser)
- `scripts/deploy.sh` — fleet entrypoint (`scripts/deploy.sh demo`)
- `docs/DEV_ENVIRONMENT.md` — sibling dev tier (the shape this mirrors)
- `docs/steve-handoff/demo-design/` — the demo-design research + build units
  (R1 tier, R2 auth, R3 edge/DNS, R4 seed, R5 security)
- `packages/config/src/index.ts` — tier guard + ribbon definitions

```

```
