# Contributing to Sitelayer

This file is the human entry point. It links the first-30-minute collaborator
path and summarizes code conventions. Operator-only deployment and private
infrastructure notes are intentionally not prerequisites for a first PR.

## Quick start

Where to read what:

- [`README.md`](./README.md) — architecture at a glance, where new code goes.
- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — first-30-minutes setup, Docker stack, app routes.
- [`docs/ONBOARDING_DEVELOPER.md`](./docs/ONBOARDING_DEVELOPER.md) — new-collaborator path: Mac prerequisites, env scaffold, sign-in via RoleSwitcher or Clerk, first PR workflow.
- [`AGENTS.md`](./AGENTS.md) — short version of the rules for any agent or new contributor.
- [`SKILL.md`](./SKILL.md) — engineering skill: how to debug, implement, test, scope.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), [`docs/DETERMINISTIC_WORKFLOWS.md`](./docs/DETERMINISTIC_WORKFLOWS.md), [`docs/adr/`](./docs/adr/) — durable design.
- [`docs/RUNBOOK_INDEX.md`](./docs/RUNBOOK_INDEX.md) — production incident runbooks.

Local dev:

```bash
npm install
cat > .env <<'EOF'
APP_TIER=local
VITE_CLERK_PUBLISHABLE_KEY=
CLERK_JWT_KEY=
EOF
docker compose up --build              # web, API, worker, Postgres, MinIO
```

Leave Clerk variables empty for the default local RoleSwitcher. Use your own
Claude, Codex, ChatGPT, Gemini, or other AI subscriptions from your local
browser/CLI profile; provider tokens and private infrastructure are not repo
setup inputs.

## Architectural patterns

There is **one web app** at `apps/web/`. The old parallel frontend track was removed (ADR 0003). All new screens go under `apps/web/src/`.

State management has fixed homes:

- **Long-lived UI orchestration** → XState machines under `apps/web/src/machines/`. Use one when state has multiple modes (idle / loading / error / submitting) and survives across mounts.
- **Data fetching + caching** → TanStack Query under `apps/web/src/lib/api/`. Resource-shaped hooks (`useProjects`, `useEstimatePush`, etc.).
- **Backend workflows** → deterministic temporal.io-style reducers in `packages/workflows/`. Pure transition function, state version, headless UI. See [`docs/DETERMINISTIC_WORKFLOWS.md`](./docs/DETERMINISTIC_WORKFLOWS.md).
- **Single HTTP client** → `apps/web/src/lib/api/client.ts:request<T>()`. Never invent a parallel fetcher. `api-v1-compat.ts` is closed for new exports — it delegates to `request<T>()` for legacy XState machines.

Mutations cross-system through the **outbox**: API writes to `mutation_outbox` (with a stable idempotency key), worker drains it, external pushes (QBO, notifications, Spaces GC) come back through reducer events. Never call QBO or another external system from a request handler.

Where new code goes:

- New screen → `apps/web/src/screens/mobile/<name>.tsx`.
- New primitive → `apps/web/src/components/m/` (lowercase).
- New durable UI machine → `apps/web/src/machines/<name>.ts`.
- New backend workflow → `packages/workflows/<name>.ts`.
- New API route → `apps/api/src/routes/<name>.ts`.

## Code conventions

