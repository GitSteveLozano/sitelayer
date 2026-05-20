# Sitelayer Developer Onboarding (Mac)

**Audience:** a new engineering collaborator getting Sitelayer running on a Mac and shipping a first PR. For onboarding a paying construction company through the product, see [`ONBOARDING_CONTRACTOR.md`](./ONBOARDING_CONTRACTOR.md). For architecture and operating rules, read [`CLAUDE.md`](../CLAUDE.md) once setup is done.

This doc is intentionally narrow. It covers the path from a blank Mac to a green local stack to a PR; it does not introduce or require mesh-lite, telemetry ingress, HUD, DNS, Tailscale, browser-bridge, or any new auth/infra. Those are operator concerns, not collaborator prerequisites.

---

## 1. Prerequisites

| Tool                  | Version             | Notes                                                                                                               |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| macOS                 | 13+                 | Apple Silicon supported. Docker images are `linux/amd64`; Docker Desktop emulates transparently.                    |
| Node.js               | 20.x LTS            | `nvm install 20 && nvm use 20`. Workspaces require Node 20.                                                         |
| npm                   | bundled with Node   | npm 10+ (ships with Node 20).                                                                                       |
| Docker Desktop        | latest              | Required for the full local stack (Postgres 18 + MinIO + api/web/worker). Allocate ≥ 6 GB RAM in Docker → Settings. |
| Git                   | latest              | Repo uses Conventional Commits; squash-and-merge.                                                                   |
| `gh` CLI _(optional)_ | latest              | Useful for PR creation; not strictly required.                                                                      |
| `psql` _(optional)_   | matches Postgres 18 | For poking at the local DB. Otherwise `docker compose exec db psql ...` works.                                      |

You do **not** need: Postgres installed on the host (Docker provides it), AWS CLI, DigitalOcean access, Clerk dashboard access, or QBO credentials.

---

## 2. Clone & install

```bash
# 1. Clone (replace with your fork if you're external).
git clone git@github.com:GitSteveLozano/sitelayer.git
cd sitelayer

# 2. Install workspace dependencies (~2-3 min cold cache).
npm install
```

If `npm install` fails on `playwright` postinstall, run `npx playwright install --with-deps chromium` afterward — e2e tests need it but local dev does not.

---

## 3. Environment setup

The repo ships `.env.example` (12 KB) as the **names-only scaffold**. Copy it once; never commit a populated `.env`:

```bash
cp .env.example .env
```

Edit `.env` and fill in only the placeholders relevant to local dev. The minimum viable set for the fixture path is **none** — fixtures bypass everything that needs a secret. The minimum viable set for the full Docker stack is also **none**, because `docker-compose.yml` overrides `DATABASE_URL`, `DO_SPACES_*`, and tier vars for you.

Variables you may want to set locally:

| Variable                         | Purpose                                                                                                     | Local default                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `APP_TIER`                       | Tier guard. Must be `local` for local dev.                                                                  | `local`                                                                                 |
| `DATABASE_URL`                   | API connection string.                                                                                      | `postgres://sitelayer:sitelayer@localhost:5432/sitelayer` (host) or `db:5432` (compose) |
| `VITE_CLERK_PUBLISHABLE_KEY`     | If set, the SPA loads Clerk SignIn/SignUp. If empty, dev RoleSwitcher renders.                              | Empty (use RoleSwitcher)                                                                |
| `CLERK_JWT_KEY`                  | API-side JWT verification. Leave empty locally to keep header-fallback auth on.                             | Empty                                                                                   |
| `QBO_*`                          | QBO OAuth + sandbox flags. Leave at placeholders; QBO sync is not on the golden path for collaborator work. | Placeholders                                                                            |
| `SENTRY_DSN` / `VITE_SENTRY_DSN` | Optional; leave empty unless you want errors to flow.                                                       | Empty                                                                                   |

**Never** put real secrets in a committed file or paste them into a shell that records history. `.env.example` documents names only; real production secrets live in GitHub Actions `production` environment (operator-only).

---

## 4. Run the stack

There are two well-supported local loops:

### 4a. Fastest UI loop (fixtures, no Docker)

For frontend-only work with deterministic seeded data:

```bash
VITE_FIXTURES=1 npm run dev:web
open http://localhost:3100
```

No Postgres, no API server, no Docker. The SPA reads fixtures from disk. Good for component, layout, and screen-flow work. The direct Vite dev server listens on `3100`; the Docker stack below maps host port `3000` to Vite's internal `3100`.

### 4b. Full local stack (API + web + worker + Postgres 18 + MinIO)

For anything that touches the API, a workflow, a migration, or end-to-end behavior:

