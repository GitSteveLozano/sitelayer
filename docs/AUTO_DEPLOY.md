# Sitelayer Fleet-Side Auto-Deploy

**Status:** Tooling shipped; the operator installs the timer (one command below).
**What it restores:** "land to a tracked branch → it's live in ~2 minutes" —
WITHOUT GitHub Actions. The repo runs **zero GitHub Actions** (the Actions deploy
workflows were removed in `70b9584b`, and the last workflow
`.github/workflows/quality.yml` was deleted on 2026-06-02); deploys are
local-fleet via `scripts/deploy.sh`, and the single verification authority is the
local gate `scripts/verify-local.sh`.

**Two lines, not one (2026-06-02):** `dev` fast-follows the `dev` branch (the
agent churn / integration line); `demo` fast-follows `main` (the promoted /
stable line) so prospects never see raw agent churn. The `dev → main` promotion
is a deliberate gated step — see [The promotion model](#the-promotion-model).

## What it does

A user-level systemd timer fires `scripts/fleet-auto-deploy.sh` every 2 minutes.
Each poll:

1. Refreshes a **dedicated** deploy checkout under
   `~/.cache/sitelayer-autodeploy/repo` (clone if absent, else fetch). This is
   separate from the operator's working tree — the watcher never touches the
   checkout you edit in.
2. For each managed tier (`dev`, `demo` by default):
   - **desired** = remote tip of the tier's tracked branch. `dev` tracks the
     `dev` branch (`git ls-remote origin refs/heads/dev`); `demo` tracks `main`
     (`git ls-remote origin refs/heads/main`) — the promoted/stable line, so
     prospects stay off the raw churn.
   - **live** = `build_sha` from `GET https://<host>/api/version`
     (`dev.sitelayer.sandolab.xyz` / `demo.preview.sitelayer.sandolab.xyz`).
   - Compared on the short-sha (7-char) prefix.
3. If they differ, it checks out the desired SHA in the dedicated repo and runs
   `scripts/deploy.sh <tier>` from there — the same entrypoint you would run by
   hand. For `dev`/`demo` that SSHes to the preview droplet and refreshes the
   source-mounted watch-mode stack (no image build), so the new code is live in
   seconds.

```
origin/dev  advances ─┐
origin/main advances ─┴▶ timer (2min) ──▶ fleet-auto-deploy.sh
                                              │
                    desired (ls-remote)  ◀────┤────▶  live (/api/version build_sha)
                                              │   dev  tracks origin/dev
                                              │   demo tracks origin/main
                            differ? ──▶ deploy.sh dev / deploy.sh demo
```

## Safety model

This watcher is deliberately conservative. It can only ever fast-follow a
non-prod tier onto its tracked branch: the **dev** tier onto the **dev** branch
(the churn line) and the **demo** tier onto **main** (the promoted line). It
cannot deploy prod, and it cannot deploy a branch other than each tier's
configured one.

- **NEVER prod.** A tier named `prod` is refused outright; the default tier set is
  `dev demo`. Production stays a manual `scripts/deploy.sh prod` per
  CLAUDE.md → "Deploy procedure". There is no code path here that can reach the
  prod droplet, registry, or `sitelayer_prod`.
- **Kill switch.** `touch ~/.cache/sitelayer-autodeploy/PAUSED` (or set env
  `AUTODEPLOY_PAUSED=1`) → the next poll logs `paused` and exits cleanly without
  fetching or deploying. The pause file survives reboots. Remove it to resume.
- **Failed-sha backoff.** If a deploy of SHA `X` fails, `X` is recorded per tier
  in `~/.cache/sitelayer-autodeploy/state`. While the remote tip is still `X`,
  the watcher SKIPS it — a broken commit cannot retry-storm the droplet every 2
  minutes. The marker is cleared automatically on the next successful deploy of
  that tier, and is implicitly ignored once the remote tip moves to a new SHA.
- **Concurrency-safe (two locks).** The whole watcher run holds a non-blocking
  `flock` on `/tmp/sitelayer-autodeploy.lock`; if a previous poll is still
  deploying, the next fire exits 0 immediately instead of stacking.
  Independently, the `scripts/deploy.sh dev|demo` entrypoint it calls takes a
  **per-tier** flock (`/tmp/sitelayer-<tier>-deploy.lock`) around the SSH
  deploy, so a hand-run `deploy.sh <tier>` and a watcher deploy of the same tier
  cannot interleave on the shared preview checkout (the second exits 1). See
  [Relationship to `scripts/deploy.sh`](#relationship-to-scriptsdeploysh).
- **Idle is success.** The script exits non-zero **only** on its own internal
  error (e.g. a failed `git fetch`). A tier simply being already-current — the
  normal case on most polls — is a clean exit 0, so the timer doesn't flap red.
- **Logging.** Every poll appends timestamped, structured lines to
  `~/.cache/sitelayer-autodeploy/auto-deploy.log` AND echoes them to stdout
  (captured by journald). The full deploy output of an actual deploy is appended
  to the same log file.

## The promotion model

Two deploy lines, deliberately separated so prospects + customers never see raw
agent churn while `dev` stays a free playground:

| Line         | Tracked branch | Who sees it                         | Gating                                                         |
| ------------ | -------------- | ----------------------------------- | -------------------------------------------------------------- |
| **churn**    | `dev`          | agents / internal QA                | auto-everything; ephemeral per-PR previews; no promotion gate. |
| **promoted** | `main`         | prospects (demo) + customers (prod) | the pre-push **standard** gate + the post-deploy smoke.        |

- **`dev` = the agent churn / integration line.** Heavy agent iteration lands
  here continuously. The `dev` tier auto-follows it and per-PR previews are
  ephemeral, so churn (and its DB-migration churn) is effectively free.
- **`main` = the PROMOTED line.** Code reaches `main` only via a **deliberate
  gated `dev → main` promotion** — the operator (or the gate) promotes when `dev`
  is good. The promotion is gated by the repo-tracked pre-push hook
  (`.githooks/pre-push` → `npm run verify`, the **standard** gate) at land time
  and confirmed by the **post-deploy smoke** (`scripts/smoke-tier.sh`).
- **demo + prod deploy from `main`.** The `demo` tier here fast-follows `main`
  (this change), and prod ships from `main` via `scripts/deploy.sh prod`. So the
  prospect-facing demo and the customer-facing prod both ride the promoted line,
  not the churn line.

The canonical write-up of the gates lives in
[`docs/RELEASE_GATES.md`](RELEASE_GATES.md); this section is the auto-deploy
view of it.

> **Installed-copy note (what actually runs).** The committed
> `scripts/fleet-auto-deploy.sh` is the source of truth. The committed systemd
> unit runs it **from the operator's checkout** — `ExecStart` in
> [`ops/systemd/sitelayer-auto-deploy.service`](../ops/systemd/sitelayer-auto-deploy.service)
> is `%h/projects/sitelayer/scripts/fleet-auto-deploy.sh`, i.e.
> `~/projects/sitelayer/scripts/fleet-auto-deploy.sh`. So editing this committed
> script + a `git pull` on that checkout is enough; **no copy step is needed for
> the default unit.**
>
> If the operator instead keeps a convenience copy on `$PATH`
> (`~/.local/bin/fleet-auto-deploy.sh`) and runs _that_ by hand — or points a
> customized `ExecStart` at it — that copy is a **stale snapshot** that does NOT
> track edits to the committed script (e.g. demo tracking `main`, the URL
> normalization, the inline-verify flag, the per-tier flock in `deploy.sh` it
> calls). **Re-copy it after any change to keep it current:**
> `cp scripts/fleet-auto-deploy.sh ~/.local/bin/fleet-auto-deploy.sh`. Prefer
> the default unit (operator's checkout) so there is no second copy to drift.

## Install / enable

```bash
# From your Sitelayer checkout on the fleet box that holds the ssh key to the
# preview droplet (sitelayer@159.203.53.218):
scripts/install-auto-deploy-systemd.sh
```

The installer copies the unit files to `~/.config/systemd/user/`, runs
`daemon-reload`, and `enable --now`s the timer. It prints the timer status and
the log/pause commands. It is idempotent — re-run after editing the units.

> For the user timer to keep firing while you are logged out, enable linger once:
> `loginctl enable-linger $USER`.

### Watch it

```bash
journalctl --user -u sitelayer-auto-deploy.service -f
tail -f ~/.cache/sitelayer-autodeploy/auto-deploy.log
```

### Run once on demand

```bash
systemctl --user start sitelayer-auto-deploy.service
# or invoke the script directly:
scripts/fleet-auto-deploy.sh
```

## Pause / disable

```bash
# Pause (keeps the timer installed; survives reboot):
touch ~/.cache/sitelayer-autodeploy/PAUSED
rm    ~/.cache/sitelayer-autodeploy/PAUSED      # resume

# Disable entirely:
systemctl --user disable --now sitelayer-auto-deploy.timer
```

## Relationship to `scripts/deploy.sh`

The watcher is a thin **driver around the existing manual deploy path**, not a
replacement for it:

- It runs `scripts/deploy.sh <tier>` verbatim from its dedicated checkout, so the
  on-droplet behavior (rsync, env merge, container restart, demo reseed, health
  check) is byte-identical to a hand-run deploy.
- You can always still run `scripts/deploy.sh dev` / `scripts/deploy.sh demo`
  manually. Two layers of locking keep a manual run and the watcher from racing
  the same tier:
  - **`scripts/deploy.sh dev|demo` now takes a fleet-side per-tier flock**
    (`/tmp/sitelayer-<tier>-deploy.lock`, override with `DEPLOY_LOCK_FILE`)
    around the SSH deploy — mirroring `deploy-production-local.sh`'s
    `/tmp/sitelayer-production-deploy.lock`. A second `deploy.sh dev` (whether a
    hand-run or the watcher's) while one is in flight **exits 1 immediately**
    instead of interleaving rsync + `git reset` on the shared preview checkout
    (which would corrupt it). The lock is **per tier**, so a `dev` deploy never
    blocks a `demo` deploy. This is the lock that actually serializes a manual
    deploy against a watcher deploy.
  - The watcher additionally holds its own outer `/tmp/sitelayer-autodeploy.lock`
    around the whole poll, but a **hand-run `deploy.sh` does NOT take that
    outer lock** — so the per-tier `deploy.sh` flock above is what protects the
    manual-vs-watcher case.
  - You can still `touch …/PAUSED` to pause the watcher entirely while you
    hand-deploy, but it is no longer required to avoid corruption — the per-tier
    flock makes a concurrent run fail fast rather than clobber the checkout.
- `scripts/deploy.sh prod` is untouched and remains the **only** way prod ships
  (it carries its own `/tmp/sitelayer-production-deploy.lock` on the droplet).

## The verification gate

There is **no CI gate** — the single verification authority is the local script
`scripts/verify-local.sh` (`npm run verify`). Where it runs depends on the path:

- **Manual `scripts/deploy.sh dev|demo`** (operator's checkout, has
  `node_modules`): runs the gate before shipping (fast by default; set
  `VERIFY_LEVEL` to add the integration suite).
- **The watcher's auto-deploy** calls `scripts/deploy.sh <tier>` with
  **`SKIP_VERIFY=1`**, so it does **NOT** re-run the gate on each poll. This is
  deliberate: the watcher's dedicated checkout
  (`~/.cache/sitelayer-autodeploy/repo`) has no `node_modules`, and the SHA was
  already gated **at land time**. Land-time gating is enforced AND
  auto-installed:
  - the repo-tracked pre-push hook (`.githooks/pre-push`) runs the **standard**
    `npm run verify` gate and **blocks** any push to `dev`/`main` that fails it
    (bypass: the explicit `git push --no-verify`); and
  - that hook is installed **automatically** — root `package.json`'s `prepare`
    script runs `scripts/install-git-hooks.sh` on every `npm install`, so a
    fresh clone is gated by default (no manual per-clone step to forget). The
    `prepare` step is a best-effort no-op in CI / Docker builds / non-git
    checkouts (`CI`, `SITELAYER_SKIP_HOOKS=1`, or a missing `.git`/`.githooks`)
    so it never breaks `npm ci`.
  - **Defense in depth (opt-in):** set `AUTODEPLOY_INLINE_VERIFY=1` (and put
    `node`/`npm` on the unit `PATH`) to make the watcher re-run
    `npm run verify` (level `AUTODEPLOY_VERIFY_LEVEL`, default `fast`) in its
    dedicated checkout before shipping — catching a `--no-verify`-bypassed push
    or a checkout that never had the hook. It `npm ci`s the dedicated checkout
    on first use and refuses to ship a SHA that fails (recording the failed-sha
    so it cannot retry-storm). Off by default to keep the 2-min poll fast.
- **`deploy.sh prod`** runs the standard gate (incl. the DB-backed integration
  suite) before building the image; the Playwright e2e suite is an opt-in
  `--full` level (`npm run verify:full`), not part of the deploy gate.

Nothing in this path queries GitHub Actions.

## Configuration (env overrides)

Every path and target is env-overridable (useful for testing on a scratch host).

| Env var                      | Default                                           | Purpose                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTODEPLOY_TIERS`           | `dev demo`                                        | Space-separated tiers to manage (`prod` refused).                                                                                                                                                   |
| `AUTODEPLOY_DEFAULT_BRANCH`  | `dev`                                             | Tracked branch for tiers without an override (e.g. `dev`).                                                                                                                                          |
| `AUTODEPLOY_BRANCH_DEMO`     | `main`                                            | demo tracks `main` (promoted line), NOT `dev` (churn line).                                                                                                                                         |
| `AUTODEPLOY_BRANCH_<TIER>`   | _(unset; demo defaults to `main`)_                | Per-tier tracked-branch override (e.g. `AUTODEPLOY_BRANCH_DEMO=main`).                                                                                                                              |
| `AUTODEPLOY_HOST_<TIER>`     | dev/demo hosts wired in                           | Per-tier live host for `/api/version`.                                                                                                                                                              |
| `AUTODEPLOY_REPO_DIR`        | `~/.cache/sitelayer-autodeploy/repo`              | Dedicated deploy checkout (never your tree).                                                                                                                                                        |
| `AUTODEPLOY_REMOTE_URL`      | `https://github.com/GitSteveLozano/sitelayer.git` | Remote to clone/fetch. MUST match the `https` url `scripts/deploy.sh`'s droplet heredoc uses; a `git@github.com:` (SSH) override is normalized back to `https` so the two checkouts cannot diverge. |
| `AUTODEPLOY_STATE_FILE`      | `~/.cache/sitelayer-autodeploy/state`             | Failed-sha backoff state.                                                                                                                                                                           |
| `AUTODEPLOY_LOG_FILE`        | `~/.cache/sitelayer-autodeploy/auto-deploy.log`   | Structured log.                                                                                                                                                                                     |
| `AUTODEPLOY_LOCK_FILE`       | `/tmp/sitelayer-autodeploy.lock`                  | Watcher-wide flock concurrency guard (whole poll).                                                                                                                                                  |
| `AUTODEPLOY_PAUSED_FILE`     | `~/.cache/sitelayer-autodeploy/PAUSED`            | Kill-switch file.                                                                                                                                                                                   |
| `AUTODEPLOY_PAUSED`          | `0`                                               | Set `1` to pause via env.                                                                                                                                                                           |
| `AUTODEPLOY_CURL_MAX_TIME`   | `15`                                              | `/api/version` request timeout (seconds).                                                                                                                                                           |
| `AUTODEPLOY_SHA_COMPARE_LEN` | `7`                                               | Short-sha prefix length for comparison.                                                                                                                                                             |
| `AUTODEPLOY_INLINE_VERIFY`   | `0`                                               | `1` = re-run `npm run verify` in the dedicated checkout before shipping (defense in depth; needs node/npm on PATH).                                                                                 |
| `AUTODEPLOY_VERIFY_LEVEL`    | `fast`                                            | Verify level used by `AUTODEPLOY_INLINE_VERIFY` (`fast` / `standard` / `full`).                                                                                                                     |

`scripts/deploy.sh` (the entrypoint the watcher calls) also honors:

| Env var            | Default                             | Purpose                                                                                    |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `DEPLOY_LOCK_FILE` | `/tmp/sitelayer-<tier>-deploy.lock` | Per-tier fleet-side flock around the SSH deploy (a concurrent same-tier run exits 1).      |
| `SKIP_VERIFY`      | `0`                                 | `1` = skip the local verify gate (the watcher passes this; the SHA is gated at land time). |

## Dependencies

`bash` + `curl` + `git` + `ssh` (all present on the fleet). `jq` is used to parse
`/api/version` when available; if absent, a `grep`/`sed` fallback extracts
`build_sha`.

## #27 — managed per-PR schema isolation vs the squashed baseline

The **managed `preview` tier** (per-PR ephemeral stacks) isolates each PR inside
the shared `sitelayer_preview` database by giving every stack its own schema
`sitelayer_<slug>`. `scripts/deploy-preview.sh` implements this by rendering
`PGOPTIONS=-c search_path=<slug>,public` into the per-stack `.env`, and
`scripts/migrate-db.sh` / `scripts/ensure-preview-schema.sh` run `psql` with that
`PGOPTIONS` so every `CREATE` lands in the per-slug schema.

**The trap.** A `pg_dump --schema-only` **baseline** — which
`docker/postgres/init/000_baseline.sql` is (a squashed baseline; see its
generated-artifact header and `docs/MIGRATION_BASELINE.md`) — emits
`SELECT pg_catalog.set_config('search_path', '', false);` at the top and then
**fully-qualifies every object as `public.<name>`** (`CREATE TABLE public.foo`,
etc.). Both of those override the connection's `search_path=<slug>,public`. So a
squashed-baseline migration would create **all** objects in `public`, NOT in the
per-slug schema — silently collapsing every per-PR preview onto **one shared
`public` schema** (cross-PR data bleed + migration-checksum collisions in the
same database). This defeats the isolation the `preview` tier exists to provide.

**Who is affected.** Only the **managed `preview`** tier uses the per-slug
search_path mechanism. `dev`/`demo` (and the `local` backend for any tier)
deliberately use `public` — `dev`/`demo` each target a dedicated database
(`sitelayer_dev`/`sitelayer_demo`), and the local backend gives every stack its
own Postgres container — so a public-qualified baseline is correct there. The
squash was adopted for those disposable tiers + the repo; managed per-PR
previews are the one consumer it would break.

**Guard (shipped).** `scripts/deploy-preview.sh` now **refuses** to apply a
search_path-defeating baseline into a managed per-slug schema: at the migration
step, for the managed `preview` tier, if `000_baseline.sql` contains
`set_config('search_path', '')` it exits with a clear data-integrity error
(only when migrations actually run — an already-applied marker short-circuits
it). Acknowledge and proceed with the shared-`public` behavior via
`PREVIEW_ALLOW_PUBLIC_QUALIFIED_BASELINE=1` (the script then logs LOUDLY that
isolation is not effective).

**Real fix (not done here — out of this branch's file scope).** Make the
baseline generator (`scripts/squash-migrations-baseline.sh`) emit
unqualified / `search_path`-relative object names (drop the
`public.` prefixes + the `set_config('search_path','')`), OR switch managed
previews to the `local` backend (per-stack DB, which uses `public` safely). The
guard above is the safe interim: it converts a silent isolation failure into a
loud, opt-in-to-override stop.

## Cross-references

- `scripts/fleet-auto-deploy.sh` — the poll-once watcher.
- `scripts/install-auto-deploy-systemd.sh` — idempotent user-timer installer.
- `ops/systemd/sitelayer-auto-deploy.{service,timer}` — the unit files.
- `scripts/deploy.sh` — the manual fleet deploy entrypoint the watcher calls.
- `docs/DEV_ENVIRONMENT.md` / `docs/DEMO_ENVIRONMENT.md` — the tiers it tracks.
- CLAUDE.md → "Deploy procedure" — the local-fleet deploy model.
