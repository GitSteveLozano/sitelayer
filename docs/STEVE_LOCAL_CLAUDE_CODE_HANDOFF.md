# Steve Local Claude Code Handoff

Date: 2026-06-10

Audience: Steve and any Claude Code/Codex/Gemini agent running on Steve's local
machine.

## Goal

Steve should be able to clone Sitelayer from GitHub, run it locally, use Claude
Code to make focused code changes, push a feature branch back to GitHub, and
hand that branch to Taylor for integration/deploy.

Taylor's workstation/fleet path is the integration and deployment authority for
`dev`, `main`, demo, and production. Steve's machine is a collaborator machine,
not a deploy box.

## First Rule For The Agent

Treat Steve's machine as a collaborator workstation:

- Do not require Mesh, control-plane, browser-bridge, Tailscale, Bitbucket,
  DigitalOcean, production database access, Clerk dashboard access, Sentry,
  Axiom, QBO production credentials, or Taylor's private credentials.
- Do not push directly to `dev`, `main`, `demo`, or any production/deploy
  branch.
- Do not run `scripts/deploy.sh`, `scripts/deploy-preview.sh`, or any
  production/dev/demo deploy command.
- Do not set operator-only env vars such as `MESH_API_URL`, `SENTRY_DSN`,
  `AXIOM_TOKEN`, `DATABASE_URL_PROD_RO`, `DEPLOY_HOST`, or production `QBO_*`.
- Use checked-in source, local Docker, local Postgres/MinIO, and GitHub feature
  branches.

If a task seems to need operator infra, stop and report the blocker. Do not try
to recreate Taylor's setup.

## Setup Once

Prereqs on Steve's Mac:

- Git with access to `git@github.com:GitSteveLozano/sitelayer.git`
- Node.js 20 LTS and npm
- Docker Desktop
- Claude Code, logged into Steve's own Claude account

Clone and install:

```bash
git clone git@github.com:GitSteveLozano/sitelayer.git
cd sitelayer
npm install
```

Use the collaborator-local env. Do not copy production secrets:

```bash
cat > .env <<'EOF'
APP_TIER=local
VITE_CLERK_PUBLISHABLE_KEY=
CLERK_JWT_KEY=
EOF
```

Run the local stack:

```bash
docker compose up --build
```

Open `http://localhost:3000`. The web app should show the dev RoleSwitcher in
the bottom-right. Pick an `e2e-*` role when testing authenticated flows.

If the local DB is stale or `/api/session` starts returning schema errors:

```bash
docker compose down -v
docker compose up --build
```

## Start Claude Code

Run Claude Code from the repo root:

```bash
claude
```

Good first prompt:

```text
Read docs/STEVE_LOCAL_CLAUDE_CODE_HANDOFF.md, AGENTS.md, CLAUDE.md, and
docs/agents/COLLABORATOR.md. Treat this as Steve's collaborator machine. Do not
use Mesh, Tailscale, browser-bridge, production credentials, or deploy scripts.
Work on a feature branch only, run focused checks, and prepare a branch/PR for
Taylor to integrate.
```

## Normal Change Flow

Start from the branch Taylor names. If Taylor did not name one, start from
`origin/main` for normal product work:

```bash
git fetch origin
git checkout -b agent/steve/<short-topic> origin/main
```

Then:

```bash
# edit with Claude Code
npm run verify:fast
git status --short
git add <changed-files>
git commit -m "fix: <short description>"
git push -u origin agent/steve/<short-topic>
```

Open a PR or send Taylor the branch name and a short summary. Taylor handles the
`dev`/`main` promotion and any dev/demo/prod deploy from his workstation/fleet.

Run `npm run verify` before handoff when the change touches API routes,
database/migrations, Docker, worker behavior, auth, or capture flows. It needs
Docker running and takes longer than `verify:fast`.

## What To Read Before Editing

Use this order:

1. `AGENTS.md` and `CLAUDE.md` for repo rules.
2. `docs/agents/COLLABORATOR.md` for the no-operator-infra local path.
3. `docs/ONBOARDING_DEVELOPER.md` for local stack details.
4. `DEVELOPMENT.md` for common commands and route notes.
5. Live code for the feature area.

Important code conventions:

- There is one web app: `apps/web/`.
- The mounted mobile shell route table is in
  `apps/web/src/screens/mobile-shell.tsx`; do not add new reachable routes to
  legacy unmounted route files.
- Frontend long-lived orchestration belongs in XState machines under
  `apps/web/src/machines/`.
- API calls should extend `apps/web/src/lib/api/<resource>.ts` and use the
  shared `request<T>()` client.
- API routes live under `apps/api/src/routes/`, with dispatch in
  `apps/api/src/routes/dispatch.ts`.

## Picking Up Assigned Issues Automatically (agent-feed)

When Taylor dispatches an issue to you from the work-item board, your machine
can pick it up WITHOUT copy-paste: sitelayer hosts an agent feed
(`/api/agent-feed`) that the `@operator/projectkit` pull-executor polls for
work addressed to `audience=steve`. Each dispatched issue arrives as a
projectkit `Concern` whose `inputs.agent_prompt` carries the full sanitized
context bundle (the same text as the receipt card's "Copy agent bundle"
button) plus authenticated URLs for the capture evidence (rrweb replay JSON,
audio, screen video, screenshots).

One-time setup (in addition to the setup above):

1. Get from Taylor: the feed URL for the tier you review (normally
   `https://dev.sitelayer.sandolab.xyz/api/agent-feed`), your feed token
   (it only grants the `steve` lane), and read access to the
   `taylorSando/projectkit` GitHub repo (the executor installs from a git
   ref).
2. Run the executor from your sitelayer checkout:

```bash
PULL_FEED_URL=https://dev.sitelayer.sandolab.xyz/api/agent-feed \
PULL_AUDIENCE=steve \
PULL_FEED_TOKEN=<token-from-taylor> \
PULL_STATE_FILE=$HOME/.local/state/sitelayer-agent/done.json \
LOCAL_EXECUTOR_TIMEOUT_MS=3600000 \
LOCAL_EXECUTOR_CMD='claude -p "You are picking up a dispatched sitelayer issue on Steve'\''s collaborator machine. The full Concern JSON is on stdin — read inputs.agent_prompt for the context bundle and inputs.artifacts for evidence URLs (fetch with: Authorization: Bearer $PULL_FEED_TOKEN). Follow docs/STEVE_LOCAL_CLAUDE_CODE_HANDOFF.md: feature branch only, npm run verify:fast, push agent/steve/<topic>, then print a short summary and the branch name." --permission-mode acceptEdits' \
npx --yes --package=github:taylorSando/projectkit#v0.9.1 pull-executor
```

What happens:

- The executor polls the feed (30s default), claims a dispatched issue, and
  runs one Claude Code session per issue with the full context on stdin.
- The session's final output is reported back automatically as a projectkit
  `Callback` — Taylor sees it on the work item (the item moves to agent
  review, a human still accepts/resolves).
- Stop it any time with Ctrl-C; `--once` runs a single poll (good for
  trying it out). Already-completed issues never re-run (the state file).

The same collaborator rules apply to these sessions: feature branches only,
no operator infra, report blockers instead of recreating Taylor's setup. The
"Copy agent bundle" button on the feedback receipt card remains the manual
fallback for handing an issue to Claude Code yourself.

## Optional Review-Only Link

If Steve only needs to review the hosted dev app and report issues, he can use:

```text
https://dev.sitelayer.sandolab.xyz/collab/steve
```

That path is browser-only review feedback. It is separate from the local
Claude-Code development workflow above.