```bash
docker compose up --build
# First boot ~3-5 min while images pull + migrations apply.
open http://localhost:3000
```

What this gives you:

- Web SPA at `http://localhost:3000`
- API at `http://localhost:3001` (health at `/health`, version at `/api/version`)
- Worker draining `mutation_outbox` and `sync_events`
- Postgres 18 at `localhost:5432` (`sitelayer/sitelayer`), schema applied from `docker/postgres/init/*.sql` on first boot
- MinIO (S3-compatible) at `localhost:9000`, console at `localhost:9001` (`sitelayerlocal/sitelayerlocal`), bucket `sitelayer-blueprints-local` auto-created

If you upgraded from a pre-Postgres-18 checkout, reset the volume on first boot:

```bash
docker compose down -v && docker compose up --build
```

### 4c. Host-process loop (run services on the host, DB in Docker)

If you want hot-reload without rebuilding the api/web/worker images:

```bash
docker compose up -d db minio minio-init
npm run dev    # runs dev:api + dev:web + dev:worker concurrently against the dockerized DB
```

---

## 5. Sign in (Clerk-or-RoleSwitcher)

The repo ships a structurally-prod-safe dev auth bypass so you don't need Clerk creds to exercise RBAC paths.

**Default (no Clerk creds):** Leave `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_JWT_KEY` empty. On boot, a `<RoleSwitcher />` panel renders bottom-right of the SPA. Tap a role — `e2e-admin`, `e2e-foreman`, `e2e-office`, `e2e-member`, or `e2e-bookkeeper` — and the SPA sends `x-sitelayer-act-as: e2e-<role>` on every API call. The API honors the header **only when `APP_TIER !== 'prod'`**. See `CLAUDE.md` → "Local/preview role testing" for the full mechanism.

**With Clerk (preview-tier credentials, optional):** Set `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` (preview key is documented in `.env.example`) and the SPA mounts the real `/sign-in` and `/sign-up` Clerk components. If you need the API to resolve the real Clerk user id, set the matching `CLERK_JWT_KEY` too. If `CLERK_JWT_KEY` is left empty, the API cannot verify the Clerk bearer token and will use the local header/default fallback path instead; that is fine for UI sign-in smoke tests, but it is not a real Clerk-authenticated API session.

For RoleSwitcher, company resolution is still normal Sitelayer tenancy: the user id in `x-sitelayer-act-as` must have a `company_memberships` row for the active company slug. Use the seeded `e2e-fixtures` tenant for the canned `e2e-*` roles, or create your own company/row as below.

---

## 6. Provision a `company_memberships` row

Sitelayer is multi-tenant: every request resolves to a company via `company_memberships`. Three ways to get a row for a fresh local dev user:

### 6a. Default seed (already done for you)

`docker/postgres/init/` includes two relevant seeded tenants:

- `la-operations` — the default local company slug, seeded with `demo-user` as admin.
- `e2e-fixtures` — the role-testing tenant, seeded by `072_e2e_test_fixtures.sql` with one `company_memberships` row per canned RoleSwitcher id (`e2e-admin`, `e2e-foreman`, `e2e-office`, `e2e-member`, `e2e-bookkeeper`).

If you use RoleSwitcher with the canned `e2e-*` ids, use `e2e-fixtures` as the active company. If the SPA is already open on `la-operations`, set the active company from DevTools and reload:

```js
localStorage.setItem('sitelayer.active-company-slug', 'e2e-fixtures')
location.reload()
```

If `npm run seed:e2e` is wired in your tier (it is, for local), run it once:

```bash
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer npm run seed:e2e
```

### 6b. Create your own company through the SPA

Sign in (Clerk or RoleSwitcher) and use the "Create company" form. It posts to `POST /api/companies` with `{ slug, name, seed_defaults: true }` — the handler inserts the company, your `company_memberships` row with `role='admin'`, and the LA template defaults (divisions, service items, pricing profile, bonus rule).

### 6c. CLI for concierge-style setup

The committed `scripts/onboard-company.ts` runs against the DB directly:

```bash
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer \
  npx tsx scripts/onboard-company.ts \
  --slug local-dev \
  --name "Local Dev Co" \
  --admin-user-id e2e-admin \
  --admin-email you@example.com
```

This is the same path admin/concierge onboarding uses in `ONBOARDING_CONTRACTOR.md`. Idempotent.

---

## 7. Typecheck and tests

