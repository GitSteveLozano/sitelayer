# Sitelayer Developer Onboarding (Mac)

**Audience:** a new engineering collaborator getting Sitelayer running on a Mac and shipping a first PR. For onboarding a paying construction company through the product, see [`ONBOARDING_CONTRACTOR.md`](./ONBOARDING_CONTRACTOR.md). Operator-only architecture and deployment notes can wait until after this local path works.

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

### Optional: BYO AI subscriptions

Use your own Claude, Codex, ChatGPT, Gemini, or other coding subscriptions from
your own browser/CLI profile. Do not ask for Taylor's provider tokens and do not
commit provider keys to this repo. The Sitelayer collaborator path only assumes
that you can run the app, inspect failures, and open PRs; AI tooling is a local
accelerator, not a repo dependency.

Quick smoke checks, if you use the CLIs:

```bash
claude --version || true
codex --version || true
gemini --version || true
```

---

## 2. Clone & install

Taylor must grant repo access before this step. The repo remote is SSH by
default, so verify GitHub access before spending time on Node or Docker:

```bash
# One-time Mac setup if SSH is not configured yet.
ssh-keygen -t ed25519 -C "your-email@example.com"
pbcopy < ~/.ssh/id_ed25519.pub
# Add the copied key in GitHub → Settings → SSH and GPG keys.

ssh -T git@github.com
git ls-remote --heads git@github.com:GitSteveLozano/sitelayer.git main
```

If you prefer HTTPS, run `gh auth login`, choose GitHub.com, and clone with the
HTTPS URL from GitHub instead. Use one path or the other; do not mix remotes on
the first setup.

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

For the collaborator path, do **not** copy `.env.example` blindly. It includes
a preview Clerk publishable key for other workflows; copying it as-is makes the
SPA mount Clerk and suppresses the local RoleSwitcher.

Create a minimal local `.env` instead:

```bash
cat > .env <<'EOF'
APP_TIER=local
VITE_CLERK_PUBLISHABLE_KEY=
CLERK_JWT_KEY=
EOF
```

Docker Compose overrides `DATABASE_URL`, `DO_SPACES_*`, and tier vars for the
local stack. Keep Clerk vars empty unless Taylor explicitly asks for a
Clerk-authenticated check.

Variables you may want to set locally:

| Variable                         | Purpose                                                                                                     | Local default                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `APP_TIER`                       | Tier guard. Must be `local` for local dev.                                                                  | `local`                                                                                 |
| `DATABASE_URL`                   | API connection string.                                                                                      | `postgres://sitelayer:sitelayer@localhost:5432/sitelayer` (host) or `db:5432` (compose) |
| `VITE_CLERK_PUBLISHABLE_KEY`     | If set, the SPA loads Clerk SignIn/SignUp. If empty, dev RoleSwitcher renders.                              | Empty (use RoleSwitcher)                                                                |
| `CLERK_JWT_KEY`                  | API-side JWT verification. Leave empty locally to keep header-fallback auth on.                             | Empty                                                                                   |
| `QBO_*`                          | QBO OAuth + sandbox flags. Leave at placeholders; QBO sync is not on the golden path for collaborator work. | Placeholders                                                                            |
| `SENTRY_DSN` / `VITE_SENTRY_DSN` | Optional; leave empty unless you want errors to flow.                                                       | Empty                                                                                   |

**Never** put real secrets in a committed file or paste them into a shell that records history. `.env.example` documents names only; real production secrets live in `/app/sitelayer/.env` on the prod droplet (rendered from the `ops/env/production.env.json` manifest, operator-only) — there is no GitHub Actions secret store in the deploy path.

### Never set these locally (operator-only)

These point at the operator's private infrastructure (Tailnet-only or
production). On a collaborator machine they will not work — they 503 / fail to
connect, or worse, mislead the logs into chasing a backend that isn't there.
Leave every one **empty**:

```bash
SENTRY_DSN=               # + VITE_SENTRY_DSN — operator Sentry org; rely on Pino console logs locally
MESH_API_URL=             # operator's private mesh (Tailnet-only); empty = in-app AI chat cleanly OFF
AXIOM_TOKEN=              # + AXIOM_DATASET — operator Axiom log warehouse
DATABASE_URL_PROD_RO=     # read-only prod pool (the read-prod-ro flag); never request prod DB access
QBO_*  (prod realm creds) # use QBO_ENVIRONMENT=sandbox only; never live Intuit creds
DEPLOY_HOST=              # + DEPLOY_SSH_KEY — fleet/prod deploy (root-equivalent); collaborators don't deploy
```

---

## 4. Run the stack

### 4a. Full local stack (API + web + worker + Postgres 18 + MinIO)

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

