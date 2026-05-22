# UptimeRobot Monitors

External liveness checks for sitelayer production. These run from
UptimeRobot's distributed probes (independent of our Sentry/Caddy
self-checks) so we get woken up when the whole droplet is unreachable —
not just when an individual request fails.

## Monitor list

| # | Type | Target | Interval | Failure threshold | Owner |
|---|------|--------|----------|-------------------|-------|
| 1 | HTTPS keyword | `https://sitelayer.sandolab.xyz/health` — must return `200` AND body contains `"ok":true` | 60s | 2 consecutive failures (~2 min) | Taylor |
| 2 | HTTPS keyword | `https://sitelayer.sandolab.xyz/api/version` — must return `200` AND body contains `"commit"` | 5 min | 3 consecutive failures (~15 min) | Taylor |
| 3 | HTTPS status | `https://dev.sitelayer.sandolab.xyz/health` — must return `200` | 5 min | 5 consecutive failures (~25 min) | Taylor |

**Why these three:**

- Monitor 1 is the load-bearing one. `/health` is what Caddy probes and what the
  rollback script ([`scripts/rollback-droplet.sh`](../scripts/rollback-droplet.sh))
  uses to confirm a deploy succeeded. If this is red, customers can't log in.
- Monitor 2 catches a more subtle failure: the API is up but serving an
  unexpected build (rollback didn't take, registry tag drift, etc.). The
  `"commit"` keyword presence proves the response body is well-formed.
- Monitor 3 (dev tier) is lower priority — degrades developer iteration but
  doesn't affect customers. Longer interval, longer threshold.

The preview droplet's per-PR previews are intentionally NOT monitored —
they're ephemeral and noise would drown the real signal.

## What to do when a monitor fires

1. **Monitor 1 (`/health`) red** → page Taylor immediately. Triage path:
   - First check if Cloudflare/DNS is the issue: `dig sitelayer.sandolab.xyz`
     should still resolve to the reserved IP (`159.203.51.158`).
   - If DNS is fine, SSH to `sitelayer@10.118.0.4` (via Tailscale) and run
     `docker compose -f /app/sitelayer/docker-compose.prod.yml ps`. If the
     api container is unhealthy, see [`docs/RUNBOOK_CONNECTION_POOL.md`](./RUNBOOK_CONNECTION_POOL.md).
   - If the droplet itself is unreachable, escalate to DigitalOcean status page.
2. **Monitor 2 (`/api/version`) red while Monitor 1 is green** → an unexpected
   build is serving requests. Pull the build SHA from the response and
   compare against `cat /app/sitelayer/.last_successful_deployed_sha` on
   the droplet. If divergent, run
   `scripts/rollback-droplet.sh TARGET_SHA=$(cat /app/sitelayer/.last_successful_deployed_sha)`.
3. **Monitor 3 (dev tier) red** → low urgency. Check the latest
   `deploy-dev` workflow run in GitHub Actions; if a recent push broke
   migration apply, the dev DB is reset via `scripts/reset-dev-db.sh`.

## Setup (one-time)

UptimeRobot's free tier covers 50 monitors at 5-minute interval; monitor 1 needs the
paid plan (60s interval). Until that's provisioned, monitor 1 falls back to
5-minute interval and the failure threshold stays the same in wall-clock terms.

1. Sign in at [uptimerobot.com](https://uptimerobot.com) with the
   `sitelayer-ops@releaserent.com` shared account (1Password vault entry
   `UptimeRobot — sitelayer`).
2. For each row in the table above, create a monitor of the listed type
   with the listed URL and threshold. For HTTPS keyword monitors, set
   "Keyword exists" mode against the literal string in the table.
3. Notification: route alerts to Taylor's pager (Pushover) and the
   `#sitelayer-ops` Slack channel via the existing UptimeRobot Slack
   integration.
4. Maintenance windows: any deploy via `.github/workflows/deploy-droplet.yml`
   takes ~2 minutes of downtime on `/health`. Configure maintenance windows
   via the UptimeRobot API in deploy-droplet workflow if false-positive
   alerts during deploys become noisy — for now, the 2-strike threshold
   absorbs a single normal deploy.

## Why not just Sentry uptime?

Sentry's free tier includes one uptime monitor, which we already use against
`/health`. Sentry's probe runs from a single region. UptimeRobot adds
distributed probes (Asia, Europe, US) so a CDN-edge or regional outage
gets caught. The two systems are complementary: Sentry fires fast on
single-region degradation, UptimeRobot fires loud on global outage.

## See also

- [`docs/INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md) — broader on-call orientation
- [`docs/RUNBOOK_CONNECTION_POOL.md`](./RUNBOOK_CONNECTION_POOL.md) — 503/pool-exhaustion triage
- [`BACKUP_STRATEGY.md`](../BACKUP_STRATEGY.md) — backup-timer monitoring (separate from UptimeRobot)
