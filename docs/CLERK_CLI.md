# Managing Sitelayer's Clerk with the `clerk` CLI

Sitelayer's auth is Clerk (JWT verified in `apps/api/src/auth.ts`; React provider in
`apps/web/src/App.tsx`). You do **not** need the Clerk dashboard for most operational
tasks — the official **`clerk` CLI** is an agent-agnostic, browser-free gateway to
Clerk's Backend API (users/sessions) and Platform API (apps/instances/config). Any
agent (Claude, Codex, Gemini, …) or human just shells out to the `clerk` binary; this
is deliberately **not** a per-agent "skill".

## Install + auth (one-time per host)

```bash
npm install -g clerk        # or: brew install clerk/stable/clerk
                            # or: curl -fsSL https://clerk.com/install | bash
clerk auth login            # one-time browser OAuth; stores creds locally,
                            # reused headlessly by every process/agent on the host
clerk whoami                # confirm the logged-in account
```

`clerk auth login` is the only browser step, and it's once per machine — after that the
CLI runs unattended. For pure Backend-API calls you can skip login and pass
`clerk api --secret-key <sk_...>` instead.

## Sitelayer's Clerk app + instances

Listed live via `clerk api --platform /platform/applications`:

| Instance              | Env                           | Maps to                           |
| --------------------- | ----------------------------- | --------------------------------- |
| `ins_…` (development) | `pk_test_…clerk.accounts.dev` | local dev / preview               |
| `ins_…` (production)  | `pk_live_…clerk.sandolab.xyz` | **prod `sitelayer.sandolab.xyz`** |

The prod instance's frontend API is `clerk.sandolab.xyz`. Link this checkout to the app
once so commands auto-resolve keys/instance:

```bash
clerk link                  # picks the app; or: clerk link --app <app_id>
clerk whoami                # shows the linked app + instance
```

## Common sitelayer tasks (browser-free)

Discover any endpoint first: `clerk api ls` · `clerk api ls users` · `clerk api ls instance`.

**Pilot user troubleshooting** — Clerk holds the user identity; Sitelayer maps it to a
company role in the `company_memberships` table (`packages/domain/src/roles.ts`). To go
from an email to the `user_id` you then look up in `company_memberships`:

```bash
clerk api '/users?email_address=person@example.com'   # find the Clerk user_id
clerk api /users/{user_id}                             # inspect the user
clerk api /users/count                                 # sanity-check user totals
clerk api -X PATCH /users/{user_id}/metadata -d '{"public_metadata":{"...":"..."}}'
```

Target the prod vs dev instance with `--instance prod` / `--instance dev` (or
`--app <id>`), e.g. `clerk api --instance prod /users/count`.

**Instance config as code** — pull/patch the Clerk instance settings (sign-in methods,
session policy, redirects) without the dashboard:

```bash
clerk config pull                          # snapshot instance config to disk
clerk api --platform /platform/applications/{app_id}/instances/{ins_id}/config
clerk api --platform -X PATCH \
  /platform/applications/{app_id}/instances/{ins_id}/config -d '{ ... }'
```

**Keys into env** — Sitelayer reads `VITE_CLERK_PUBLISHABLE_KEY` (web) and verifies JWTs
with `CLERK_JWT_KEY` (api). Pull the current keys when you need them:

```bash
clerk env pull --instance prod --file .env   # or omit --instance for dev keys
```

> Local-dev note: the dev **RoleSwitcher** auth-bypass (see root `CLAUDE.md` →
> "Local/preview role testing") only renders when `VITE_CLERK_PUBLISHABLE_KEY` is
> **empty**. So for local RBAC testing you usually leave Clerk keys unset; use
> `clerk env pull` when you specifically want to exercise the real Clerk flow.

**Health check:** `clerk doctor` validates the project's Clerk integration.

## What the CLI canNOT do

Rotating/creating/deleting the account-level **Secret Key** (`sk_test_`/`sk_live_`) has
no CLI or API endpoint — it is **dashboard-only** (`clerk open` launches it). Everything
else (users, sessions, instance config, domains, JWT templates, redirect URLs, env keys)
is CLI-addressable.

## Security

`clerk auth login` credentials grant **full account access** to every Clerk app on the
account — treat the host's Clerk creds like production secrets. Never hand Clerk
account creds or a `sk_live_` key to an untrusted agent/host; prefer
`clerk api --secret-key` scoped to a specific instance for narrow tasks.
