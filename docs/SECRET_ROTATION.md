# Sitelayer Secret Rotation Runbook

**Cadence:** Quarterly (Jan / Apr / Jul / Oct, 1st Monday).
**Operator:** Taylor (single-maintainer).
**Scope:** every credential below in the order listed. Each section: what it grants → where it lives → rotation commands → verification.

Production env file: `/app/sitelayer/.env` on droplet `sitelayer` (`566798325`, reserved IP `159.203.51.158`, MagicDNS-equivalent `sitelayer.sandolab.xyz`).
Preview env file: `/app/previews/.env.shared` on droplet `sitelayer-preview` (`566806040`, reserved IP `159.203.53.218`).
Local dev secrets: `~/.env.local`.
GitHub repo: `GitSteveLozano/sitelayer`.

A successful deploy after rotation must end with `curl -fsS https://sitelayer.sandolab.xyz/health` returning 200 and `docker compose -f /app/sitelayer/docker-compose.prod.yml ps` showing `api`, `worker`, `web`, `caddy` all healthy.

For incident-time triage (revoke first, rotate second) see `docs/INCIDENT_RESPONSE.md` § 8 "Compromised credential".

---

## Inventory at a glance

| Secret                          | Stored                                                | Mint via                                                  | If leaked → see |
|---------------------------------|-------------------------------------------------------|-----------------------------------------------------------|-----------------|
| `DEPLOY_SSH_KEY`                | GitHub repo secret + `/home/sitelayer/.ssh/authorized_keys` on prod | `ssh-keygen -t ed25519` on trusted local                   | § 6 |
| `PREVIEW_SSH_KEY`               | GitHub repo secret + authorized_keys on preview droplet | `ssh-keygen -t ed25519` on trusted local                   | § 7 |
| `DEPLOY_HOST` / `PREVIEW_HOST`  | GitHub repo secret (hostname-only, not really a secret) | n/a — DO reserved IP / hostname                            | § 8 |
| `CLERK_SECRET_KEY`              | `/app/sitelayer/.env` (prod) + `~/.env.local` (dev)   | Clerk dashboard → Configure → API Keys                    | § 1 |
| `CLERK_JWT_KEY`                 | `/app/sitelayer/.env`                                 | Clerk dashboard → API Keys → JWT public key (rotates rare) | § 1 |
| `VITE_CLERK_PUBLISHABLE_KEY`    | `/app/sitelayer/.env` baked into web build            | Clerk dashboard → Frontend API                            | § 1 |
| `QBO_CLIENT_ID`                 | `/app/sitelayer/.env`                                 | Intuit dev portal → app → Keys & OAuth                    | § 3 |
| `QBO_CLIENT_SECRET`             | `/app/sitelayer/.env` (currently empty in prod)       | Intuit dev portal → Regenerate Client Secret              | § 3 |
| `QBO_STATE_SECRET`              | `/app/sitelayer/.env`                                 | `openssl rand -base64 32`                                 | § 3 |
| `SENTRY_AUTH_TOKEN`             | `~/.env.local` + GitHub Actions secret                | `sandolabs.sentry.io/settings/auth-tokens/`               | § 2 |
| `SENTRY_DSN`                    | `/app/sitelayer/.env`                                 | Sentry project → Client Keys (Public DSN)                 | § 2 |
| `VITE_SENTRY_DSN`               | `/app/sitelayer/.env` baked into web build            | Same DSN as `SENTRY_DSN` (web project)                    | § 2 |
| `DATABASE_URL`                  | `/app/sitelayer/.env`                                 | DO managed Postgres → Connection Details → Reset password | § 9 |
| `DEBUG_TRACE_TOKEN`             | `/app/sitelayer/.env`                                 | `openssl rand -base64 32`                                 | § 5 |
| `API_METRICS_TOKEN`             | `/app/sitelayer/.env` + Grafana scrape config         | `openssl rand -base64 32`                                 | § 5 |
| `DO_SPACES_KEY` / `_SECRET`     | `/app/sitelayer/.env` (planned, blank in prod today)  | DO Console → API → Spaces Keys                            | § 4 |
| `DO_SPACES_BUCKET`              | `/app/sitelayer/.env` (hostname-only, not a secret)   | DO Console → Spaces                                       | § 4 |

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

**Frontend publishable key (`VITE_CLERK_PUBLISHABLE_KEY`)** is baked into the web bundle at build time (see `docker-compose.prod.yml`). It is *not* a secret in the strict sense — it is shipped to every browser — but rotating it requires a rebuild + redeploy. Update the prod `.env`, then `docker compose ... up -d --build web` so Vite re-bakes the new value into `dist/`.

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

**`SENTRY_DSN` / `VITE_SENTRY_DSN`** are public DSNs for the api/worker and web projects. They are not auth-bearing on their own (rate-limited per-DSN, project-scoped). Rotate only if you suspect they're being abused for nuisance event submission: Sentry project → Settings → Client Keys → "+ Generate New Key", then `sed -i` patch both `.env` entries and rebuild web. `VITE_SENTRY_DSN` is build-time-baked, so requires `docker compose ... up -d --build web`.

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

