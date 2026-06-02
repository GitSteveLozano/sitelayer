# Sitelayer Deterministic e2e Runner

**Status:** Tooling shipped; the operator installs the timer (one command below).
**What it does:** runs `npm run verify:full` (the full gate **plus** the
Playwright e2e suite) on a schedule, on a **quiet/idle box**, and alerts on
failure via Sentry + Pushover.

## Why this exists

The deploy gate (`scripts/verify-local.sh`, the `standard` level) is
deterministic on purpose: static + build + unit + the DB-backed integration
suite. The Playwright **e2e** stage is deliberately **excluded** from that gate
and gated behind `--full` (`npm run verify:full`) because it stands up the whole
app stack + a real browser and is **resource-sensitive** — reliable on a clean,
idle runner, flaky (`browser/page-closed`) on a loaded one. See the long comment
at the top of `scripts/verify-local.sh`.

This runner is the scheduled place e2e **actually runs**: on an idle machine, on
a cadence, so a real e2e regression on `dev`/`main` is caught and surfaced
without making every deploy wait on (and flake against) a browser.

> **Run it on a QUIET box.** The preview droplet off-hours, or a $6/mo
> throwaway droplet, is ideal. **Do NOT install this on `taylor-pc`** — the
> operator's workstation is loaded and interactive, which is exactly the
> condition that makes the browser stage flake. The whole point is determinism
> on idle hardware.

## What each run does

A user-level systemd timer fires `scripts/e2e-runner.sh`. Each run:

1. Refreshes a **dedicated** checkout under `~/.cache/sitelayer-e2e-runner/repo`
   (clone if absent, else fetch) — never the operator's working tree.
2. For each watched branch (`dev main` by default):
   - **tip** = remote tip of the branch (`git ls-remote origin refs/heads/<b>`).
   - If that tip SHA **already passed** on a prior run (recorded per branch in
     `~/.cache/sitelayer-e2e-runner/passed-shas`), it **short-circuits** — a
     frequent/per-dev-advance timer is therefore cheap on an unchanged tip.
   - Otherwise it checks out the tip in the dedicated repo, runs `npm ci`, then
     `npm run verify:full` (`VERIFY_LEVEL=full`).
3. On **PASS**, it records the SHA so the next run skips it.
4. On **FAILURE**, it emits a **Sentry** event (same envelope shape as
   `scripts/check-systemd-timers.sh`) **and** a high-priority **Pushover** push,
   and exits non-zero so the timer goes red and journald carries the log.

```
dev/main tip advances ──▶ timer ──▶ e2e-runner.sh
                                        │
              tip == last-passed? ──▶ yes: skip (cheap)
                                        │ no
                              npm ci + npm run verify:full
                                        │
                          pass ──▶ record SHA      fail ──▶ Sentry + Pushover + exit 1
```

## Install / enable

```bash
# On the QUIET box (preview droplet off-hours, or a $6/mo throwaway), from a
# Sitelayer checkout with node/npm + docker on PATH:
scripts/install-e2e-runner-systemd.sh                 # nightly at 04:30 (default)
scripts/install-e2e-runner-systemd.sh --nightly 03:00 # nightly at a custom time
scripts/install-e2e-runner-systemd.sh --poll 15       # per-dev-advance: poll every 15 min
scripts/install-e2e-runner-systemd.sh --run-now       # also run one pass immediately
```

The installer copies the unit files to `~/.config/systemd/user/`, applies the
chosen cadence via a `*.timer.d/cadence.conf` drop-in (so the tracked unit file
keeps its documented nightly default), runs `daemon-reload`, and `enable --now`s
the timer. It is **idempotent** — re-run after editing the units or to change
cadence.

> For the user timer to keep firing while you are logged out, enable linger once:
> `loginctl enable-linger $USER`.

### Cadence

| Mode    | Flag                | Schedule                                    | When to use                                         |
| ------- | ------------------- | ------------------------------------------- | --------------------------------------------------- |
| Nightly | `--nightly [HH:MM]` | `OnCalendar=*-*-* HH:MM:00` (default 04:30) | Default. One full e2e pass per night on idle.       |
| Poll    | `--poll [MINUTES]`  | `OnUnitActiveSec=Nmin` (default 15)         | Per-dev-advance. Cheap because unchanged tips skip. |

Both have `RandomizedDelaySec` jitter (nightly) so a fleet of boxes doesn't
stampede the registry/db at the same instant.

## Watch it

```bash
journalctl --user -u sitelayer-e2e-runner.service -f
tail -f ~/.cache/sitelayer-e2e-runner/e2e-runner.log
```

