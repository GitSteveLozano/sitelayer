# Security Policy

## Reporting a vulnerability

Email **taylor@releaserent.com** with the subject line `sitelayer security:` followed by a short description. Do not open a public GitHub issue and do not post in any chat that includes parties outside the maintainer set.

Include, where possible:

- The affected endpoint, screen, or workflow.
- A minimal reproduction (curl invocation, screenshot, or video).
- The tier you reproduced on (`local`, `dev`, `preview`, `prod`).
- An `x-request-id` or Sentry trace ID if one was available.

## Scope

In scope:

- `apps/api`, `apps/web`, `apps/worker`.
- The deployment surface under `docker/`, `ops/`, and `.github/workflows/`.
- QBO, Clerk, and DigitalOcean Spaces integrations as wired in this repo.
- Production endpoints at `sitelayer.sandolab.xyz` and preview endpoints at `*.preview.sitelayer.sandolab.xyz`.

Out of scope:

- Issues in third-party services themselves (Clerk, Intuit, DigitalOcean) — report those upstream.
- Findings that require an attacker to already have valid `admin` or `owner` company role.
- Denial-of-service via brute traffic against unauthenticated endpoints (rate limiting is intentional, not exhaustive).
- Reports generated solely by automated scanners without a working proof of concept.

## Response SLA

- **Acknowledgement:** within 24 hours.
- **Initial assessment + severity classification:** within 3 business days.
- **Patch timeline:** critical issues are patched and deployed within 7 days; high-severity within 30 days; medium/low on the next regular release.

You will receive at least one update per week until the issue is resolved. Production deploys run from the fleet via `scripts/deploy.sh prod` (the GitHub Actions deploy workflows were removed 2026-06-01) — see [`CLAUDE.md`](./CLAUDE.md) "Deploy procedure".

## Credit

Reporters are credited in the patch commit message and in the postmortem (see [`docs/POSTMORTEM_TEMPLATE.md`](./docs/POSTMORTEM_TEMPLATE.md)) unless they request anonymity. There is currently no monetary bounty.