> **Stale local DB → `/api/session` 500s.** A **brand-new** docker-compose
> stack is already correct: the schema is applied from `docker/postgres/init/*.sql`
> on first boot, which now includes the rebaselined lineage (migrations `007`
> `first_run_completed_at`, `009` work-item domain/platform grants, `010` debug-bundle
> lane). But if you have an **existing** local volume from before the rebaseline, it
> will be missing those columns/tables and you will see symptoms like:
>
> - `GET /api/session` returns `500` with `column "first_run_completed_at" does not exist`
> - the in-app issue / capture routes (`app_issue`) return `500` or `403`
>
> Fix it by rebuilding to the current lineage — either wipe the compose volume
> (simplest for the local docker stack):
>
> ```bash
> docker compose down -v && docker compose up --build
> ```
>
> …or, for a persistent **dev**-tier DB (not the throwaway compose volume), run the
> guarded reset (it drops + re-applies `docker/postgres/init/*.sql`; it refuses any
> URL whose db name is not `sitelayer_dev`):
>
> ```bash
> DATABASE_URL=postgres://.../sitelayer_dev RESET_DEV_DB_CONFIRM=1 scripts/reset-dev-db.sh
> ```

### 4b. Host-process loop (run services on the host, DB in Docker)

If you want hot-reload without rebuilding the api/web/worker images:

```bash
docker compose up -d db minio minio-init
npm run dev    # runs dev:api + dev:web + dev:worker concurrently against the dockerized DB
```

Do not use `VITE_FIXTURES=1 npm run dev:web` as the collaborator default. The
old fixture-mode docs drifted ahead of the implementation; use Docker when you
need to see the app in Chrome.

---

## 5. Sign in (Clerk-or-RoleSwitcher)

The repo ships a structurally-prod-safe dev auth bypass so you don't need Clerk creds to exercise RBAC paths.

**Default (no Clerk creds):** Leave `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_JWT_KEY` empty. On boot, a `<RoleSwitcher />` panel renders bottom-right of the SPA. Tap a role — `e2e-admin`, `e2e-foreman`, `e2e-office`, `e2e-member`, or `e2e-bookkeeper` — and the SPA sends `x-sitelayer-act-as: e2e-<role>` on every API call. The API honors the header **only when `APP_TIER !== 'prod'`**.

**With Clerk (preview-tier credentials, optional):** Set `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` (preview key is documented in `.env.example`) and the SPA mounts the real `/sign-in` and `/sign-up` Clerk components. If you need the API to resolve the real Clerk user id, set the matching `CLERK_JWT_KEY` too. If `CLERK_JWT_KEY` is left empty, the API cannot verify the Clerk bearer token and will use the local header/default fallback path instead; that is fine for UI sign-in smoke tests, but it is not a real Clerk-authenticated API session.

For RoleSwitcher, company resolution is still normal Sitelayer tenancy: the user id in `x-sitelayer-act-as` must have a `company_memberships` row for the active company slug. Use the seeded `e2e-fixtures` tenant for the canned `e2e-*` roles, or create your own company/row as below.

---

## 5a. Report an issue from inside the app (capture dock)

Sitelayer ships an in-app capture dock (`apps/web/src/components/capture/AuthenticatedFeedbackDock.tsx`) that records a "Report issue" / "Record feedback" episode — typed note, route + build context, registered page artifacts, optional DOM replay / screen video — and finalizes it into a **support packet** + **work item** you can read back end to end. It is the surface a collaborator uses to file a reproducible bug.

### Enable the dock

The dock is **off by default**. Turn it on with any one of:

- **URL flag** (per tab, no persistence): append `?capture_feedback=1` to any in-app URL.
- **localStorage** (sticky for the browser): in DevTools,
  ```js
  localStorage.setItem('sitelayer.auth-feedback-enabled', 'true')
  location.reload()
  ```
  (`'1'`, `'true'`, `'yes'`, and `'on'` are all accepted.)
- **Build-time env**: `VITE_AUTH_CAPTURE_FEEDBACK=1` (operator/CI builds only — not needed locally).

Once enabled, a pill appears bottom-right; in Steve collab mode it is labelled **Report issue**.

### The one-link collaborator path (Steve mode)

The collaborator entry route `/collab/steve` (`apps/web/src/screens/collab/SteveCollabEntry.tsx`) does the enablement for you: it pins a dev actor + company, sets collab mode, and **writes `sitelayer.auth-feedback-enabled = 'true'` automatically**, then redirects to the target route with `?capture_feedback=1` already on the URL. So a collaborator opening `…/collab/steve` gets the dock on with **no DevTools step**. You can target a route with `…/collab/steve?target=/desktop`.

### Local superadmin path — no Clerk/mesh/Taylor creds needed

In production, the `app_issue.*` capabilities (finalize / read / download a software-issue support packet) require a verified Clerk superadmin session. **In non-prod (`APP_TIER !== 'prod'`), the dev RoleSwitcher identity satisfies `app_issue.*`** (a tier-gated relaxation), so a collaborator running the local stack can finalize an issue, read the support packet, and download the artifact **without any Clerk login, mesh access, or operator credentials**. Nothing here is reachable in prod — the relaxation is gated on the tier, the same way the RoleSwitcher header itself is.

### End-to-end local test