## Pause / disable

```bash
# Pause (keeps the timer installed; survives reboot):
touch ~/.cache/sitelayer-e2e-runner/PAUSED
rm    ~/.cache/sitelayer-e2e-runner/PAUSED      # resume

# Disable entirely:
systemctl --user disable --now sitelayer-e2e-runner.timer
```

## Alerting on failure

Two channels, both **best-effort** (absent creds => that channel silently
no-ops; the run still fails loudly via exit code + journald):

- **Sentry** — reuses `SENTRY_DSN` (env or the rendered `/app/sitelayer/.env`).
  The event uses the same envelope shape as the existing timer monitor
  (`scripts/check-systemd-timers.sh`), tagged `service=e2e-runner`, environment
  `e2e-runner`, so it lands in the same Sentry project.
- **Pushover** — the fleet's operator-alert route. Set `PUSHOVER_TOKEN` (app
  token) + `PUSHOVER_USER` (user/group key). The push is `priority=1` (high) so
  a red e2e on `dev`/`main` breaks through quiet-hours rules. These keys are
  declared (optional) in `ops/env/production.env.json` so the render path knows
  them; on a standalone throwaway box, export them in the unit environment or a
  small env file instead.

## Relationship to the deploy gate + auto-deploy

- This runner **never deploys** and **never touches prod** — it only verifies.
- It runs the **exact** `verify:full` the deploy path would run with `--full`,
  so a green run here is a strong signal the e2e suite passes on that SHA.
- The fleet auto-deploy watcher (`docs/AUTO_DEPLOY.md`) ships `dev`/`demo` on the
  deterministic gate (it does **not** run e2e). This runner is the complementary
  e2e signal — slower, scheduled, on a quiet box — that the fast deploy path
  intentionally leaves out.

## Configuration (env overrides)

| Env var                    | Default                                        | Purpose                                           |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `E2E_RUNNER_BRANCHES`      | `dev main`                                     | Space-separated branches to verify.               |
| `E2E_RUNNER_VERIFY_LEVEL`  | `full`                                         | `VERIFY_LEVEL` passed to the gate.                |
| `E2E_RUNNER_VERIFY_CMD`    | `npm run verify:full`                          | The verify command run in the dedicated checkout. |
| `E2E_RUNNER_REPO_DIR`      | `~/.cache/sitelayer-e2e-runner/repo`           | Dedicated checkout (never your tree).             |
| `E2E_RUNNER_REMOTE_URL`    | `https://github.com/GitSteveLozano/...`        | Remote to clone/fetch.                            |
| `E2E_RUNNER_STATE_FILE`    | `~/.cache/sitelayer-e2e-runner/passed-shas`    | Per-branch last-passed SHA (short-circuit).       |
| `E2E_RUNNER_LOG_FILE`      | `~/.cache/sitelayer-e2e-runner/e2e-runner.log` | Structured log.                                   |
| `E2E_RUNNER_LOCK_FILE`     | `/tmp/sitelayer-e2e-runner.lock`               | flock concurrency guard.                          |
| `E2E_RUNNER_PAUSED_FILE`   | `~/.cache/sitelayer-e2e-runner/PAUSED`         | Kill-switch file.                                 |
| `E2E_RUNNER_PAUSED`        | `0`                                            | Set `1` to pause via env.                         |
| `SENTRY_DSN`               | _(from env / `/app/sitelayer/.env`)_           | Sentry DSN for failure events.                    |
| `PUSHOVER_TOKEN` / `_USER` | _(from env / `/app/sitelayer/.env`)_           | Pushover app token + user/group key.              |

## Dependencies

`bash` + `git` + `npm`/`node` + `docker` (for the e2e compose stack) + a
host-installable Playwright chromium. `python3` for the Sentry envelope (already
present where the timer monitor runs); `curl` for Pushover. Absent optional
tools degrade gracefully (the alert channel no-ops; the verify itself still
runs/fails).

## Cross-references

- `scripts/e2e-runner.sh` — the run-once verifier.
- `scripts/install-e2e-runner-systemd.sh` — idempotent user-timer installer.
- `ops/systemd/sitelayer-e2e-runner.{service,timer}` — the unit files.
- `scripts/verify-local.sh` — the gate; `--full` is what this runner invokes.
- `scripts/check-systemd-timers.sh` — the Sentry-envelope pattern this mirrors.
- `docs/AUTO_DEPLOY.md` — the complementary fast deploy watcher (no e2e).
