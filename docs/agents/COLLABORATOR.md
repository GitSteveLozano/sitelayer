# Collaborator-Agent Guide (Steve's Mac)

You are an AI coding agent running on a **collaborator's** machine — not the
operator's (Taylor's) workstation. This is the self-contained guide for
understanding Sitelayer, running and testing it locally, exercising the
capture/issue flow, and contributing a PR, using **only** what is on this
machine.

If you came here from `AGENTS.md` or `CLAUDE.md`: read this file first, then
those for depth.

---

## (a) What you have

- The **GitHub** clone of this repo. Origin is
  `git@github.com:GitSteveLozano/sitelayer.git`. `main` is production truth;
  `dev` is the persistent dev branch.
- **git, Node, npm, Docker** on the host.
- **Your own** AI subscriptions / coding-agent harness (the agent you are).
- The full checked-in source: every app, package, migration, script, and the
  docs under `docs/`.

That is enough to run the entire stack locally (web + API + worker + Postgres +
object storage), exercise the real capture/issue flow end to end, and open a PR.

---

## (b) What you do NOT have — and must not recreate

You do **not** have, and do **not** need, any of the operator's private
infrastructure:

- **Mesh / control-plane / any MCP tooling** (`mcp__mesh__*`, the orchestrated
  task queue, `discover_tools`, etc.).
- **browser-bridge** (the operator's remote-tab automation).
- **Tailscale / the Tailnet** (so `MESH_API_URL` and anything on `*-hetzner`
  is unreachable from here).
- **Bitbucket** (Sitelayer is on GitHub; only some other operator repos are on
  Bitbucket).
- **The operator's credentials**, DigitalOcean / production access, the
  prod/preview droplets, SSH into the fleet, or the fleet boxes themselves.

**If you hit a blocker that genuinely needs one of these, STOP and ask the
operator. Do NOT try to recreate the operator's setup** (do not stand up mesh,
do not request prod creds, do not configure Tailscale, do not point env at
`*-hetzner` hosts). The whole local path is designed to work without them — if
something seems to require them, you have probably wandered off the collaborator
path. The `Collaborator Workstation Override` blocks at the top of
[`AGENTS.md`](../../AGENTS.md) and [`CLAUDE.md`](../../CLAUDE.md) say the same
thing.

---

## (c) Architecture overview

Sitelayer is a construction-operations platform (blueprint takeoff, estimation,
crew scheduling, QBO sync). npm-workspaces monorepo.

- **One web app: `apps/web/`** — a React 19 + Vite SPA, client-side only (no
  SSR). Long-lived UI orchestration lives in **XState machines** under
  `apps/web/src/machines/` (e.g. `project-lifecycle.ts`, `estimate-push.ts`).
  Data fetching/caching is **TanStack Query** under `apps/web/src/lib/api/`,
  with a single HTTP client `apps/web/src/lib/api/client.ts:request<T>()`.
- **API: `apps/api/`** — a plain Node.js `http` server (`apps/api/src/server.ts`,
  no framework). `server.ts` owns HTTP + auth + middleware only; the route table
  is `apps/api/src/routes/dispatch.ts`, which fans out to the per-feature handler
  modules in `apps/api/src/routes/` (~150 endpoints). Direct parameterized
  `pg` SQL — no ORM.
- **Worker: `apps/worker/`** — drains the Postgres-backed leased queue
  (`mutation_outbox`, `sync_events`) via `@sitelayer/queue`. All external pushes
  (QBO, notifications) go through the outbox, never from a request handler.
- **Backend workflows: `packages/workflows/`** — deterministic state machines
  (pure reducer + `state_version` + headless UI). See
  [`docs/DETERMINISTIC_WORKFLOWS.md`](../DETERMINISTIC_WORKFLOWS.md).
- **Database: Postgres** with the **immutable forward-only SQL migrations** in
  `docker/postgres/init/*.sql` — that directory is the schema source of truth.
  RLS (row-level security) scopes rows by company.

For more depth, read (in this order):
[`AGENTS.md`](../../AGENTS.md) → [`CLAUDE.md`](../../CLAUDE.md) →
[`docs/DETERMINISTIC_WORKFLOWS.md`](../DETERMINISTIC_WORKFLOWS.md). The
new-collaborator setup walkthrough is
[`docs/ONBOARDING_DEVELOPER.md`](../ONBOARDING_DEVELOPER.md) and
[`DEVELOPMENT.md`](../../DEVELOPMENT.md).

---

## (d) Local dev loop (verified commands)

