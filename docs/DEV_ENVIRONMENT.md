# Sitelayer Dev Environment

**Status:** Provisioning. Workflow + scripts shipped 2026-05-20. DNS + shared env file installation are operator steps below.
**URL:** `https://dev.sitelayer.sandolab.xyz` (web + API on one host, same routing model as prod and preview)

## Why this exists

PR previews are ephemeral and per-PR (`sitelayer_pr_42` schema, dropped on PR close). That works for "does my migration apply" but is the wrong shape for:

- **Iterating on a schema change before opening a PR.** Migrations in `docker/postgres/init/*.sql` are immutable once committed. The dev environment lets an agent reset the dev DB and rewrite an in-flight migration cleanly before it becomes an immutable PR.
- **Demo / collaboration on persistent data.** A stable URL that survives PR lifecycles so collaborators can see "what's on dev right now" without coordinating around an open PR.
- **MCP/Claude-Desktop scratch space.** CLAUDE.md earmarks `sitelayer_dev` for agent-driven work; this environment is the HTTP front for that DB.

## Hierarchy

| URL                                           | Tier      | Database             | Lifecycle                       |
| --------------------------------------------- | --------- | -------------------- | ------------------------------- |
| `https://sitelayer.sandolab.xyz`              | `prod`    | `sitelayer_prod`     | Permanent. Real customers.      |
| `https://dev.sitelayer.sandolab.xyz`          | `dev`     | `sitelayer_dev`      | Permanent. Tracks `dev` branch. |
| `https://main.preview.sitelayer.sandolab.xyz` | `preview` | `sitelayer_preview`† | Permanent smoke. Tracks `main`. |
| `https://pr-N.preview.sitelayer.sandolab.xyz` | `preview` | `sitelayer_preview`† | Per PR; dropped on close.       |

† Each preview slug owns an isolated schema `sitelayer_<slug>` inside the shared DB.

## Deploy contract

> **DEPLOY MODEL UPDATED 2026-06-01.** Deploys are now local-fleet via
> `scripts/deploy.sh dev` — the GitHub Actions `deploy-dev.yml` workflow and
> the self-hosted preview runner were removed in commit `70b9584b`.

From the fleet, `scripts/deploy.sh dev` (with `HEAD` on an origin branch, normally `dev`) SSHes to the preview droplet and invokes `scripts/deploy-preview.sh` with:

```
PREVIEW_SLUG=dev
PREVIEW_HOST=dev.sitelayer.sandolab.xyz
PREVIEW_TIER=dev                  # selects shared-public-schema mode
PREVIEW_SHARED_ENV=/app/previews/.env.dev.shared
PREVIEW_MODE=dev                  # source-mounted watch-mode (tsx + vite HMR)
PREVIEW_ENABLE_WORKER=1
```

The deploy script, when `PREVIEW_TIER=dev`:

1. Skips per-slug schema derivation; writes no `PREVIEW_DB_SCHEMA` / `DB_SCHEMA` / `PGOPTIONS` to the rendered `.env`. Migrations land in `public`.
2. Skips the `ensure-preview-schema.sh` step.
3. Writes `VITE_SENTRY_ENVIRONMENT=dev` to the rendered `.env` (instead of `preview`).

Everything else — rsync to `/app/previews/dev/`, env-file merge from the shared file, container restart, health check at `https://dev.sitelayer.sandolab.xyz/health` — is identical to the preview path.

## Database story

- **Dedicated database:** `sitelayer_dev` on the existing managed cluster `sitelayer-db`. Already provisioned (see CLAUDE.md infrastructure snapshot).
- **App role:** `sitelayer_dev_app` (existing). Trusted-source list already includes the preview droplet, so no firewall changes.
- **Schema:** `public` — there is no per-slug isolation here. The `APP_TIER=dev` guard in `packages/config/src/index.ts:157-159` enforces that this database name contains `sitelayer_dev` at startup.
- **Reset workflow:** `scripts/reset-dev-db.sh` drops every table / view / sequence / enum in the `public` schema and re-runs migrations. (Per-object drops, not `DROP SCHEMA public CASCADE` — keeps the script runnable under the app role's normal DDL privileges, since the managed-Postgres `sitelayer_dev_app` role doesn't own the schema itself.) Refuses to run against any DB whose name doesn't include `sitelayer_dev`.

### Iterating on a migration

