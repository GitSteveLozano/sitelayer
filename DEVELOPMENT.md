# Development

## First 30 Minutes

The collaborator default is the Docker-backed stack, not fixture mode. Create a
minimal `.env` so the SPA renders the local RoleSwitcher instead of Clerk:

```bash
npm install
cat > .env <<'EOF'
APP_TIER=local
VITE_CLERK_PUBLISHABLE_KEY=
CLERK_JWT_KEY=
EOF
docker compose up --build
open http://localhost:3000
```

On first boot, use the RoleSwitcher in the bottom-right of the SPA and select
one of the seeded `e2e-*` roles. Keep Clerk, QBO, Sentry, Spaces, and production
credentials empty unless an operator explicitly asks you to test that path.

## Full Local Stack

Use Docker when you need the API, worker, Postgres, and local object storage:

```bash
npm install
docker compose up --build
open http://localhost:3000
```

Seed and migration SQL live under `docker/postgres/init/`. The compose stack sets `APP_TIER=local`, uses local Postgres, and points blueprint storage at local MinIO.

The local database image matches production on Postgres 18. If you have an old local `postgres_data` volume from the previous Postgres 16 stack and do not need to keep that data, reset it before first boot:

```bash
docker compose down -v
docker compose up --build
```

## Optional UI-Only Fixture Loop

Fixture mode is useful for isolated frontend polish when you deliberately do not
need auth, API routes, worker behavior, migrations, or seeded tenancy. It is not
the new-collaborator default.

```bash
VITE_FIXTURES=1 npm run dev:web
open http://localhost:3000
```

If port `3000` is busy, Vite prints the next available URL.

## App Routes

The canonical runtime shell is `apps/web/src/screens/mobile-shell.tsx` (`MobileShell`), mounted at `App.tsx`'s `/*` via `routes/workspace.tsx`. It carries its own inline route table, including the `projects/:projectId/*` and `rentals/*` catchalls. Add a new reachable mobile route inside `mobile-shell.tsx` **before** the catchalls, or mount a full-screen route directly in `App.tsx`/`more.tsx`/`financial.tsx`. The standalone files `routes/{projects,rentals,schedule,home,time,log,crew}.tsx` are legacy/dead — never mounted under the shell (and being removed), so do not add routes there.

Legacy/specialized paths still reachable for orientation (not an exhaustive list — read `mobile-shell.tsx` and `App.tsx` for the live table):

- `/onboarding` - company creation wizard
- `/financial/*` - admin financial hub (full-screen)
- `/projects/:id/*` - full-viewport project deep routes (setup, takeoff, estimate-builder, rental-contract)
- `/portal/*` - public client portal (signed estimate / rentals)
- `/m-preview` - dev-only primitive showcase
- `/m/*` - legacy alias of the mobile shell

## Ribbon Colors

- `LOCAL` / local fixtures: working on your machine only.
- `DEV DATA`: shared development data; not customer data.
- `PREVIEW`: PR or branch preview data; safe for review, not production.
- No ribbon: production.

## Preview Deploys

Open or update a trusted PR and GitHub Actions deploys:

```text
https://pr-<number>.preview.sitelayer.sandolab.xyz
```

Closing the PR runs cleanup automatically. Preview infrastructure details live in `docs/PREVIEW_DEPLOYMENTS.md`.

Each preview uses the shared `sitelayer_preview` database with an isolated schema such as `sitelayer_pr_42`. Deploy creates the schema and cleanup drops it with the stack.

## Common Checks

```bash
npm run typecheck --workspace @sitelayer/web
npm run build --workspace @sitelayer/web
npm run web:bundle-budget
VITE_FIXTURES=1 npm run build --workspace @sitelayer/web
npm run e2e
```

`npm run ci:quality` is the full local mirror of the Quality workflow: shell syntax, lint, format, typecheck, tests, build, web bundle budget, fixture build, and Playwright e2e.

For release gate details, use `docs/RELEASE_GATES.md`. For first-30-minutes setup, use this file and `docs/ONBOARDING_DEVELOPER.md`. Operator-only architecture/deploy notes can wait until after the local stack is working.