- **TypeScript strict.** No `any`. The CI typecheck step (`npm run typecheck`) runs `tsc --noEmit` across every workspace and fails the PR on a single error.
- **Conventional commits.** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`. Squash-and-merge means the PR title becomes the commit message — keep it under 70 characters.
- **Prettier + ESLint enforced.** Both run in CI. Use `npm run format:write` before pushing. ESLint runs with `--max-warnings=0` — warnings fail.
- **Migrations are immutable.** Already-committed `docker/postgres/init/*.sql` files are checksummed in `schema_migrations`. Schema corrections always land as a new file with the next sequential prefix.
- **No Phase-N placeholders in new code.** If something is deferred, link an issue.
- **Don't reinvent primitives.** `apps/web/src/components/m/` already has Button, Avatar, Banner, Kpi, etc. Extend, don't recreate.

## PR checklist

Before requesting review, check that:

- [ ] `npx tsc --noEmit` passes for every touched workspace.
- [ ] `npm run test` passes for every touched workspace.
- [ ] `npm run lint` is clean.
- [ ] `prettier --check` is clean (or run `npm run format:write`).
- [ ] No `docker/postgres/init/*.sql` file edited in place — only new files added.
- [ ] No new direct calls to QBO, Clerk, or Spaces from request handlers — go through the outbox.
- [ ] No `useState` + `useEffect` for multi-mode long-lived state — use an XState machine.
- [ ] PR body uses the template at `.github/PULL_REQUEST_TEMPLATE.md`. Migration notes filled in if schema changed. Breaking changes section filled in if any external contract moved.

Open the PR against `main`. Do not push directly to `main` — see [`AGENTS.md`](./AGENTS.md) "Operating posture".

## Test conventions

- **Vitest, collocated.** Tests live next to the file under test (`foo.ts` + `foo.test.ts`). Run with `npm run test --workspace @sitelayer/<app>`.
- **Property tests for workflows.** Reducers in `packages/workflows/` are pure; cover every transition with a unit test, and use property-style invariants where the state space is small enough (see `packages/workflows/src/rental-billing.test.ts` for the pattern).
- **API tests are integration-style.** They spin up a real handler and exercise the full route. See `apps/api/src/qbo-material-bill-sync.test.ts` for the localhost-mock pattern used to cover external calls.
- **E2E for cross-system flows.** Playwright tests under `e2e/` exercise web → API → worker → DB. Run locally with `npm run test:e2e`. They are not gated on every PR but they do run nightly.

When you fix a bug, add a regression test at the real seam — usually a route test or a reducer test, not a deep unit test of an internal helper. See [`SKILL.md`](./SKILL.md) "Debugging".

## Coordination on shared dev tenants

`takeoff_measurements` is the only path currently wired through the **last-write-wins** offline replay check. Other shared draft/estimate flows may use optimistic version checks instead, but none of these are a multi-user merge UI. The diagnostic toast only fires on the offline replay path; two collaborators editing the same live surface can still lose time or hit conflicts.

Procedural v1 rule (no merge UI today):

- Don't edit takeoff drafts, blueprint measurements, or estimate lines on a shared dev/preview tenant unless explicitly assigned that work.
- For PR work that exercises the takeoff/measurement path, use your own seeded company rather than the shared `la-operations` template — see [`docs/ONBOARDING_DEVELOPER.md`](./docs/ONBOARDING_DEVELOPER.md) §6b.
- Coordinate in the working channel before opening a shared draft (e.g. reproducing a customer report).

This is a coordination guideline, not an architecture project. A merge UI or CRDT proposal needs an issue + ADR.

## Where to file questions

- **Bug in the repo or production** → open an issue with the bug template (`.github/ISSUE_TEMPLATE/bug.md`). Include the `x-request-id` trace ID — see [`docs/SUPPORT_DEBUG_PACKETS.md`](./docs/SUPPORT_DEBUG_PACKETS.md).
- **New capability or workflow change** → open an issue with the feature template (`.github/ISSUE_TEMPLATE/feature.md`). State the user outcome, not the proposed implementation.
- **Security vulnerability** → do **not** open a public issue. See [`SECURITY.md`](./SECURITY.md).
- **Production incident** → start at [`docs/RUNBOOK_INDEX.md`](./docs/RUNBOOK_INDEX.md) and [`docs/INCIDENT_RESPONSE.md`](./docs/INCIDENT_RESPONSE.md). Fill out [`docs/POSTMORTEM_TEMPLATE.md`](./docs/POSTMORTEM_TEMPLATE.md) after.
- **Architectural question that outlives a PR** → write an ADR under `docs/adr/`. The most recent ADR is the truth.
