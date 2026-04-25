# Sitelayer Secret Rotation Runbook

**Cadence:** Quarterly (Jan / Apr / Jul / Oct, 1st Monday).
**Operator:** Taylor (single-maintainer).
**Scope:** every credential below in the order listed. Each section: what it grants → where it lives → rotation commands → verification.

Production env file: `/app/sitelayer/.env` on droplet `sitelayer` (`566798325`, reserved IP `159.203.51.158`, MagicDNS-equivalent `sitelayer.sandolab.xyz`).
Local dev secrets: `~/.env.local`.
GitHub repo: `GitSteveLozano/sitelayer`.

A successful deploy after rotation must end with `curl -fsS https://sitelayer.sandolab.xyz/health` returning 200 and `docker compose -f /app/sitelayer/docker-compose.prod.yml ps` showing `api`, `worker`, `web`, `caddy` all healthy.

---

## 1. Clerk — `CLERK_SECRET_KEY` / `CLERK_JWT_KEY`

**Grants:** server-side verification of Clerk JWTs, user lookups via Clerk Backend API. Loss = full auth bypass risk.
**Stored in:** `/app/sitelayer/.env` (prod `sk_live_*`); `~/.env.local` (dev `sk_test_*`); never in repo.

```bash
# 1. In Clerk dashboard → Configure → API Keys → "Create new secret key"
#    Choose "Backend (server-side)". Copy sk_live_... (prod) or sk_test_... (dev).

# 2. Patch prod env in place (atomic write).
doctl compute ssh sitelayer --ssh-command='
  sudo -u sitelayer bash -c "
    cp /app/sitelayer/.env /app/sitelayer/.env.bak.$(date -u +%Y%m%dT%H%M%SZ) &&
    sed -i \"s|^CLERK_SECRET_KEY=.*|CLERK_SECRET_KEY=sk_live_NEW_VALUE|\" /app/sitelayer/.env
  "
'

# 3. Recreate api + worker (web does not read CLERK_SECRET_KEY).
doctl compute ssh sitelayer --ssh-command='
  cd /app/sitelayer &&
  docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
'

# 4. Verify.
curl -fsS https://sitelayer.sandolab.xyz/health
# Then with a fresh signed-in user, exercise an authed endpoint:
curl -fsS -H "Authorization: Bearer $FRESH_CLERK_JWT" https://sitelayer.sandolab.xyz/api/companies

# 5. In Clerk dashboard → revoke old sk_live_* key.
```

**JWT verification key (`CLERK_JWT_KEY`)** rotates only when Clerk forces a rollover. Pull the new PEM from Clerk → API Keys → "JWT public key", same `sed -i` pattern, restart api.

---

## 2. Sentry auth token — `SENTRY_AUTH_TOKEN`

**Grants:** sourcemap upload during Vite build (`scripts/sentry-upload-sourcemaps.sh`), release tagging.
**Stored in:** `~/.env.local` and GitHub Actions secret `SENTRY_AUTH_TOKEN` (if used by quality.yml or release builds).

```bash
# 1. https://sandolabs.sentry.io/settings/auth-tokens/ → "Create New Token"
#    Scopes: project:releases, org:read. Copy once.

# 2. Replace local.
sed -i "s|^SENTRY_AUTH_TOKEN=.*|SENTRY_AUTH_TOKEN=sntrys_NEW|" ~/.env.local

# 3. Replace GitHub Actions secret (if present — check first).
gh secret list -R GitSteveLozano/sitelayer | grep SENTRY_AUTH_TOKEN
gh secret set SENTRY_AUTH_TOKEN -R GitSteveLozano/sitelayer --body "sntrys_NEW"

# 4. Verify by triggering a no-op push to main and watching the deploy upload sourcemaps.
gh run watch -R GitSteveLozano/sitelayer

# 5. In Sentry dashboard → revoke old token.
```

---

## 3. QBO — `QBO_CLIENT_SECRET`

**Grants:** Intuit OAuth token exchange. **Rotating this invalidates every connected customer's QBO connection** — every company with `integration_connections.status='connected'` will need to re-run the OAuth flow at `/api/integrations/qbo/auth`.

Currently empty/placeholder in prod (`grep ^QBO_CLIENT_SECRET= /app/sitelayer/.env` → empty). Skip until Intuit prod creds are provisioned.

```bash
# 1. https://developer.intuit.com/app/developer/myapps → app → Keys & OAuth →
#    Production keys → "Regenerate Client Secret".

# 2. Test against sandbox first.
sed -i "s|^QBO_CLIENT_SECRET=.*|QBO_CLIENT_SECRET=NEW_VALUE|" ~/.env.local
# Run sandbox OAuth e2e from local: npm run -w apps/api dev, then visit /api/integrations/qbo/auth.

# 3. Patch prod, restart api.
doctl compute ssh sitelayer --ssh-command='
  sudo -u sitelayer sed -i "s|^QBO_CLIENT_SECRET=.*|QBO_CLIENT_SECRET=NEW_VALUE|" /app/sitelayer/.env &&
  cd /app/sitelayer && docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
'

# 4. Notify each connected customer; have them reconnect via Settings → Integrations.

# 5. Old secret auto-invalidates on Intuit side.
```

