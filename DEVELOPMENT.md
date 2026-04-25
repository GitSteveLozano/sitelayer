# Development

## Fastest UI Loop

Use fixtures when you only need to review frontend work:

```bash
npm install
VITE_FIXTURES=1 npm run dev:web
open http://localhost:3000
```

If port `3000` is busy, Vite prints the next available URL.

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

## App Routes

- `/confirm` - daily schedule confirmation and crew review
- `/clock` - crew clock-in/out and timeline
- `/schedule` - weekly crew schedule grid
- `/projects` - auth shell, company switcher, customers, workers, pricing, bonus rules
- `/takeoffs` and `/takeoffs/:projectId` - project selection, blueprint documents, takeoff board, labor, schedules, material bills
- `/estimates` - selected project summary, estimate lines, analytics
- `/integrations` - QBO connection, queue health, mappings, offline queue
- `/onboarding` - company creation wizard
- `/rentals` - admin/office rental ledger
- `/bonus-sim` - admin bonus simulation
- `/audit` - admin/owner audit trail
- `/dev/*` - non-production scratch space for generated UI

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

For architecture and deployment rules, use `CLAUDE.md`. For release gate details, use `docs/RELEASE_GATES.md`. For first-30-minutes setup, use this file.
