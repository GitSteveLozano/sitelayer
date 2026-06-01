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

Push to `demo` → `.github/workflows/deploy-demo.yml` runs on the
`sitelayer-preview` self-hosted runner → invokes `scripts/deploy-preview.sh`
with:

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
  `sitelayer-db`. Already provisioned.
- **App role:** use a least-privilege `sitelayer_demo_app` role scoped to
  `CONNECT` on `sitelayer_demo` only — it must NOT have `CONNECT` on
  `sitelayer_prod` (shared-cluster blast-radius mitigation; see
  `docs/steve-handoff/demo-design/R5-security-isolation.md`).
- **Schema:** `public` — there is no per-slug isolation here. The `APP_TIER=demo`
  guard in `packages/config/src/index.ts` enforces that this database name
  contains `sitelayer_demo` at startup.
- **Reset workflow:** treat `sitelayer_demo` as fully destructible. A nightly
  reseed/reset is recommended so visitor edits don't degrade the demo (see Open
  questions in R5). The demo seed is owned by the demo-seed unit (R4).

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
  for `sitelayer_demo` (doctl databases user list `sitelayer-db`)
- `DEMO_ACCESS_CODE` — shared access code required by `/api/demo/sign-in-link`.
- `DEMO_SIGN_IN_TOKEN_TTL_SECONDS` — one-click email-link validity; defaults to
  86400 seconds and is clamped to at least one day.
- `DEMO_APP_ORIGIN` — demo origin for Clerk ticket redirects; the deploy wrapper
  writes the generated value too, but keep this set for manual API runs.
- `CLERK_SECRET_KEY` — the Clerk **test** instance secret (`sk_test_…`), for
  minting prospect sign-in tokens. Never commit it.
- `DO_SPACES_*` — only if you've created the `sitelayer-blueprints-demo` bucket.
  Otherwise leave commented; uploads will use the per-stack Docker volume.

### 3. Create the `demo` branch on GitHub

```bash
git fetch origin
git push origin origin/main:refs/heads/demo
```

The workflow fires on push to `demo`; the first deploy bootstraps everything.

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
- `ops/env/demo.env.example` — shared env template
- `.github/workflows/deploy-demo.yml` — the workflow
- `docs/DEV_ENVIRONMENT.md` — sibling dev tier (the shape this mirrors)
- `docs/steve-handoff/demo-design/` — the demo-design research + build units
  (R1 tier, R2 auth, R3 edge/DNS, R4 seed, R5 security)
- `packages/config/src/index.ts` — tier guard + ribbon definitions

```

```