`QBO_STATE_SECRET` (signs OAuth state cookies) — rotate independently with `openssl rand -base64 32`. Drops in-flight OAuth attempts only.

---

## 4. DigitalOcean Spaces — `DO_SPACES_KEY` / `DO_SPACES_SECRET`

**Grants:** read/write to `sitelayer-blueprints-prod` (and dev/preview). Loss = blueprint exfiltration.
**Currently empty placeholders.** When populated:

```bash
# 1. DO Console → API → Spaces Keys → "Generate New Key" (label: sitelayer-prod-YYYYMMDD).
#    Or: doctl spaces (not yet supported in doctl; use API or console).

# 2. Replace in prod env.
doctl compute ssh sitelayer --ssh-command='
  sudo -u sitelayer sed -i \
    -e "s|^DO_SPACES_KEY=.*|DO_SPACES_KEY=NEW_KEY|" \
    -e "s|^DO_SPACES_SECRET=.*|DO_SPACES_SECRET=NEW_SECRET|" \
    /app/sitelayer/.env &&
  cd /app/sitelayer && docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
'

# 3. Verify upload path (will hit storage adapter at apps/api/src/storage.ts).
curl -fsS -H "Authorization: Bearer $JWT" -F file=@/tmp/test.pdf \
  https://sitelayer.sandolab.xyz/api/projects/<id>/blueprints

# 4. DO Console → revoke old key.
```

---

## 5. Internal API tokens — `DEBUG_TRACE_TOKEN` / `API_METRICS_TOKEN`

**Grants:** `DEBUG_TRACE_TOKEN` unlocks `GET /api/debug/traces/:traceId` (Sentry trace proxy + queue join). `API_METRICS_TOKEN` unlocks `/api/metrics` (Prom scrape). Both are bearer-checked in `apps/api/src/server.ts`.
**Stored in:** `/app/sitelayer/.env` and Grafana scrape config.

```bash
# 1. Generate.
NEW_TOKEN=$(openssl rand -base64 32 | tr -d "=+/" | head -c 48)
echo "$NEW_TOKEN"

# 2. Patch prod.
doctl compute ssh sitelayer --ssh-command="
  sudo -u sitelayer sed -i 's|^API_METRICS_TOKEN=.*|API_METRICS_TOKEN=$NEW_TOKEN|' /app/sitelayer/.env &&
  cd /app/sitelayer && docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api
"

# 3. Update Grafana scrape config (Authorization: Bearer ...) and reload.
# 4. Verify scrape returns 200 (not 401) at next interval.
curl -fsS -H "Authorization: Bearer $NEW_TOKEN" https://sitelayer.sandolab.xyz/api/metrics | head
```

Same pattern for `DEBUG_TRACE_TOKEN`. Both are random-bearers — no external system to revoke against; the rotation IS the revocation.

---

## 6. `DEPLOY_SSH_KEY` — GitHub Actions deploy key

**Grants:** SSH as `sitelayer@165.245.230.3`. Because the user is in the `docker` group, this is **production-root-equivalent**. Treat with extreme care.
**Stored in:** GitHub Actions secret `DEPLOY_SSH_KEY` only. Public half on droplet at `/home/sitelayer/.ssh/authorized_keys`.

```bash
# 1. Generate new keypair on a trusted local machine (NOT in the deploy runner).
ssh-keygen -t ed25519 -f /tmp/sitelayer_deploy_$(date -u +%Y%m%d) -C "sitelayer-deploy" -N ""

# 2. Append new pubkey on droplet (DO NOT remove old yet).
doctl compute ssh sitelayer --ssh-command="
  sudo -u sitelayer bash -c 'cat >> /home/sitelayer/.ssh/authorized_keys' <<< \"$(cat /tmp/sitelayer_deploy_*.pub)\"
"

# 3. Replace GH secret with new private key.
gh secret set DEPLOY_SSH_KEY -R GitSteveLozano/sitelayer < /tmp/sitelayer_deploy_$(date -u +%Y%m%d)

# 4. Trigger a dry-run deploy and confirm it lands.
gh workflow run deploy-droplet.yml -R GitSteveLozano/sitelayer
gh run watch -R GitSteveLozano/sitelayer

# 5. Once green, prune the old pubkey line from authorized_keys.
doctl compute ssh sitelayer --ssh-command="
  sudo -u sitelayer sed -i '/<old-key-fingerprint-comment>/d' /home/sitelayer/.ssh/authorized_keys
"

# 6. Shred local copies.
shred -u /tmp/sitelayer_deploy_*
```

If the key ever leaves the GH secrets store, treat it as **breach** — immediate rotation, audit `/var/log/auth.log` on the droplet, rotate every other prod secret in this doc.

---

## Calendar reminder template

Paste into Google Calendar, recurring **first Monday of Jan/Apr/Jul/Oct, 09:00 ET**:

```
Title: Sitelayer secret rotation
Duration: 60 min
Body:
  Run docs/SECRET_ROTATION.md sections 1-6 in order.
  Pre-flight: gh secret list -R GitSteveLozano/sitelayer
  Post-flight: curl -fsS https://sitelayer.sandolab.xyz/health
  Log result in mesh: mcp__mesh__add_planning_note project=sitelayer
```