```bash
# 1. On the dev branch, add a new migration:
#    docker/postgres/init/088_my_new_thing.sql
# 2. Reset the dev DB and apply from scratch:
DATABASE_URL=postgres://sitelayer_dev_app:...@.../sitelayer_dev?sslmode=require \
  DATABASE_SSL_REJECT_UNAUTHORIZED=false \
  RESET_DEV_DB_CONFIRM=1 \
  scripts/reset-dev-db.sh
# 3. Commit + push to dev, then `scripts/deploy.sh dev` from the fleet —
#    deploys, applies any unseen migrations incrementally, runs check-db-schema.sh.
# 4. Iterate on the .sql file as needed; reset & push again.
# 5. Once happy, open a PR against main. From that point on the migration
#    file is immutable per CLAUDE.md "Deploy procedure" rule #2.
```

## Web UI signal

- **Tier ribbon:** `'DEV DATA - not real customers'` in warn (orange/yellow) tone, rendered by `packages/config/src/index.ts:186`.
- **Role switcher:** active by default — `VITE_CLERK_PUBLISHABLE_KEY` in the shared env points at the Clerk test pool, and `CLERK_JWT_KEY` is empty, so the dev-mode `<RoleSwitcher />` panel appears for agents/collaborators to swap roles without Clerk users.
- **`x-sitelayer-act-as` header:** honored by `apps/api/src/auth.ts:resolveActAsOverride` because `tier !== 'prod'`.

## Operator setup (one-time)

These steps are not automated yet; the operator runs them once. Estimated time: 5–10 min.

### 1. DNS — Cloudflare A record

In the `sandolab.xyz` zone:

```
Name:    dev.sitelayer
Type:    A
Value:   159.203.53.218        # reserved preview-droplet IP
TTL:     auto
Proxy:   off (orange cloud off — Traefik handles TLS directly via ACME)
```

CLI option (requires Cloudflare API token):

```bash
# Adjust ZONE_ID and CF_API_TOKEN as needed.
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"A","name":"dev.sitelayer","content":"159.203.53.218","ttl":1,"proxied":false}'
```

### 2. Install the shared env file on the preview droplet

```bash
ssh sitelayer@10.118.0.2     # private IP from PREVIEW_DEPLOYMENTS.md
sudo install -m 0600 -o sitelayer -g sitelayer \
  /dev/null /app/previews/.env.dev.shared
sudo nano /app/previews/.env.dev.shared
# Paste a filled-in copy of ops/env/dev.env.example
```

Required values to fill in (the others can be left as the example):

- `DATABASE_URL` — sitelayer_dev_app role connection string from the managed Postgres cluster (doctl databases user list `sitelayer-db`)
- `DO_SPACES_*` — only if you've created the `sitelayer-blueprints-dev` bucket. Otherwise leave commented; uploads will use the per-stack Docker volume.
- `QBO_*`, `SENTRY_*`, `RESEND_*`, `ANTHROPIC_API_KEY`, etc. — fill if/when you need that integration on dev.

### 3. Create the `dev` branch on GitHub

```bash
git fetch origin
git push origin origin/main:refs/heads/dev
```

The workflow fires on push to `dev`; the first deploy bootstraps everything.

### 4. Verify

```bash
curl https://dev.sitelayer.sandolab.xyz/health
# → JSON with version + tier=dev
curl -sSI https://dev.sitelayer.sandolab.xyz/ | grep -i ^server
# → caddy or traefik header
```

Web app should load and display the orange "DEV DATA - not real customers" ribbon.

## What's intentionally NOT here

- **Promotion workflow.** There's no `dev → main` auto-promote. The `dev` branch is a fast-moving integration lane, not a release candidate. Production deploys happen via `scripts/deploy.sh prod` from the fleet per CLAUDE.md "Deploy procedure" rule #1 (and under the adopted model, `main` is the protected production truth).
- **Backup retention.** The managed Postgres cluster's automatic backups cover `sitelayer_dev` along with everything else, but there's no logical/off-host copy specifically for dev — that's reserved for prod. Treat `sitelayer_dev` as destructible.
- **Cleanup workflow.** Unlike PR previews, the dev stack is not auto-torn-down. To wind it down manually:
  ```bash
  ssh sitelayer@10.118.0.2
  cd /app/previews/dev && docker compose -p sitelayer-dev down --volumes
  ```
  And remove the Cloudflare A record. The `sitelayer_dev` database stays intact (it predates this work).

## Cross-references

- `scripts/deploy.sh` — fleet entrypoint (`dev` / `demo` / `prod`)
- `scripts/deploy-preview.sh` — the parameterized deploy script (serves preview, dev, and demo tiers)
- `scripts/reset-dev-db.sh` — dev-DB reset helper
- `ops/env/dev.env.example` — shared env template
- `docs/PREVIEW_DEPLOYMENTS.md` — sibling preview infrastructure (per-PR stacks)
- `packages/config/src/index.ts` — tier guard + ribbon definitions
- CLAUDE.md → "Operating Rules" → Env management #1 (APP_TIER load-bearing)