The collaborator default is the **Docker-backed full stack** (web + API +
worker + Postgres 18 + MinIO). The compose file runs the apps _inside_
containers, so `docker compose up` is itself the dev loop — you do not have to
run `npm run dev` separately.

**1. Create a minimal `.env`** so the SPA renders the dev RoleSwitcher instead
of mounting Clerk. Do **not** copy `.env.example` blindly — it carries a preview
Clerk publishable key that suppresses the RoleSwitcher.

```bash
npm install
cat > .env <<'EOF'
APP_TIER=local
VITE_CLERK_PUBLISHABLE_KEY=
CLERK_JWT_KEY=
EOF
```

**2. Bring up the stack:**

```bash
docker compose up --build
# First boot ~3-5 min while images pull and migrations apply.
open http://localhost:3000
```

This gives you:

- Web SPA at `http://localhost:3000`
- API at `http://localhost:3001` (health `GET /health`, version `GET /api/version`)
- Worker draining `mutation_outbox` / `sync_events`
- Postgres 18 at `localhost:5432` (`sitelayer/sitelayer`), schema applied from
  `docker/postgres/init/*.sql` on first boot
- MinIO (S3-compatible) at `localhost:9000`, console `localhost:9001`
  (`sitelayerlocal/sitelayerlocal`), bucket `sitelayer-blueprints-local`
  auto-created

If you have an old volume from before the Postgres-18 / migration rebaseline and
see `GET /api/session` 500s or `app_issue` routes returning 500/403, wipe and
rebuild:

```bash
docker compose down -v && docker compose up --build
```

**Optional host-process loop** (hot reload without rebuilding the app images):

```bash
docker compose up -d db minio minio-init
npm run dev    # = dev:api + dev:web + dev:worker concurrently against the dockerized DB
```

**Dev auth bypass (RoleSwitcher).** When `VITE_CLERK_PUBLISHABLE_KEY` is empty
and the build is not production, a `<RoleSwitcher />` panel renders bottom-right
of the SPA (`apps/web/src/components/dev/RoleSwitcher.tsx`). Tap a role and the
SPA sends `x-sitelayer-act-as: e2e-<role>` on every API call; the API
(`apps/api/src/auth.ts:resolveActAsOverride`) honors that header **only when
`APP_TIER !== 'prod'`**. The five canned ids are `e2e-admin`, `e2e-foreman`,
`e2e-office`, `e2e-member`, `e2e-bookkeeper`.

**Seeded memberships.** Company resolution is normal Sitelayer tenancy — the
act-as user id must have a `company_memberships` row for the active company
slug. The compose DB seeds two tenants from the baseline schema in
`docker/postgres/init/` (`000_baseline.sql`): `la-operations` (default;
`demo-user` is admin) and `e2e-fixtures` (one `company_memberships` row per
`e2e-*` role). To use the canned roles, set the active company to
`e2e-fixtures`:

```js
// DevTools console on the SPA:
localStorage.setItem('sitelayer.active-company-slug', 'e2e-fixtures')
location.reload()
```

You can also re-run the seed explicitly (it is `npm run seed:e2e` →
`tsx apps/api/scripts/seed-e2e-fixtures.ts`):

```bash
DATABASE_URL=postgres://sitelayer:sitelayer@localhost:5432/sitelayer npm run seed:e2e
```

Or create your own company through the SPA "Create company" form
(`POST /api/companies`), or via `scripts/onboard-company.ts`. Full detail:
[`docs/ONBOARDING_DEVELOPER.md`](../ONBOARDING_DEVELOPER.md) §6.

---

## (e) The capture / ISSUE flow + the two-domain capability model

Sitelayer ships an in-app **capture dock**
(`apps/web/src/components/capture/AuthenticatedFeedbackDock.tsx`) that records a
"Report issue" / "Reproduce a bug" episode (typed note + route/build context +
registered page artifacts + optional DOM replay / screen video) and finalizes it
into a **support packet** + **work item** you can read back end to end. This is
the surface a collaborator uses to file a reproducible bug.

### The two-domain capability model

Sitelayer separates two trust boundaries (`apps/api/src/capability.ts`,
`packages/domain/src/capabilities.ts`, migration `009`):

- **`field_request.*`** — the **company** boundary. Resolved from the caller's
  company role (the RoleSwitcher identity gives you a real company role). Field
  problems flagged from the job site live here.
