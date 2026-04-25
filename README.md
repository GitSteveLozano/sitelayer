# Sitelayer

Construction operations platform for blueprint takeoff, estimating, crew scheduling, daily confirmation, rentals, and QBO sync.

## Quickstart

```bash
npm ci
npm run dev
```

Local app ports:

- web: `http://localhost:3000`
- api: `http://localhost:3001`
- MinIO API: `http://localhost:9000`
- MinIO console: `http://localhost:9001`

For frontend-only work with fixture data:

```bash
VITE_FIXTURES=1 npm run dev:web
```

For the full local Docker stack:

```bash
docker compose up --build
```

The local stack runs Postgres 18, MinIO bucket `sitelayer-blueprints-local`, API, web, and worker.

## Quality

```bash
npm run ci:quality
```

That mirrors the intended release gate: shell syntax, lint, format, typecheck, tests, full build, web bundle budget, fixture build, and Playwright e2e.

Useful focused checks:

```bash
npm run typecheck
npm run test
npm run build
npm run web:bundle-budget
VITE_FIXTURES=1 npm run build --workspace @sitelayer/web
npm run e2e
```

## Environment

Local env files are loaded from the current directory upward in this order:

1. `.env`
2. `.env.local`
3. `.env.sentry.local`
4. `.env.qbo.local`

Already-exported process env vars win over file values. Use `.env.example` as the scaffold.

## Docs

- `DEVELOPMENT.md` - local development loop and routes.
- `DEPLOYMENT.md` - production deploy, tiers, caching, backups, and operations.
- `docs/RELEASE_GATES.md` - CI/release requirements.
- `docs/PREVIEW_DEPLOYMENTS.md` - preview droplet and PR preview flow.
- `docs/SECRET_ROTATION.md` - credential rotation.
- `docs/DR_RESTORE.md` - disaster recovery.
- `CLAUDE.md` - current architecture and agent coordination source of truth.
