# Sitelayer Collaborator Setup

This is the v1 path for one developer collaborator. It deliberately does not
require mesh-lite, a telemetry ingress, an operator HUD, browser-bridge,
Tailscale, or new auth infrastructure.

## Scope

The collaborator needs:

- GitHub access to this repository.
- A local Mac development environment.
- A user in the existing Sitelayer Clerk instance.
- A `company_memberships` row for the target company.
- A normal branch, PR, and review loop.

## Mac Development Setup

Prerequisites:

- Git and SSH access to the repo.
- Node.js compatible with the repo lockfile.
- Docker Desktop, or another local Docker engine, for the full stack.
- Access to the non-production Sitelayer environment values supplied by the
  operator. Do not use production secrets in local setup.

First run:

```bash
git clone git@github.com:GitSteveLozano/sitelayer.git
cd sitelayer
npm install
```

Fast UI-only loop:

```bash
VITE_FIXTURES=1 npm run dev:web
```

Full local stack:

```bash
docker compose up --build
```

Common checks before opening a PR:

```bash
npm run typecheck
npm run test
npm run lint
```

Use focused workspace checks while iterating:

```bash
npm run typecheck --workspace @sitelayer/web
npm run test --workspace @sitelayer/web
npm run typecheck --workspace @sitelayer/api
npm run test --workspace @sitelayer/api
```

## Existing Auth Flow

Sitelayer already uses Clerk for app authentication. Do not add a new auth
system for a developer collaborator.

Provisioning flow:

1. The collaborator creates or is created as a user in the existing Sitelayer
   Clerk instance for the environment being used.
2. Record their Clerk user id, for example `user_...`.
3. Add them to the target company through `company_memberships`.

Example local/dev SQL:

```sql
insert into company_memberships (company_id, clerk_user_id, role)
select id, '<clerk_user_id>', 'admin'
from companies
where slug = '<company_slug>'
on conflict (company_id, clerk_user_id)
do update set role = excluded.role;
```

Use `admin` for the first developer collaborator unless there is a concrete
reason to narrow the role. Narrow later after the development loop is proven.

## First PR Workflow

The first PR should prove the loop, not solve a large product problem.

1. Create a branch from current `main`.
2. Make a small change: documentation, a minor UI label, or a focused test.
3. Run the relevant focused check and record the result in the PR body.
4. Open a PR against `main`.
5. Operator reviews within the normal Sitelayer review path.
6. Merge only after the branch is green enough for the change size.

## Takeoff Coordination Rule

The current takeoff write path uses last-write-wins conflict handling around
`takeoff_measurements.updated_at` and `If-Unmodified-Since` headers. That is
adequate for single-operator/offline replay, but it is not a collaborative
editing model for two people working on the same blueprint at the same time.

Until a real multi-user takeoff merge model exists:

- Do not have two people edit takeoff measurements on the same blueprint or
  takeoff draft concurrently.
- A developer collaborator should avoid field/takeoff measurement edits unless
  explicitly assigned.
- If takeoff work must be shared, assign one owner per blueprint/draft and
  hand off only after their local changes have synced.
- Treat any 409 conflict or "newer change synced from another device" toast as
  a stop-and-coordinate signal, not as a prompt to retry blindly.

This is a procedural v1 constraint, not a new architecture project.

## Explicit Non-Goals For V1

Do not block collaborator onboarding on:

- mesh-lite or any new telemetry ingress.
- operator HUD work.
- browser-bridge install.
- Tailscale setup.
- new Clerk/auth infrastructure.
- remote Capture POST wiring.

Those can be revisited after the collaborator has made a useful first PR.