- **`app_issue.*`** — the **platform** boundary (capture / view / download a
  software-issue support packet). **In production this requires a verified Clerk
  superadmin session** and is unreachable via a company role or the act-as
  header.

**Local-dev relaxation (the part that matters for you).** In any non-prod tier
(`APP_TIER !== 'prod'`, which is your local stack), the dev RoleSwitcher identity
is treated as platform-admin for `app_issue.*`
(`capability.ts:isLocalDevPlatformBypass`). So a collaborator running the local
stack **can finalize an issue, read its support packet, and download the
artifact with no Clerk login, no mesh, and no operator credentials.** This is
gated on the tier exactly like the RoleSwitcher header itself — it is
structurally impossible in prod.

### How to submit an issue locally

1. Stack up (section d) on a fresh DB. Pick a RoleSwitcher role.
2. Enable the dock with **either**:
   - append `?capture_feedback=1` to any in-app URL (per tab), **or**
   - open `http://localhost:3000/collab/steve` — the collaborator entry route
     (`apps/web/src/screens/collab/SteveCollabEntry.tsx`) pins a dev actor +
     company, sets collab mode, sets the feedback-enabled localStorage flag, and
     redirects to the target with `?capture_feedback=1` already on the URL (no
     DevTools step). Target a route with `…/collab/steve?target=/desktop`.
3. Click **Reproduce a bug**, drive a real workflow transition in the app (e.g.
   approve a rental billing run — each committed transition stamps a
   `workflow.transition` mark the server uses to resolve deterministic anchors),
   then **End & report**. The dock shows `Sent · packet <id> · work <id>`.

### How to read it back

```bash
curl http://localhost:3001/api/support-packets/<id>
```

`GET /api/support-packets/:id` returns `{ support_packet, agent_prompt }`
(`apps/api/src/routes/support-packets.ts`). The `agent_prompt` renders the
**statechart transition anchors**, the **incident timeline** (in-window events
leading up to the report), and the correlated request-ids / queue rows. This
read requires `app_issue.view` — satisfied locally by the dev relaxation above.

Download the captured artifact (e.g. rrweb replay / screen video) to confirm the
full episode round-trips:

```text
GET /api/capture-sessions/:id/artifacts/:artifactId/file
```

(also `app_issue.view`-gated). If the agent prompt shows no anchors, the usual
cause is that no real workflow transition was driven during the recording (a
typed-only issue has nothing to anchor on). Deeper detail:
[`docs/SUPPORT_DEBUG_PACKETS.md`](../SUPPORT_DEBUG_PACKETS.md),
[`docs/STEVE_FEEDBACK_CAPTURE_WORKFLOW.md`](../STEVE_FEEDBACK_CAPTURE_WORKFLOW.md),
and [`docs/ONBOARDING_DEVELOPER.md`](../ONBOARDING_DEVELOPER.md) §5a.

---

## (f) The verification GATE

There is **no CI / no GitHub Actions** in this repo (`.github/workflows/` does
not exist — the deploy and quality workflows were removed in 2026-06). The
**single verification authority** is `scripts/verify-local.sh`, exposed as:

```bash
npm run verify        # = bash scripts/verify-local.sh
                      # "standard" level: shell-syntax, lint, prettier --check,
                      # typecheck, unit tests, build, web bundle budget,
                      # dockerfile-import guard, + the docker-compose DB-backed
                      # integration suite. This is the merge/deploy gate.
npm run verify:fast   # static + build + unit only (quick iteration)
npm run verify:full   # standard + Playwright e2e (resource-heavy; quiet box only)
```

The integration suite stands up an isolated docker-compose Postgres, so Docker
must be running for `npm run verify` (use `npm run verify:fast` if you only need
static + unit). Faster sub-checks:

```bash
npm run typecheck     # tsc --noEmit across all workspaces (+ e2e)
npm run lint          # eslint . --max-warnings=0  (warnings fail)
npm run format        # prettier --check
npm run test          # vitest across workspaces
npm run web:bundle-budget
```

**Land-time gate: the pre-push hook.** Install it once per clone (it is
repo-tracked at `.githooks/pre-push`); `npm install` runs the installer
automatically via the `prepare` script, but you can run it explicitly:

```bash
npm run hooks:install   # = bash scripts/install-git-hooks.sh
```

Pushing to `dev`/`main` then runs the standard `npm run verify` gate and blocks
on failure (emergency bypass: `git push --no-verify`). Details:
[`docs/RELEASE_GATES.md`](../RELEASE_GATES.md).

