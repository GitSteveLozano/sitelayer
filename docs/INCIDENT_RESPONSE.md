# Sitelayer Incident Response Runbook

**Audience:** on-call engineer (currently Taylor).
**Edge:** `sitelayer.sandolab.xyz` → Cloudflare DNS → reserved IP `159.203.51.158` → containerized Caddy → api/web/worker.
**Postgres:** managed `sitelayer-db` (`9948c96b-b6b6-45ad-adf7-d20e4c206c66`), Toronto `tor1`.
**Auth:** Clerk (Hobby).
**Errors:** Sentry org `sandolabs`, projects `sitelayer-api`, `sitelayer-web`, `sitelayer-worker`.

For each incident: **detect → mitigate → investigate → comms (when customers exist) → escalate**. Cutover steps assume you can SSH via `doctl compute ssh sitelayer`.

---

## On-call quick reference (memorize these)

```bash
doctl compute ssh sitelayer
docker compose -f /app/sitelayer/docker-compose.prod.yml ps
gh run watch -R GitSteveLozano/sitelayer
curl -fsS https://sitelayer.sandolab.xyz/health
docker compose -f /app/sitelayer/docker-compose.prod.yml logs --tail 200 -f api
```

---

## 1. 5xx error spike

**Detect:** Sentry alert "issue rate > 5/min" on `sitelayer-api`; or `/api/metrics` `http_requests_total{status=~"5.."}` rising.

**Mitigate (≤ 2 min):**
```bash
doctl compute ssh sitelayer
docker compose -f /app/sitelayer/docker-compose.prod.yml logs api --tail 200
docker compose -f /app/sitelayer/docker-compose.prod.yml ps
# If api is restarting hot:
docker compose -f /app/sitelayer/docker-compose.prod.yml restart api
```

**Investigate:** open the Sentry issue, copy the `request_id`, then:
```bash
curl -fsS -H "Authorization: Bearer $DEBUG_TRACE_TOKEN" \
  "https://sitelayer.sandolab.xyz/api/debug/traces/<trace_id>?by=request_id"
```
That joins the Sentry trace with `mutation_outbox` / `sync_events` rows.

Common causes: bad migration left a missing column → run `ENV_FILE=/app/sitelayer/.env scripts/check-db-schema.sh`; QBO sync looping on bad token → look for `scope=qbo_sync` errors; pg pool exhausted → look for `Error: timeout exceeded when trying to connect`.

**Comms (when customers exist):**
> We're investigating elevated errors on Sitelayer. The app may be slow or return errors for the next ~15 minutes. We'll post an update at <time>. — Taylor

**Escalate:** Sentry triage; if root cause is QBO connector, page Intuit dev support.

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

**Failover:** if the cluster is destroyed, follow `docs/DR_RESTORE.md` Procedure 2 (PITR fork).

**Comms:** "Our database provider is experiencing an outage. We're following their status page; data is safe (provider backups + nightly logical dumps)."

**Escalate:** DO support ticket, severity 1, attach cluster ID.

---

## 3. Clerk outage

**Detect:** every protected request returns 401 with `clerk verification unavailable` or `invalid signature`. Sign-in flow hangs.

**Behavior:** the API's `verifyClerkJwt` (apps/api/src/auth.ts) rejects requests when Clerk's signing keys can't be fetched/verified. Public paths (`/api/integrations/qbo/callback`, `/health`, `/api/metrics`) keep working. Everything else 401s.

**Mitigate:** there is no graceful degradation. Check https://status.clerk.com/. **Do not** flip `AUTH_ALLOW_HEADER_FALLBACK=1` in prod — that disables auth entirely.

**Comms:**
> Sign-in is currently unavailable due to a Clerk (our auth provider) outage. Already-authenticated sessions may continue to work for ~1 hour. Status: https://status.clerk.com/

**Escalate:** Clerk support, attach instance ID from dashboard.

---

## 4. Cloudflare outage (DNS / edge)

