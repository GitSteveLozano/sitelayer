# `apps/web/` — RETIRED

This directory is the **previous** Sitelayer web client (v1). Production traffic was cut over to [`apps/web-v2/`](../web-v2/) in [PR #139](https://github.com/GitSteveLozano/sitelayer/pull/139) (commit `e3d4007`, 2026-05-01).

**Do not add features here.** Nothing in this tree ships to production:

- `Dockerfile` only copies `apps/web-v2/dist` into the runtime image.
- `docker-compose.prod.yml` runs `npm start -w @sitelayer/web-v2`.
- `docker-compose.yml` (local dev) runs `npm run dev:web-v2`.
- `docker-compose.preview.yml` (PR previews) runs `npm run dev:web-v2`.
- `.github/workflows/deploy-pages.yml` builds `@sitelayer/web-v2`.

## Why is it still in the tree, then?

ADR 0002 (`docs/adr/0002-web-v2-rebuild.md`) cutover criterion #6:

> Rollback path verified: reverse-proxy can route any subset of users back to `apps/web/` for one release window after cutover.

v1 stays until that release window closes and the v2 cutover is confirmed stable. Retiring the directory is a follow-up — see the v2 retirement issue.

## What you can do here

- Bug fixes that the rollback path needs (rare; v1 was stable before cutover).
- Dep bumps Dependabot opens (kept on a low PR cap — see `.github/dependabot.yml`).

## What you should not do here

- Add new screens or routes.
- Backport features from `apps/web-v2/`.
- Reference v1 components from `apps/web-v2/` source.
- Read v1 patterns and apply them to v2 — the design system, IA, and PWA shell are different on purpose (see ADR 0002).

If you're an agent and you ended up reading code in this directory, stop and read [`/AGENTS.md`](../../AGENTS.md) at the repo root.