**Migration immutability rule.** A SQL file in `docker/postgres/init/` is
**immutable once it lands on `main`** — it is checksummed in `schema_migrations`
and editing an applied file fails the next deploy.
`scripts/check-migrations-immutable.sh` (part of the gate) compares against
`origin/main`'s merge-base, so a brand-new file you add on your branch is still
mutable until it merges. One feature → one migration file; edit it in place
until it lands rather than stacking add/drop/re-add files.

---

## (g) Contribute via PR to GitHub

```bash
# 1. Branch off main (or off the branch you were asked to work on).
#    Convention: agent/<your-handle>/<topic> for agent-driven work.
git checkout -b agent/steve/<topic> origin/main

# 2. Make a small, focused change. Don't widen scope.

# 3. Run the gate locally before pushing.
npm run format:write   # auto-fix prettier
npm run verify         # the full local gate (or verify:fast for static+unit)

# 4. Conventional-commit. Squash-and-merge means the PR title becomes the
#    final commit message — keep it under 70 chars.
git commit -am "fix: <what changed>"

# 5. Push (the pre-push hook re-runs the gate) and open a PR against main.
git push origin agent/steve/<topic>
```

**Never push directly to `main`** — open a PR. Fill in the PR template
(`.github/PULL_REQUEST_TEMPLATE.md`), including migration notes if you touched
`docker/postgres/init/`. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and the
"Operating posture" section of [`AGENTS.md`](../../AGENTS.md). You **cannot**
deploy — the operator deploys from the fleet (section h).

---

## (h) What you CANNOT do + the LOCAL SUBSTITUTE

| You cannot...                              | Why                                                                                                 | Local substitute                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy to prod (`scripts/deploy.sh prod`)  | Fleet-only; needs the DO registry, the prod droplet, `DEPLOY_HOST` / `DEPLOY_SSH_KEY` (root-equiv). | Verify locally (`npm run verify`) and open a PR. The operator deploys from the fleet. Do **not** run `scripts/deploy.sh` or set `DEPLOY_*`.        |
| Use mesh dispatch / the mesh task queue    | Operator-internal; needs mesh MCP tooling you don't have.                                           | File a **GitHub issue** instead (`docs/agents/issue-tracker.md`). The operator promotes it to a Mesh task if warranted.                            |
| Use the in-app AI chat path                | Its only response path hands off to the operator's private mesh (`MESH_API_URL`), Tailnet-only.     | Leave `MESH_API_URL` **EMPTY**. With it empty the chat feature-flags OFF cleanly (`/api/ai/chat` → `200 {"status":"disabled"}`), no error noise.   |
| Run browser-bridge testing                 | Operator's remote-tab automation; not on this machine.                                              | Local Playwright `npm run test:e2e` (configs in `e2e/`), or just drive `http://localhost:3000` in your own browser.                                |
| Get Sentry / Axiom log enrichment          | Needs the operator's Sentry org + Axiom warehouse.                                                  | Leave `SENTRY_DSN` / `VITE_SENTRY_DSN` / `AXIOM_TOKEN` / `AXIOM_DATASET` **EMPTY**; rely on the Pino console logs and `GET /api/debug/traces/:id`. |
| Use DO Spaces object storage               | Prod bucket + scoped key are operator-only.                                                         | The local **MinIO** in `docker-compose.yml` (bucket `sitelayer-blueprints-local`, auto-created). The compose stack already points storage at it.   |
| Touch the prod DB / `DATABASE_URL_PROD_RO` | Production data; the `read-prod-ro` flag needs a real read-only prod pool you don't have.           | The local docker Postgres (`docker/postgres/init`). Leave `DATABASE_URL_PROD_RO` **EMPTY**; never request prod DB access.                          |
| Hit live QuickBooks Online                 | Live QBO needs the operator's Intuit prod realm + tokens.                                           | `QBO_ENVIRONMENT=sandbox` only (the worker stubs QBO pushes unless a `QBO_LIVE_*` flag is set, which you should not set).                          |

**Leave the operator-only env vars EMPTY.** Setting `MESH_API_URL`,
`SENTRY_DSN`, `AXIOM_TOKEN`/`AXIOM_DATASET`, `DATABASE_URL_PROD_RO`, QBO prod
realm creds, or `DEPLOY_HOST`/`DEPLOY_SSH_KEY` on this machine does not give you
any capability — it will either 503 / fail to connect (their hosts are
Tailnet-only or production) or, worse, **mislead the logs** so your debugging
chases a non-existent backend. Empty is the correct, working value for the
collaborator path.
