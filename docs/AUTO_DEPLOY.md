# Sitelayer Fleet-Side Auto-Deploy

**Status:** Tooling shipped; the operator installs the timer (one command below).
**What it restores:** "merge to `dev` → it's live in ~2 minutes" — WITHOUT GitHub
Actions. The repo runs **zero GitHub Actions** (the Actions deploy workflows were
removed in `70b9584b`, and the last workflow `.github/workflows/quality.yml` was
deleted on 2026-06-02); deploys are local-fleet via `scripts/deploy.sh`, and the
single verification authority is the local gate `scripts/verify-local.sh`.

## What it does

A user-level systemd timer fires `scripts/fleet-auto-deploy.sh` every 2 minutes.
Each poll:

1. Refreshes a **dedicated** deploy checkout under
   `~/.cache/sitelayer-autodeploy/repo` (clone if absent, else fetch). This is
   separate from the operator's working tree — the watcher never touches the
   checkout you edit in.
2. For each managed tier (`dev`, `demo` by default):
   - **desired** = remote tip of the tier's tracked branch
     (`git ls-remote origin refs/heads/dev`; both `dev` and `demo` track `dev`
     today).
   - **live** = `build_sha` from `GET https://<host>/api/version`
     (`dev.sitelayer.sandolab.xyz` / `demo.preview.sitelayer.sandolab.xyz`).
   - Compared on the short-sha (7-char) prefix.
3. If they differ, it checks out the desired SHA in the dedicated repo and runs
   `scripts/deploy.sh <tier>` from there — the same entrypoint you would run by
   hand. For `dev`/`demo` that SSHes to the preview droplet and refreshes the
   source-mounted watch-mode stack (no image build), so the new code is live in
   seconds.

```
origin/dev advances ──▶ timer (2min) ──▶ fleet-auto-deploy.sh
                                              │
                    desired (ls-remote)  ◀────┤────▶  live (/api/version build_sha)
                                              │
                            differ? ──▶ deploy.sh dev   (and demo)
```

## Safety model

This watcher is deliberately conservative. It can only ever fast-follow the
**dev** branch onto the **dev** and **demo** tiers.

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
- **Concurrency-safe.** The whole run holds a non-blocking `flock` on
  `/tmp/sitelayer-autodeploy.lock`; if a previous poll is still deploying, the
  next fire exits 0 immediately instead of stacking.
- **Idle is success.** The script exits non-zero **only** on its own internal
  error (e.g. a failed `git fetch`). A tier simply being already-current — the
  normal case on most polls — is a clean exit 0, so the timer doesn't flap red.
- **Logging.** Every poll appends timestamped, structured lines to
  `~/.cache/sitelayer-autodeploy/auto-deploy.log` AND echoes them to stdout
  (captured by journald). The full deploy output of an actual deploy is appended
  to the same log file.

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
  manually — the watcher and a manual run share the `/tmp/sitelayer-autodeploy.lock`
  contract only with each other; a manual `deploy.sh` uses its own droplet-side
  lock. To avoid two deploys racing the same tier, pause the watcher
  (`touch …/PAUSED`) while you hand-deploy that tier, or just let the watcher's
  flock serialize.
- `scripts/deploy.sh prod` is untouched and remains the **only** way prod ships.

## The verification gate

There is **no CI gate** — the single verification authority is the local script
`scripts/verify-local.sh` (`npm run verify`), which `scripts/deploy.sh` runs
before it ships. Because the watcher calls `scripts/deploy.sh <tier>` verbatim,
every auto-deploy of `dev`/`demo` runs that gate too; the prod path
(`deploy.sh prod`) runs the full gate before building the image. Nothing in this
path queries GitHub Actions.

## Configuration (env overrides)

Every path and target is env-overridable (useful for testing on a scratch host).

| Env var                      | Default                                           | Purpose                                                       |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `AUTODEPLOY_TIERS`           | `dev demo`                                        | Space-separated tiers to manage (`prod` refused).             |
| `AUTODEPLOY_DEFAULT_BRANCH`  | `dev`                                             | Tracked branch for tiers without an override.                 |
| `AUTODEPLOY_BRANCH_<TIER>`   | _(unset)_                                         | Per-tier tracked branch (e.g. `AUTODEPLOY_BRANCH_DEMO=main`). |
| `AUTODEPLOY_HOST_<TIER>`     | dev/demo hosts wired in                           | Per-tier live host for `/api/version`.                        |
| `AUTODEPLOY_REPO_DIR`        | `~/.cache/sitelayer-autodeploy/repo`              | Dedicated deploy checkout (never your tree).                  |
| `AUTODEPLOY_REMOTE_URL`      | `https://github.com/GitSteveLozano/sitelayer.git` | Remote to clone/fetch.                                        |
| `AUTODEPLOY_STATE_FILE`      | `~/.cache/sitelayer-autodeploy/state`             | Failed-sha backoff state.                                     |
| `AUTODEPLOY_LOG_FILE`        | `~/.cache/sitelayer-autodeploy/auto-deploy.log`   | Structured log.                                               |
| `AUTODEPLOY_LOCK_FILE`       | `/tmp/sitelayer-autodeploy.lock`                  | flock concurrency guard.                                      |
| `AUTODEPLOY_PAUSED_FILE`     | `~/.cache/sitelayer-autodeploy/PAUSED`            | Kill-switch file.                                             |
| `AUTODEPLOY_PAUSED`          | `0`                                               | Set `1` to pause via env.                                     |
| `AUTODEPLOY_CURL_MAX_TIME`   | `15`                                              | `/api/version` request timeout (seconds).                     |
| `AUTODEPLOY_SHA_COMPARE_LEN` | `7`                                               | Short-sha prefix length for comparison.                       |

## Dependencies

`bash` + `curl` + `git` + `ssh` (all present on the fleet). `jq` is used to parse
`/api/version` when available; if absent, a `grep`/`sed` fallback extracts
`build_sha`.

## Cross-references

- `scripts/fleet-auto-deploy.sh` — the poll-once watcher.
- `scripts/install-auto-deploy-systemd.sh` — idempotent user-timer installer.
- `ops/systemd/sitelayer-auto-deploy.{service,timer}` — the unit files.
- `scripts/deploy.sh` — the manual fleet deploy entrypoint the watcher calls.
- `docs/DEV_ENVIRONMENT.md` / `docs/DEMO_ENVIRONMENT.md` — the tiers it tracks.
- CLAUDE.md → "Deploy procedure" — the local-fleet deploy model.
