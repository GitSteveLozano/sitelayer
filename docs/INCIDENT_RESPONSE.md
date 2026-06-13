# Sitelayer Incident Response Runbook

**Audience:** on-call engineer (currently Taylor).
**Edge:** `sitelayer.sandolab.xyz` → Cloudflare **DNS-only** (grey cloud; the
CF proxy is OFF — no WAF, no CF TLS, no origin-hiding) → reserved IP
`159.203.51.158` → containerized Caddy on the prod droplet, which **terminates
TLS itself** (Let's Encrypt) → api/web/worker. The droplet origin is therefore
**publicly reachable on 443** and Caddy is the only edge. Enabling the
Cloudflare proxy (orange cloud) for WAF + origin-hiding is an open operator
task, not the current reality — see §4.
**Postgres:** managed `sitelayer-db` (`9948c96b-b6b6-45ad-adf7-d20e4c206c66`),
`db-s-1vcpu-2gb` single node, Toronto `tor1`. No PITR (needs a standby node, not
more RAM — see `docs/DR_RESTORE.md`).
**Auth:** Clerk (Hobby).
**Errors:** Sentry org `sandolabs`, project `sitelayer-api` (API **and** worker
events — `SENTRY_WORKER_DSN` is absent so the worker falls back to `SENTRY_DSN`,
i.e. the api project) and `sitelayer-web`. There is no separate live
`sitelayer-worker` project receiving events today.

For each incident: **detect → mitigate → investigate → comms (when customers exist) → escalate**. Cutover steps assume you can SSH via `doctl compute ssh sitelayer`.

---

## On-call quick reference (memorize these)

```bash
doctl compute ssh sitelayer
docker compose -f /app/sitelayer/docker-compose.prod.yml ps
curl -fsS https://sitelayer.sandolab.xyz/api/version   # live build_sha (deploys are local-fleet, no GitHub Actions)
curl -fsS https://sitelayer.sandolab.xyz/health
docker compose -f /app/sitelayer/docker-compose.prod.yml logs --tail 200 -f api
```

---

## 1. 5xx error spike

**Detect:** Sentry alert "issue rate > 10 in 5 min" on `sitelayer-api` (this is
where both API and worker errors land — `SENTRY_WORKER_DSN` is absent). The
`/api/metrics` series `sitelayer_http_requests_total{status=~"5.."}` rising is
the corroborating signal, but note **nothing scrapes `/api/metrics`** (no
Prometheus); you curl it ad hoc with the `API_METRICS_TOKEN` bearer, so Sentry
is the real detection surface.

**Mitigate (≤ 2 min):**

```bash
doctl compute ssh sitelayer
docker compose -f /app/sitelayer/docker-compose.prod.yml logs api --tail 200
docker compose -f /app/sitelayer/docker-compose.prod.yml ps
# If api is restarting hot:
docker compose -f /app/sitelayer/docker-compose.prod.yml restart api
```

**Investigate:** open the Sentry issue directly — that is the primary path in
prod today. The `/api/debug/traces/:traceId` helper that joins a trace with
`mutation_outbox` / `sync_events` rows is **not usable in prod right now**:

- `DEBUG_TRACE_TOKEN` and `SENTRY_AUTH_TOKEN` are **absent** from the prod
  `.env` (both are optional-secret manifest entries that haven't been
  provisioned), so the endpoint can't authenticate the caller or reach the
  Sentry API.
- It is tier-gated against prod anyway unless `DEBUG_ALLOW_PROD=1` (also unset).
- Prod trace sampling is `tracesSampleRate=0.1`, so most requests have no trace
  to fetch even if it were wired.

So in prod, work from the Sentry issue + the SQL below; don't burn time on
`/api/debug/traces`. (The endpoint IS the right tool on dev/preview, where the
token is set and sampling is `1.0`.)

```bash
# dev/preview only — DEBUG_TRACE_TOKEN + SENTRY_AUTH_TOKEN must be set, and
# prod requires DEBUG_ALLOW_PROD=1 (not set):
curl -fsS -H "Authorization: Bearer $DEBUG_TRACE_TOKEN" \
  "https://dev.sitelayer.sandolab.xyz/api/debug/traces/<trace_id>?by=request_id"
```

To correlate by hand in prod, query the queue tables on the `request_id` from
the Sentry event:

```sql
SELECT id, mutation_type, status, request_id, attempt_count, last_error
  FROM mutation_outbox WHERE request_id = '<request_id>';
SELECT id, entity_type, status, request_id, attempt_count, last_error
  FROM sync_events WHERE request_id = '<request_id>';
```

Common causes: bad migration left a missing column → run `ENV_FILE=/app/sitelayer/.env scripts/check-db-schema.sh`; QBO sync looping on bad token → look for `scope=qbo_sync` errors; pg pool exhausted → look for `Error: timeout exceeded when trying to connect`.

**Comms (when customers exist):**

> We're investigating elevated errors on Sitelayer. The app may be slow or return errors for the next ~15 minutes. We'll post an update at <time>. — Taylor

**Escalate:** Sentry triage; if root cause is QBO connector, page Intuit dev support.

### 1a. Sentry paging — wiring prod errors to a pager

The detect step above assumes a Sentry alert actually pages someone. By
default it does **not**: Sentry error alerting reaches only the Sentry
dashboard + UptimeRobot, so a prod error can sit unseen. To wire prod errors
to a pager destination, run:

```bash
SENTRY_AUTH_TOKEN=<token> SENTRY_ORG=sandolabs \
  SENTRY_ALERT_EMAIL=<pager-mailbox> \
  npm run ops:sentry-alerts
```

This CREATE-or-UPDATEs two Sentry issue-alert rules on the api (and worker)
project — (a) **new unresolved issue** and (b) **error frequency spike** —
pointing at the email destination, plus an optional generic
PagerDuty/Slack-compatible webhook when `SENTRY_ALERT_WEBHOOK` is set. The
token needs `project:write` + `alerts:write`. The script
([`scripts/setup-sentry-alerts.mjs`](../scripts/setup-sentry-alerts.mjs)) is
**idempotent** (rules keyed by a stable name — re-running converges, never
duplicates) and a **clean no-op** when the token/org are unset, so it is safe
to run from any box. See `.env.example` for the `SENTRY_ALERT_*` /
`SENTRY_PROJECT_*` knobs. With this wired, the §1 "Sentry alert" detect step
becomes a real page instead of a dashboard you have to remember to open.

---

## 2. Database down (DO managed Postgres outage)

**Detect:** `/health` returns 503; `docker compose logs api` shows `connection refused` or `terminating connection due to administrator command`.

**Mitigate:** there is **no app-side circuit breaker today**. Every request attempts a pg connection and times out. Two options:

1. Wait and let DO recover (most outages < 10 min).
2. Pull the api+worker offline so health checks fail loudly:
   ```bash
   doctl compute ssh sitelayer --ssh-command='cd /app/sitelayer && docker compose -f docker-compose.prod.yml stop api worker'
   ```
   Caddy will keep serving the static web bundle; the SPA will show a cached error.

**Investigate:** https://status.digitalocean.com/ → Toronto / Managed Databases. Then:

```bash
doctl databases get 9948c96b-b6b6-45ad-adf7-d20e4c206c66
```

**Risk note:** the lack of a circuit breaker is a known gap. Track in `mesh` as `sitelayer/api-circuit-breaker`. Mitigation order of preference once it lands: open-circuit on >3 consecutive pg errors, return 503 with `Retry-After: 30`.

**Failover:** if the cluster is destroyed, the realistic path is the logical
`pg_dump` restore — `docs/DR_RESTORE.md` **Procedure 3** (PRIMARY recovery
path). PITR/fork (Procedure 2 Option A) is **not available**: the cluster is
single-node (`db-s-1vcpu-2gb`, `NumNodes=1`) and PITR needs a standby node, not
more RAM. Don't reach for the fork command — it errors.

**Comms:** "Our database provider is experiencing an outage. We're following their status page; data is safe (provider backups + nightly logical dumps)."

**Escalate:** DO support ticket, severity 1, attach cluster ID.

---

## 3. Clerk outage

**Detect:** every protected request returns 401 with `clerk verification unavailable` or `invalid signature`. Sign-in flow hangs.

**Behavior:** the API's `verifyClerkJwt` (apps/api/src/auth.ts) rejects requests when Clerk's signing keys can't be fetched/verified. Public paths such as `/api/integrations/qbo/callback`, `/health`, and `/api/version` keep working. `/api/metrics` stays bearer-gated by `API_METRICS_TOKEN`. Everything else 401s.

**Mitigate:** there is no graceful degradation. Check https://status.clerk.com/. **Do not** flip `AUTH_ALLOW_HEADER_FALLBACK=1` in prod — that disables auth entirely.

**Comms:**

> Sign-in is currently unavailable due to a Clerk (our auth provider) outage. Already-authenticated sessions may continue to work for ~1 hour. Status: https://status.clerk.com/

**Escalate:** Clerk support, attach instance ID from dashboard.

---

## 4. Cloudflare outage (DNS / edge)

**Detect:** `dig sitelayer.sandolab.xyz` returns SERVFAIL or stale. Customers report `ERR_NAME_NOT_RESOLVED`.

**Scope note:** Cloudflare is **DNS-only** for `sitelayer` (grey cloud — the
proxy is OFF). So a Cloudflare outage that only affects their _proxy/WAF_ edge
does **not** affect us — traffic already goes straight to the droplet's reserved
IP after DNS resolves. The only Cloudflare dependency we have is **authoritative
DNS resolution**. (This is also why there's no WAF in front of the origin — see
the open task in §4a below.)

**Mitigate:** four `sandolab.xyz` zones live on Cloudflare Free, DNS-only. If
Cloudflare's _DNS_ is down, fallback options are limited:

- Direct IP smoke test (the origin is publicly reachable, so this works even
  with CF entirely down): `curl -k --resolve sitelayer.sandolab.xyz:443:159.203.51.158 https://sitelayer.sandolab.xyz/health`.
- Because the record is already "DNS only", there is no proxy to bypass — if
  resolution itself is failing, the last resort is Cloudflare Registrar's
  "Change nameservers" (slow propagation).

**Comms:** "Our DNS provider (Cloudflare) is experiencing a global outage. Sitelayer's servers are healthy; access is blocked at name resolution until CF recovers."

### 4a. Open task — enable the Cloudflare proxy for WAF / origin-hiding

Today the prod origin (`159.203.51.158`, droplet `sitelayer`) is **publicly
exposed on 443** and Caddy terminates TLS directly; there is **no Cloudflare
WAF and no origin-hiding**. Flipping the `sitelayer` A record to proxied (orange
cloud) would put Cloudflare's edge (WAF, DDoS, bot mitigation, origin IP hidden)
in front of the droplet — but requires moving TLS to a CF "Full (strict)"
posture with the origin still reachable on 443 from CF, and validating that
rate-limit / real-IP handling (`CF-Connecting-IP`) is correct in the app. Track
as an operator security task; until then, do not write runbooks that assume a
Cloudflare WAF exists.

**Escalate:** none — Cloudflare Free has no support channel. Watch https://www.cloudflarestatus.com/.

---

## 5. Disk full on prod droplet

**Detect:** Sentry "ENOSPC", Caddy can't write logs, `docker compose up` fails.

**Mitigate:**

```bash
doctl compute ssh sitelayer
df -h                                      # /var, /app/backups, /var/lib/docker
docker system df
sudo journalctl --disk-usage

# Common culprits + fixes (run in order, stop when df -h shows headroom):
docker system prune -af --volumes                       # dangling images/containers/networks
sudo find /app/backups/postgres -mtime +30 -delete      # if backup retention drifted
docker compose -f /app/sitelayer/docker-compose.prod.yml logs --no-color > /dev/null  # forces rotate
sudo journalctl --vacuum-time=7d                        # systemd journal
```

**Investigate:** which volume grew? Compare `du -sh /var/lib/docker/* | sort -h`. If `/app/backups/postgres` is bloated, the retention env var on the systemd timer drifted — re-run `install-postgres-backup-systemd.sh` with `RETENTION_DAYS=30`.

**Escalate:** if `/var/lib/docker` is genuinely needed at >50GB, resize the droplet to a larger size (run `doctl compute size list | grep '^s-'` to see options; reboots required).

---

## 6. Cert renewal failure (Caddy / Let's Encrypt)

**Detect:** browser warning "NET::ERR_CERT_DATE_INVALID" on `sitelayer.sandolab.xyz`. Or `curl -v https://sitelayer.sandolab.xyz/health` shows expired cert.

**Mitigate:**

```bash
doctl compute ssh sitelayer
docker compose -f /app/sitelayer/docker-compose.prod.yml logs caddy --tail 200 | grep -iE 'error|tls|acme'
docker compose -f /app/sitelayer/docker-compose.prod.yml restart caddy
# If that doesn't work, force a re-issue:
docker compose -f /app/sitelayer/docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Common causes: rate-limited by LE (5 fails/hour) — wait an hour; the ACME
HTTP-01/TLS-ALPN challenge can't reach the origin on 80/443 — check `iptables -L`
and that the droplet is publicly reachable (Caddy terminates TLS directly; the CF
proxy is OFF, so there is no CF "Full (strict)" in the path today); A record
drifted off the reserved IP — `dig +short sitelayer.sandolab.xyz` should equal
`159.203.51.158`.

**Escalate:** Let's Encrypt rate-limit — wait. Persistent ACME challenge failure — open issue against Caddy.

---

## 7. Deploy stuck or failed

**Detect:** `scripts/deploy.sh prod` errored on the fleet box (the local gate failed, the build/push failed, or the on-droplet SSH step failed); or the fleet auto-deploy watcher logged a failed SHA. Deploys are local-fleet — there is no GitHub Actions run to inspect.

**Mitigate:**

```bash
# Inspect the deploy output on the fleet box that ran it (foreground stdout),
# or the auto-deploy watcher log for dev/demo:
tail -n 200 ~/.cache/sitelayer-autodeploy/auto-deploy.log

# App-only rollback to the previously deployed SHA. This assumes the schema is
# backward compatible with the previous app. If the failed deploy included a
# destructive migration, use docs/DR_RESTORE.md instead of rerunning migrations.
doctl compute ssh sitelayer --ssh-command="
  cd /app/sitelayer &&
  PRIOR_SHA=\$(cat .last_previous_deployed_sha) &&
  PRIOR_IMAGE=registry.digitalocean.com/sitelayer/sitelayer:\$PRIOR_SHA &&
  git fetch origin &&
  git reset --hard \$PRIOR_SHA &&
  (grep -q '^APP_IMAGE=' /app/sitelayer/.env &&
    sed -i \"s|^APP_IMAGE=.*|APP_IMAGE=\$PRIOR_IMAGE|\" /app/sitelayer/.env ||
    printf '\\nAPP_IMAGE=%s\\n' \"\$PRIOR_IMAGE\" >> /app/sitelayer/.env) &&
  APP_IMAGE=\$PRIOR_IMAGE docker compose -f docker-compose.prod.yml pull api web worker &&
  GIT_SHA=\$PRIOR_SHA APP_IMAGE=\$PRIOR_IMAGE docker compose -f docker-compose.prod.yml up -d --remove-orphans
"
curl -fsS https://sitelayer.sandolab.xyz/health
```

**Investigate:** deploys are **local-fleet** (`scripts/deploy.sh prod` →
`scripts/deploy-production-local.sh` from a fleet box) — there is **no GitHub
Actions runner** to check (`actions.runner.*` services were retired with the
Actions workflows). Look in this order:

- failed migration → `scripts/migrate-db.sh` output in the deploy stdout on the
  fleet box that ran `scripts/deploy.sh prod`;
- missing `.env` key → grep the deploy output for `ERROR:` (the prod deploy
  REUSES `/app/sitelayer/.env`; a missing key is an env-render gap, not a CI
  secret);
- dev/demo deploy failure → the fleet auto-deploy watcher log
  (`~/.cache/sitelayer-autodeploy/auto-deploy.log`) and the
  `scripts/fleet-auto-deploy.sh` systemd timer status on the fleet box.

**Escalate:** if rollback also fails (corrupt git state on droplet), nuke `/app/sitelayer/.git` and re-clone; `.env` survives because it's in the working tree, not git.

---

## 8. Compromised credential

**Detect:** unexpected Sentry alert from new IP, unfamiliar QBO sync events, GitHub security alert, or suspicion.

**Mitigate (immediate):**

1. **Identify class** of credential (Clerk session token? deploy SSH key? QBO? a runtime secret in `/app/sitelayer/.env`?).
2. **Revoke first, rotate second.** Don't wait for full rotation.
   - Clerk session compromise: Clerk dashboard → Users → revoke sessions for affected user.
   - Deploy SSH key exposed: the key lives on the **fleet box** (used by
     `scripts/deploy.sh prod` to SSH to the droplet) and in the droplet's
     `authorized_keys` — there is **no GitHub Actions secret store** to clear
     (the Actions workflows + `DEPLOY_SSH_KEY` GHA secret were removed; the repo
     runs zero workflows, so `gh secret remove` is a no-op). Kill the key at the
     droplet: `doctl compute ssh sitelayer --ssh-command='sudo -u sitelayer sed -i "/sitelayer-deploy/d" /home/sitelayer/.ssh/authorized_keys'`,
     then remove the private key from the fleet box and mint a new pair. Now the
     key is dead even if the attacker has it.
   - A runtime secret leaked from `/app/sitelayer/.env` (Spaces key, QBO,
     tokens): revoke at the provider (DO Console for Spaces/API tokens, Intuit
     dashboard for QBO), then rotate the value in `/app/sitelayer/.env` and
     bounce the affected container. The `.env` is the live source — there is no
     CI secret to update.
   - DO Spaces / API token: DO Console → revoke immediately.
3. Then run the full rotation procedure for that secret class — see `docs/SECRET_ROTATION.md`.

**Investigate:** check `/var/log/auth.log` on droplet for unauthorized SSH; Sentry events tagged with the suspicious IP; DO audit log via `doctl 1-click list` (limited but better than nothing).

**Comms:** if customer data may have been accessed, Canada's PIPEDA requires breach notification. Draft and send within 24 h.

**Escalate:** if escalation past single-maintainer is needed, this is when you'd loop in a security advisor — none retained as of 2026-04-24.