```bash
# Fast: just types, no build artifacts.
npm run typecheck

# Per workspace (faster iteration):
npm run typecheck --workspace @sitelayer/web
npm run typecheck --workspace @sitelayer/api

# Unit tests (vitest, collocated).
npm run test

# Web bundle gzip budget (CI gate).
npm run web:bundle-budget

# Full CI mirror — slow (~5-10 min cold). Run before pushing a non-trivial PR.
npm run ci:quality

# Playwright E2E — requires the full local stack already up.
npm run test:e2e
```

E2E and the bundle budget run in CI; you can skip them for docs-only or comment-only PRs. Typecheck + test + lint are non-negotiable — ESLint runs with `--max-warnings=0`.

---

## 8. First branch + PR workflow

```bash
# 1. Branch off main. Convention: agent/<your-handle>/<topic> for agent-driven work,
#    or plain <topic> for human-driven work.
git switch -c <your-handle>/<topic>

# 2. Make a small, focused change. Three lines beat a premature abstraction —
#    don't widen scope.

# 3. Local checks before pushing:
npm run format:write   # prettier
npm run lint
npm run typecheck
npm run test

# 4. Commit. Conventional commits; squash-and-merge means the PR title
#    becomes the final commit message — keep titles under 70 chars.
git commit -m "fix(web): correct draft picker keyboard focus"

# 5. Push and open a PR against main. Use the PR template (.github/PULL_REQUEST_TEMPLATE.md);
#    fill in migration notes if you touched docker/postgres/init/.
git push -u origin HEAD
gh pr create --base main
```

**Hard rules** (see [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`AGENTS.md`](../AGENTS.md)):

- **Never push directly to `main`.**
- **Never edit a committed migration** in `docker/postgres/init/*.sql` — schema corrections land as the next sequential file.
- **No new `useState + useEffect` for multi-mode long-lived state** — use an XState machine under `apps/web/src/machines/`.
- **No new direct QBO / Clerk / Spaces calls from request handlers** — go through `mutation_outbox`.
- **All HTTP calls from the SPA go through `apps/web/src/lib/api/client.ts:request<T>()`** — do not invent a parallel fetcher.

---

## 9. Coordination: takeoff edits are last-write-wins

Sitelayer's offline-first design resolves replay conflicts on `takeoff_measurements` via **last-write-wins (LWW)** plus a diagnostic toast. Mechanics live in [`CLAUDE.md`](../CLAUDE.md) → Decision #4. Other entities, including estimate-line flows, may rely on optimistic version checks instead. None of this is a collaborative merge UI. Procedural rule for collaborators:

- **Do not edit takeoff drafts, blueprint measurements, or estimate lines on a shared dev/preview tenant unless explicitly assigned.** Two people editing the same draft can cause the older write to be silently discarded; the diagnostic toast only fires on the offline replay path.
- **For PR work that touches the takeoff/measurement code path,** use your own seeded company (Section 6b) instead of the shared `la-operations` template. That way an integration test or manual click-through cannot stomp on someone else's in-flight measurement.
- **If you need to coordinate on the shared tenant** (e.g. reproducing a customer report), ping in the working channel before opening the draft. This is a procedural v1 mitigation — there is no merge UI today.

This is a coordination rule, not an architecture project. Do not propose a CRDT, lock manager, or new merge UI without an issue and an ADR.

---

## 10. Stop / reset local dev

```bash
# Stop containers, keep volumes (data preserved across restarts).
docker compose down

# Stop and wipe volumes (Postgres + MinIO). Use after migration changes
# or when the DB is in a bad state.
docker compose down -v

# Tail a single service.
docker compose logs -f api
docker compose logs -f worker

# Reset host-only host-process loop (Section 4c) — Ctrl-C the `npm run dev`,
# then docker compose stop db minio if you want the DB down too.
```

Common gotchas:

- Port 3000 busy → Vite picks the next free port and prints the URL.
- Port 5432 busy → host Postgres is running; either stop it or change the compose port mapping for `db`.
- `tier mismatch on boot` from the API → your `.env` has `APP_TIER=dev` or `prod` while `DATABASE_URL` points at a local DB. Reset `APP_TIER=local`.
- Stale `node_modules` after dependency churn → `rm -rf node_modules apps/*/node_modules packages/*/node_modules && npm install`.

---

## Where to go next

- [`CLAUDE.md`](../CLAUDE.md) — operating rules, deploy procedure, env management, QBO conventions.
- [`AGENTS.md`](../AGENTS.md) — short guide for agent-authored changes.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — PR checklist, test conventions, where new code goes.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) and [`docs/adr/`](./adr/) — durable design.
- [`docs/RUNBOOK_INDEX.md`](./RUNBOOK_INDEX.md) — production incident runbooks (read once; not needed for first PR).