`QBO_CLIENT_ID` is the Intuit-issued public client identifier. Not a secret in the cryptographic sense, but pairs with `QBO_CLIENT_SECRET` and is only re-issued when you create a new Intuit app. If you do that, update `.env` and recreate `api`.

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

`DO_SPACES_BUCKET` is just the bucket name (`sitelayer-blueprints-prod`). Not a secret. Update only when you actually rename / recreate the bucket — and that requires a data migration, not a key rotation.

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

## 7. `PREVIEW_SSH_KEY` — preview droplet deploy key

**Grants:** SSH as `sitelayer@159.203.53.218` (preview droplet `566806040`). Same `docker`-group blast radius as `DEPLOY_SSH_KEY`, scoped to preview only. Public half on droplet at `/home/sitelayer/.ssh/authorized_keys`.

**Stored in:** GitHub Actions secret `PREVIEW_SSH_KEY` only.

```bash
# 1. Generate new keypair on a trusted local machine.
ssh-keygen -t ed25519 -f /tmp/sitelayer_preview_$(date -u +%Y%m%d) -C "sitelayer-preview-deploy" -N ""

# 2. Append new pubkey on preview droplet (don't remove old yet).
doctl compute ssh sitelayer-preview --ssh-command="
  sudo -u sitelayer bash -c 'cat >> /home/sitelayer/.ssh/authorized_keys' <<< \"$(cat /tmp/sitelayer_preview_*.pub)\"
"

# 3. Replace GH secret.
gh secret set PREVIEW_SSH_KEY -R GitSteveLozano/sitelayer < /tmp/sitelayer_preview_$(date -u +%Y%m%d)

# 4. Trigger a preview deploy and confirm.
gh workflow run deploy-preview.yml -R GitSteveLozano/sitelayer
gh run watch -R GitSteveLozano/sitelayer

# 5. Prune old pubkey.
doctl compute ssh sitelayer-preview --ssh-command="
  sudo -u sitelayer sed -i '/<old-key-fingerprint-comment>/d' /home/sitelayer/.ssh/authorized_keys
"

# 6. Shred local copies.
shred -u /tmp/sitelayer_preview_*
```

The preview droplet also hosts the self-hosted GH Actions runner that runs the production deploy workflow. **Compromise of this key potentially exposes prod through the runner**, so treat at the same severity as `DEPLOY_SSH_KEY`.

---

## 8. `DEPLOY_HOST` / `PREVIEW_HOST` — hostnames (not really secrets)

**Grants:** nothing on their own — these are just IPs/hostnames the deploy workflows read. Listed here for completeness so the rotation checklist accounts for every `gh secret` row.

**Stored in:** GitHub Actions secrets `DEPLOY_HOST` (reserved IP `159.203.51.158` or domain `sitelayer.sandolab.xyz`) and `PREVIEW_HOST` (`159.203.53.218` or `sitelayer-preview.sandolab.xyz`).

**When to update:** only if the droplet IP changes (resize, reprovision, reserved-IP swap). Then:

```bash
gh secret set DEPLOY_HOST  -R GitSteveLozano/sitelayer --body "<new>"
gh secret set PREVIEW_HOST -R GitSteveLozano/sitelayer --body "<new>"
```

If exposed → no action required. They are public-DNS-discoverable already.

---

## 9. `DATABASE_URL` — managed Postgres connection string

**Grants:** read/write on the production database. Total compromise of customer data.
**Stored in:** `/app/sitelayer/.env` (prod), `/app/previews/.env.shared` (preview, separate `sitelayer_preview` db), `~/.env.local` (dev, points at `sitelayer_dev`).

The string embeds the password for the `sitelayer` Postgres user. Rotation = reset that user's password in DO and patch every `.env`.

```bash
# 1. DO Console → Databases → sitelayer-db → Users & Databases → reset password
#    for the `sitelayer` user. Or:
doctl databases user reset 9948c96b-b6b6-45ad-adf7-d20e4c206c66 sitelayer

# 2. Pull the new connection string.
doctl databases connection 9948c96b-b6b6-45ad-adf7-d20e4c206c66 --format URI

# 3. Patch prod env.
doctl compute ssh sitelayer --ssh-command='
  sudo -u sitelayer sed -i "s|^DATABASE_URL=.*|DATABASE_URL=NEW_URL|" /app/sitelayer/.env &&
  cd /app/sitelayer && docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
'

# 4. Patch preview env (separate db).
doctl compute ssh sitelayer-preview --ssh-command='
  sudo -u sitelayer sed -i "s|^DATABASE_URL=.*|DATABASE_URL=NEW_URL|" /app/previews/.env.shared
'

# 5. Verify.
curl -fsS https://sitelayer.sandolab.xyz/health
docker compose -f /app/sitelayer/docker-compose.prod.yml logs api --tail 100 | grep -i 'database\|pg'
```

**Trusted-sources gate.** The DO managed Postgres firewall only accepts connections from droplets `566798325` and `566806040`. Even if the URL leaks, an attacker can't connect from outside DO without also pivoting through one of those droplets. Don't relax that.

If leaked, follow `docs/INCIDENT_RESPONSE.md` § 8 first (revoke), then this section (rotate).

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