**Detect:** `dig sitelayer.sandolab.xyz` returns SERVFAIL or stale. Customers report `ERR_NAME_NOT_RESOLVED`.

**Mitigate:** four `sandolab.xyz` zones live on Cloudflare Free. If Cloudflare is down for DNS, fallback options are limited:
- Direct IP smoke test: `curl -k --resolve sitelayer.sandolab.xyz:443:159.203.51.158 https://sitelayer.sandolab.xyz/health`.
- If Cloudflare proxy is the issue (not DNS), set the `sitelayer` A record to "DNS only" (grey cloud) in CF dashboard; otherwise use Cloudflare Registrar's "Change nameservers" only as last resort (slow propagation).

**Comms:** "Cloudflare is experiencing a global outage. Sitelayer's servers are healthy; access is blocked at the edge until CF recovers."

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

Common causes: rate-limited by LE (5 fails/hour) — wait an hour; CF "Full (strict)" with origin not reachable on 443 — check `iptables -L`; A record drifted off the reserved IP — `dig +short sitelayer.sandolab.xyz` should equal `159.203.51.158`.

**Escalate:** Let's Encrypt rate-limit — wait. Persistent ACME challenge failure — open issue against Caddy.

---

## 7. Deploy stuck or failed

**Detect:** GitHub Actions workflow run red; or hung past 15-min `timeout-minutes`.

**Mitigate:**
```bash
gh run list -R GitSteveLozano/sitelayer --limit 5
gh run view <run-id> -R GitSteveLozano/sitelayer --log-failed

# Manual rollback to a known-good SHA:
PRIOR_SHA=$(gh run list -R GitSteveLozano/sitelayer --status success --limit 1 --json headSha --jq '.[0].headSha')
doctl compute ssh sitelayer --ssh-command="
  cd /app/sitelayer &&
  git fetch origin &&
  git reset --hard $PRIOR_SHA &&
  PSQL_DOCKER_IMAGE=postgres:18-alpine scripts/migrate-db.sh &&
  docker compose -f docker-compose.prod.yml up -d --build
"
curl -fsS https://sitelayer.sandolab.xyz/health
```

**Investigate:** failed migration → check `scripts/migrate-db.sh` output in run log; missing `.env` key → grep workflow for `ERROR:`; runner offline → `systemctl --user status actions.runner.GitSteveLozano-sitelayer.sitelayer-preview.service` on preview droplet.

**Escalate:** if rollback also fails (corrupt git state on droplet), nuke `/app/sitelayer/.git` and re-clone; `.env` survives because it's in the working tree, not git.

---

## 8. Compromised credential

**Detect:** unexpected Sentry alert from new IP, unfamiliar QBO sync events, GitHub security alert, or suspicion.

**Mitigate (immediate):**
1. **Identify class** of credential (Clerk session token? `DEPLOY_SSH_KEY`? QBO?).
2. **Revoke first, rotate second.** Don't wait for full rotation.
   - Clerk session compromise: Clerk dashboard → Users → revoke sessions for affected user.
   - `DEPLOY_SSH_KEY` exposed: `gh secret remove DEPLOY_SSH_KEY -R GitSteveLozano/sitelayer` AND `doctl compute ssh sitelayer --ssh-command='sudo -u sitelayer sed -i "/sitelayer-deploy/d" /home/sitelayer/.ssh/authorized_keys'`. Now the key is dead even if attacker has it.
   - DO Spaces / API token: DO Console → revoke immediately.
3. Then run the full rotation procedure for that secret class — see `docs/SECRET_ROTATION.md`.

**Investigate:** check `/var/log/auth.log` on droplet for unauthorized SSH; Sentry events tagged with the suspicious IP; DO audit log via `doctl 1-click list` (limited but better than nothing).

**Comms:** if customer data may have been accessed, Canada's PIPEDA requires breach notification. Draft and send within 24 h.

**Escalate:** if escalation past single-maintainer is needed, this is when you'd loop in a security advisor — none retained as of 2026-04-24.