With the full local stack up (Section 4a) on a **fresh** DB (see the stale-DB note in Section 4a if `/api/session` 500s):

1. `docker compose up --build` (fresh compose volume) → `npm run dev` for hot reload, or just use the compose web at `http://localhost:3000`.
2. Open `http://localhost:3000/collab/steve` (auto-enables the dock) **or** any route with `?capture_feedback=1` and pick a role in the RoleSwitcher.
3. Click **Reproduce a bug**, then **drive a real workflow transition** in the app (e.g. approve a rental billing run). Each committed transition stamps a `workflow.transition` recorder mark carrying the canonical `payload.event_ref` (`workflow_event:<name>:<digest>:<state_version>`) — that is what lets the server resolve deterministic anchors. End & report.
4. The dock shows `Sent · packet <id> · work <id>`.
5. Read it back: `GET /api/support-packets/<id>` returns `{ support_packet, agent_prompt }` — the `agent_prompt` renders the **statechart transition anchors**, the **incident timeline**, and the correlated requests/queue rows.
6. Download the artifact (e.g. the rrweb replay / screen video) through the support-packet access path to confirm the full episode round-trips.

If step 5 shows no anchors, the most common cause is that no real workflow transition was driven during the recording (a typed-only issue has nothing to anchor on), not a missing `event_ref` — the client stamps it on every transition.

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

# Web bundle gzip budget (part of the local gate).
npm run web:bundle-budget

# Full local gate — slow (~5-10 min cold). This is the single verification
# authority (no CI). Run it before pushing; scripts/deploy.sh runs it too.
npm run verify          # = bash scripts/verify-local.sh
# (npm run ci:quality runs the same fast checks without the integration/e2e steps.)

# Playwright E2E — requires the full local stack already up.
npm run test:e2e
```

E2E and the bundle budget run in CI; you can skip them for docs-only or comment-only PRs. Typecheck + test + lint are non-negotiable — ESLint runs with `--max-warnings=0`.

### 7a. Optional: exercise the Phase 3 RLS runtime probe locally

`apps/api/src/routes/rls-phase3-audit.test.ts` has two halves. The static
audit (1 test) runs unconditionally. The runtime probe (4 tests) connects
as a non-`BYPASSRLS` role to prove RLS policies actually scope rows; it
skips cleanly when `CONSTRAINED_DB_URL` is unset.

The `sitelayer_constrained` role is provisioned automatically by
migration `087_constrained_role_for_rls_probe.sql` in local Docker and CI.
Preview deployments skip that migration because the managed preview database
app role cannot create roles, and the preview app does not need the runtime
probe login role. Once your local stack is up, the runtime probe can be
exercised with:

```bash
CONSTRAINED_DB_URL=postgres://sitelayer_constrained:sitelayer_constrained@localhost:5432/sitelayer \
  npm run test --workspace @sitelayer/api -- src/routes/rls-phase3-audit.test.ts
```

You can also export `CONSTRAINED_DB_URL` in your shell profile or local
`.env.test` so the probe runs whenever you `npm run test`. The role is
intentionally never created against the prod database (the migration's
DO block checks `current_database() ~ '^sitelayer_prod'`), so this
credential is not a leak risk if it ends up in a developer shell history.

CI wires the same variable into the `test-integration` job; if you see
the probe go red in CI but green locally, the difference is almost
always a missed `withCompanyClient` / `withMutationTx` on a freshly
added route — see `docs/SECURITY_RLS.md` for the audit's per-route
heuristics.

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

# 5. Push and open a PR against main. Use the PR template
#    (.github/PULL_REQUEST_TEMPLATE.md); fill in migration notes if you touched
#    docker/postgres/init/.
git push -u origin HEAD

# Optional if gh is installed; otherwise open the PR in GitHub's web UI.
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

Sitelayer's offline-first design resolves replay conflicts on `takeoff_measurements` via **last-write-wins (LWW)** plus a diagnostic toast. Other entities, including estimate-line flows, may rely on optimistic version checks instead. None of this is a collaborative merge UI. Procedural rule for collaborators:

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

# Reset host-only host-process loop (Section 4b) — Ctrl-C the `npm run dev`,
# then docker compose stop db minio if you want the DB down too.
```

Common gotchas:

- Port 3000 busy → Vite picks the next free port and prints the URL.
- Port 5432 busy → host Postgres is running; either stop it or change the compose port mapping for `db`.
- `tier mismatch on boot` from the API → your `.env` has `APP_TIER=dev` or `prod` while `DATABASE_URL` points at a local DB. Reset `APP_TIER=local`.
- Stale `node_modules` after dependency churn → `rm -rf node_modules apps/*/node_modules packages/*/node_modules && npm install`.

---

## Where to go next

- [`AGENTS.md`](../AGENTS.md) — short guide for agent-authored changes.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — PR checklist, test conventions, where new code goes.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) and [`docs/adr/`](./adr/) — durable design.
- [`docs/RUNBOOK_INDEX.md`](./RUNBOOK_INDEX.md) — production incident runbooks (read once; not needed for first PR).
