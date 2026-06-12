# Sitelayer Secret Rotation Runbook

**Cadence:** Quarterly (Jan / Apr / Jul / Oct, 1st Monday).
**Operator:** Taylor (single-maintainer).
**Scope:** every credential below in the order listed. Each section: what it grants → where it lives → rotation commands → verification.

> **DEPLOY MODEL UPDATED 2026-06-01.** Deploys are now local-fleet via
> `scripts/deploy.sh <prod|dev|demo>` — the GitHub Actions deploy workflows
> (`deploy-droplet.yml` etc.) were removed in commit `70b9584b`, and the
> prod deploy script **reuses** the existing `/app/sitelayer/.env` rather
> than re-uploading a freshly-rendered one. So `/app/sitelayer/.env` on the
> droplet is now the live production source of truth — rotate secrets by
> patching that file in place (the `doctl compute ssh` + `sed` flows below
> already do this) and bouncing the affected container. The steps that say
> `gh workflow run deploy-droplet.yml` no longer apply; re-deploy from the
> fleet with `scripts/deploy.sh prod` if a code/image-time rotation needs a
> new build.

Production source of truth: `/app/sitelayer/.env` on droplet `sitelayer` (`566798325`, reserved IP `159.203.51.158`, hostname `sitelayer.sandolab.xyz`). `ops/env/production.env.json` is the name/scope manifest used by `scripts/render-production-env.mjs` for the initial render.
Preview env file: `/app/previews/.env.shared` on droplet `sitelayer-preview` (`566806040`, reserved IP `159.203.53.218`).
Local dev secrets: `~/.env.local`.
GitHub repo: `GitSteveLozano/sitelayer`.

The production contract is `ops/env/production.env.json`. To rotate a production secret, patch `/app/sitelayer/.env` on the droplet in place (back up first, then recreate the affected container), and update the manifest entry in `ops/env/production.env.json` so a future re-render stays correct. `.env.example` documents names only; never commit secret values.

A successful deploy after rotation must end with `curl -fsS https://sitelayer.sandolab.xyz/health` returning 200 and `docker compose -f /app/sitelayer/docker-compose.prod.yml ps` showing `api`, `worker`, `web`, `caddy` all healthy.

For incident-time triage (revoke first, rotate second) see `docs/INCIDENT_RESPONSE.md` § 8 "Compromised credential".

---

## Inventory at a glance

| Secret                       | Stored                                                               | Mint via                                                    | If leaked → see |
| ---------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- | --------------- |
| Deploy SSH key               | Fleet box `~/.ssh/` + `/home/sitelayer/.ssh/authorized_keys` on prod | `ssh-keygen -t ed25519` on the fleet box                    | § 6             |
| Preview/dev/demo SSH key     | Fleet box `~/.ssh/` + preview droplet `authorized_keys`              | `ssh-keygen -t ed25519` on the fleet box                    | § 7             |
| `DEPLOY_HOST`                | `scripts/deploy-production-local.sh` default / env (hostname/IP)     | n/a — private VPC IP / DO reserved IP / hostname            | § 8             |
| `DIGITALOCEAN_ACCESS_TOKEN`  | `doctl` auth on the fleet box (`~/.config/doctl`)                    | DO Console → API → Tokens                                   | § 10            |
| `CLERK_SECRET_KEY`           | Reserved; not used by current API auth path                          | Clerk dashboard → Configure → API Keys                      | § 1             |
| `CLERK_JWT_KEY`              | `/app/sitelayer/.env` on the prod droplet                            | Clerk dashboard → API Keys → JWT public key (rotates rare)  | § 1             |
| `CLERK_WEBHOOK_SECRET`       | `/app/sitelayer/.env` on the prod droplet                            | Clerk dashboard → Webhooks                                  | § 1             |
| `VITE_CLERK_PUBLISHABLE_KEY` | Fleet build env (build-arg); baked into web image                    | Clerk dashboard → Frontend API                              | § 1             |
| `QBO_CLIENT_ID`              | `/app/sitelayer/.env` on the prod droplet                            | Intuit dev portal → app → Keys & OAuth                      | § 3             |
| `QBO_CLIENT_SECRET`          | `/app/sitelayer/.env` on the prod droplet                            | Intuit dev portal → Regenerate Client Secret                | § 3             |
| `QBO_STATE_SECRET`           | `/app/sitelayer/.env` on the prod droplet                            | `openssl rand -base64 32`                                   | § 3             |
| `ESTIMATE_SHARE_SECRET`      | `/app/sitelayer/.env` on the prod droplet                            | `openssl rand -base64 32`                                   | § 3a            |
| `SENTRY_AUTH_TOKEN`          | `~/.env.local` on the fleet box (build-time secret)                  | `sandolabs.sentry.io/settings/auth-tokens/`                 | § 2             |
| `SENTRY_DSN`                 | `/app/sitelayer/.env` on the prod droplet                            | Sentry project → Client Keys (Public DSN)                   | § 2             |
| `SENTRY_WORKER_DSN`          | `/app/sitelayer/.env` on the prod droplet                            | Sentry project → Client Keys (Public DSN)                   | § 2             |
| `VITE_SENTRY_DSN`            | Fleet build env (build-arg); baked into web image                    | Same DSN as `SENTRY_DSN` (web project)                      | § 2             |
| `DATABASE_URL`               | `/app/sitelayer/.env` on the prod droplet                            | DO managed Postgres → Connection Details → Reset password   | § 9             |
| `DATABASE_CA_CERT`           | `/app/sitelayer/.env` on the prod droplet (PEM CA bundle)            | DO managed Postgres → Connection Details → Download CA cert | § 9             |
| `DEBUG_TRACE_TOKEN`          | `/app/sitelayer/.env` on the prod droplet                            | `openssl rand -base64 32`                                   | § 5             |
| `API_METRICS_TOKEN`          | `/app/sitelayer/.env` on the prod droplet + Grafana                  | `openssl rand -base64 32`                                   | § 5             |
| `AGENT_FEED_TOKENS`          | `/app/sitelayer/.env` on the prod droplet                            | `openssl rand -base64 32` per audience                      | § 5             |
| `DO_SPACES_KEY` / `_SECRET`  | `/app/sitelayer/.env` on the prod droplet                            | DO Console → API → Spaces Keys                              | § 4             |
| `DO_SPACES_BUCKET`           | `/app/sitelayer/.env` on the prod droplet                            | DO Console → Spaces                                         | § 4             |

---

## 1. Clerk — `CLERK_JWT_KEY` / `CLERK_WEBHOOK_SECRET`

**Grants:** `CLERK_JWT_KEY` verifies browser session JWTs in `apps/api/src/auth.ts`; `CLERK_WEBHOOK_SECRET` verifies Svix-signed Clerk webhooks. Loss = auth verification or webhook trust risk.
**Stored in:** `/app/sitelayer/.env` for prod; never in repo.

```bash
# 1. In Clerk dashboard → API Keys → JWT public key, copy the new PEM if Clerk
#    forces a key rollover. For webhook rotation, create a new endpoint secret
#    under Clerk dashboard → Webhooks.

# 2. Patch prod env in place (atomic write).
doctl compute ssh sitelayer --ssh-command='
  sudo -u sitelayer bash -c "
    cp /app/sitelayer/.env /app/sitelayer/.env.bak.$(date -u +%Y%m%dT%H%M%SZ) &&
    sed -i \"s|^CLERK_JWT_KEY=.*|CLERK_JWT_KEY=NEW_PEM_VALUE|\" /app/sitelayer/.env
  "
'

# 3. Recreate api + worker (web does not read CLERK_JWT_KEY).
doctl compute ssh sitelayer --ssh-command='
  cd /app/sitelayer &&
  GIT_SHA=$(cat .last_successful_deployed_sha) \
    docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
'

# 4. Verify.
curl -fsS https://sitelayer.sandolab.xyz/health
# Then with a fresh signed-in user, exercise an authed endpoint:
curl -fsS -H "Authorization: Bearer $FRESH_CLERK_JWT" https://sitelayer.sandolab.xyz/api/companies

# 5. Revoke the old Clerk key/secret in the dashboard after verification.
```

`CLERK_SECRET_KEY` is currently reserved for future Clerk Backend API calls; the current API auth path does not use it. Do not rotate it as an auth fix unless Backend API usage is added.

**Frontend publishable key (`VITE_CLERK_PUBLISHABLE_KEY`)** is baked into the web bundle at image build time. It is _not_ a secret in the strict sense — it is shipped to every browser — but rotating it requires a new immutable image and deploy. Set the build value (e.g. in `ops/env/production.build.env` on the fleet, or as a `VITE_CLERK_PUBLISHABLE_KEY` build-arg env), then re-deploy from the fleet with `scripts/deploy.sh prod` so a fresh image is built.

> **2026-06-12 progress (agent session):** the `demo-tier` deletion was driven
> through the Clerk dashboard (delete modal confirmed, "never used" verified)
> but Clerk required step-up re-verification (account password) at the final
> step — only the operator can complete it. A dashboard tab was left open at
> that prompt on taylor-pc-ubuntu. `demo2` rotation not started (same step-up
> wall). All three actions below remain OPEN.

### 1a. Demo Clerk keys — OPEN actions (operator-pending, recorded 2026-06-12)

The demo tier mints prospect sign-in tokens with a Clerk **test**-instance
`CLERK_SECRET_KEY` stored in `/app/previews/.env.demo.shared` on the preview
droplet (see `docs/DEMO_ENVIRONMENT.md`). Audit state as of 2026-06-12 — all
three actions are **OPEN and operator-pending** (they need the Clerk dashboard
plus droplet access; nothing in-repo can execute them):

1. **Delete the unused demo-tier Clerk secret key.** A demo-tier key exists in
   the Clerk dashboard that nothing references — remove it to shrink the
   credential surface (Clerk dashboard → API Keys → revoke).
2. **Rotate the `demo2` key — it transited a transcript.** The `demo2` Clerk
   secret value passed through an agent transcript and must be treated as
   exposed: create a replacement key in the Clerk test instance, then revoke
   `demo2` (per `docs/INCIDENT_RESPONSE.md` §8: revoke first once the
   replacement is live).
3. **Update `/app/previews/.env.demo.shared`** with the replacement
   `CLERK_SECRET_KEY`, then bounce the demo stack so it re-reads the env:
   `cd /app/previews/demo && docker compose -p sitelayer-demo up -d --force-recreate`,
   and verify with `npm run demo:email -- --role owner --name "Smoke"` (or a
   `POST /api/demo/sign-in-link` call) that token minting still works.

When these are executed, mark each line done with the date here.

---

## 2. Sentry auth token — `SENTRY_AUTH_TOKEN`

**Grants:** sourcemap upload during the Vite build (`scripts/sentry-upload-sourcemaps.sh`), release tagging. Consumed at build time on the fleet (passed into `docker buildx build` as the `sentry_auth_token` build secret when `SENTRY_AUTH_TOKEN` is set — see `scripts/deploy-production-local.sh`).
**Stored in:** `~/.env.local` on the fleet box (and optionally `ops/env/production.build.env`).

```bash
# 1. https://sandolabs.sentry.io/settings/auth-tokens/ → "Create New Token"
#    Scopes: project:releases, org:read. Copy once.

# 2. Replace local (the fleet build reads it from the environment).
sed -i "s|^SENTRY_AUTH_TOKEN=.*|SENTRY_AUTH_TOKEN=sntrys_NEW|" ~/.env.local

# 3. Verify by re-deploying from the fleet and watching the build upload sourcemaps.
scripts/deploy.sh prod

# 4. In Sentry dashboard → revoke old token.
```

**`SENTRY_DSN` / `SENTRY_WORKER_DSN` / `VITE_SENTRY_DSN`** are public DSNs for the api, worker, and web projects. They are not auth-bearing on their own (rate-limited per-DSN, project-scoped). `SENTRY_WORKER_DSN` is optional; when blank, the worker falls back to `SENTRY_DSN`. Rotate DSNs only if you suspect nuisance event submission: Sentry project → Settings → Client Keys → "+ Generate New Key", then patch runtime `.env` for server DSNs and update the build variable/secret for `VITE_SENTRY_DSN`. `VITE_SENTRY_DSN` is build-time-baked, so it requires a new immutable image and deploy.

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
  cd /app/sitelayer && GIT_SHA=$(cat .last_successful_deployed_sha) \
    docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
'

# 4. Notify each connected customer; have them reconnect via Settings → Integrations.

# 5. Old secret auto-invalidates on Intuit side.
```

`QBO_STATE_SECRET` (signs OAuth state cookies) — rotate independently with `openssl rand -base64 32`.

> **⚠️ Rotating `QBO_STATE_SECRET` is NOT "drops in-flight OAuth only" unless
> `ESTIMATE_SHARE_SECRET` is set as its own value.** `ESTIMATE_SHARE_SECRET`
> falls back to `QBO_STATE_SECRET` when it is unset (see
> `apps/api/src/estimate-share-token.ts:resolveShareSecret`). So if prod is
> running on the fallback, rotating `QBO_STATE_SECRET` ALSO re-signs every
> public estimate/portal share link and **invalidates every outstanding
> customer share URL** — not just in-flight OAuth. To make
> `QBO_STATE_SECRET` rotation safe (in-flight OAuth only), give
> `ESTIMATE_SHARE_SECRET` its own value FIRST (see § 3a) so the two secrets
> are decoupled. With `ESTIMATE_SHARE_SECRET` set independently, rotating
> `QBO_STATE_SECRET` drops in-flight OAuth attempts only.

### 3a. Estimate share-link secret — `ESTIMATE_SHARE_SECRET`

**Grants:** signs the HMAC of public estimate share-link / client-portal
tokens (`apps/api/src/estimate-share-token.ts`). **Rotating this invalidates
every outstanding share link** — customers/recipients holding an old URL get a
404/invalid-token until a new link is issued. It is its OWN required prod secret
(`ops/env/production.env.json` marks it `required: true`); when unset the code
falls back to `QBO_STATE_SECRET`, which is the coupling the warning above is about.

```bash
# 1. Generate (only needed once to decouple from QBO_STATE_SECRET, or on rotation).
NEW_SHARE_SECRET=$(openssl rand -base64 32)

# 2. Patch prod env in place + recreate api.
doctl compute ssh sitelayer --ssh-command="
  sudo -u sitelayer bash -c '
    cp /app/sitelayer/.env /app/sitelayer/.env.bak.\$(date -u +%Y%m%dT%H%M%SZ) &&
    if grep -q ^ESTIMATE_SHARE_SECRET= /app/sitelayer/.env; then
      sed -i \"s|^ESTIMATE_SHARE_SECRET=.*|ESTIMATE_SHARE_SECRET=$NEW_SHARE_SECRET|\" /app/sitelayer/.env;
    else
      echo \"ESTIMATE_SHARE_SECRET=$NEW_SHARE_SECRET\" >> /app/sitelayer/.env;
    fi
  ' &&
  cd /app/sitelayer && GIT_SHA=\$(cat .last_successful_deployed_sha) \
    docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api
"

# 3. Verify the API booted without the fallback warning.
doctl compute ssh sitelayer --ssh-command='
  docker compose -f /app/sitelayer/docker-compose.prod.yml logs api --tail 200 | grep -i estimate-share || true
'
# A clean boot logs nothing here; the warning
#   "[estimate-share] ESTIMATE_SHARE_SECRET not set; falling back to QBO_STATE_SECRET"
# means it is STILL on the fallback (decoupling did not take).

# 4. Re-issue any share links you need recipients to keep using (old URLs are now dead).
```

`QBO_CLIENT_ID` is the Intuit-issued public client identifier. Not a secret in the cryptographic sense, but pairs with `QBO_CLIENT_SECRET` and is only re-issued when you create a new Intuit app. If you do that, update `.env` and recreate `api`.

---

## 4. DigitalOcean Spaces — `DO_SPACES_KEY` / `DO_SPACES_SECRET`

**Grants:** scoped read/write to `sitelayer-blueprints-prod`. Loss = blueprint exfiltration/modification for that bucket.

```bash
# 1. Create a new scoped Spaces key for bucket sitelayer-blueprints-prod
#    with read/write permission. Use DO Console or POST /v2/spaces/keys.

# 2. Replace in prod env.
doctl compute ssh sitelayer --ssh-command='
  sudo -u sitelayer sed -i \
    -e "s|^DO_SPACES_KEY=.*|DO_SPACES_KEY=NEW_KEY|" \
    -e "s|^DO_SPACES_SECRET=.*|DO_SPACES_SECRET=NEW_SECRET|" \
    /app/sitelayer/.env &&
  cd /app/sitelayer && GIT_SHA=$(cat .last_successful_deployed_sha) \
    docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
'

# 3. Verify upload path (will hit storage adapter at apps/api/src/storage.ts).
curl -fsS -H "Authorization: Bearer $JWT" -F file=@/tmp/test.pdf \
  https://sitelayer.sandolab.xyz/api/projects/<id>/blueprints

# 4. DO Console → revoke old key.
```

`DO_SPACES_BUCKET` is just the bucket name (`sitelayer-blueprints-prod`). Not a secret. Update only when you actually rename / recreate the bucket — and that requires a data migration, not a key rotation.

---

## 5. Internal API tokens — `DEBUG_TRACE_TOKEN` / `API_METRICS_TOKEN` / `AGENT_FEED_TOKENS`

**Grants:** `DEBUG_TRACE_TOKEN` unlocks `GET /api/debug/traces/:traceId` (Sentry trace proxy + queue join). `API_METRICS_TOKEN` unlocks `/api/metrics` (Prom scrape). Both are bearer-checked in `apps/api/src/server.ts`.
**Stored in:** `/app/sitelayer/.env` and Grafana scrape config.

```bash
# 1. Generate.
NEW_TOKEN=$(openssl rand -base64 32 | tr -d "=+/" | head -c 48)
echo "$NEW_TOKEN"

# 2. Patch prod.
doctl compute ssh sitelayer --ssh-command="
  sudo -u sitelayer sed -i 's|^API_METRICS_TOKEN=.*|API_METRICS_TOKEN=$NEW_TOKEN|' /app/sitelayer/.env &&
  cd /app/sitelayer && GIT_SHA=\$(cat .last_successful_deployed_sha) \
    docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api
"

# 3. Update Grafana scrape config (Authorization: Bearer ...) and reload.
# 4. Verify scrape returns 200 (not 401) at next interval.
curl -fsS -H "Authorization: Bearer $NEW_TOKEN" https://sitelayer.sandolab.xyz/api/metrics | head
```

Same pattern for `DEBUG_TRACE_TOKEN`. Both are random-bearers — no external system to revoke against; the rotation IS the revocation.

**`AGENT_FEED_TOKENS`** grants machine clients access to
`/api/agent-feed/*` for the audiences in its JSON map. A token only grants its
own audience, but leaked tokens let an agent pull assigned Concerns and fetch
authorized artifacts for that audience. Rotate per audience:

```bash
# 1. Generate a replacement token on the fleet box.
NEW_FEED_TOKEN=$(openssl rand -base64 32 | tr -d "=+/" | head -c 48)

# 2. Patch only the affected JSON key in /app/sitelayer/.env.
#    Replace NEW_FEED_TOKEN in a private shell before running; keep the real
#    JSON out of shared logs and tickets.
doctl compute ssh sitelayer --ssh-command='
  sudo -u sitelayer bash -c "
    cp /app/sitelayer/.env /app/sitelayer/.env.bak.$(date -u +%Y%m%dT%H%M%SZ) &&
    sed -i \"s|^AGENT_FEED_TOKENS=.*|AGENT_FEED_TOKENS={\\\"onsite-diagnostics\\\":\\\"NEW_FEED_TOKEN\\\"}|\" /app/sitelayer/.env
  "
'

# 3. Recreate api; worker/web do not read this variable.
doctl compute ssh sitelayer --ssh-command='
  cd /app/sitelayer && GIT_SHA=$(cat .last_successful_deployed_sha) \
    docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api
'

# 4. Update the pull executor's PULL_FEED_TOKEN, then verify the audience.
curl -fsS \
  -H "Authorization: Bearer $PULL_FEED_TOKEN" \
  "https://sitelayer.sandolab.xyz/api/agent-feed/concerns?audience=$PULL_AUDIENCE" \
  | jq '.concerns | length'
```

If `SITELAYER_OPS_DIAGNOSTIC_AGENT_AUDIENCE` points at the rotated audience,
restart the API after changing either variable and verify the Mobile Ops action
response reports `accepted_action.agent_feed.queued=true`.

---

## 6. Deploy SSH key — fleet → prod droplet

**Grants:** SSH as `sitelayer` on the production droplet, used by `scripts/deploy-production-local.sh` from the fleet box. Because the user is in the `docker` group, this is **production-root-equivalent**. Treat with extreme care.
**Stored in:** the SSH key on the fleet box that runs the deploy (e.g. `~/.ssh/`). Public half on the droplet at `/home/sitelayer/.ssh/authorized_keys`. (No longer a GitHub Actions secret — the Actions deploy was removed 2026-06-01.)

```bash
# 1. Generate new keypair on the trusted fleet box.
ssh-keygen -t ed25519 -f /tmp/sitelayer_deploy_$(date -u +%Y%m%d) -C "sitelayer-deploy" -N ""

# 2. Append new pubkey on droplet (DO NOT remove old yet).
doctl compute ssh sitelayer --ssh-command="
  sudo -u sitelayer bash -c 'cat >> /home/sitelayer/.ssh/authorized_keys' <<< \"$(cat /tmp/sitelayer_deploy_*.pub)\"
"

# 3. Install the new private key on the fleet box and confirm SSH lands.
install -m600 /tmp/sitelayer_deploy_$(date -u +%Y%m%d) ~/.ssh/sitelayer_deploy
ssh sitelayer@165.245.230.3 true && echo "ssh ok"

# 4. Run a deploy from the fleet and confirm it lands.
scripts/deploy.sh prod
curl -fsS https://sitelayer.sandolab.xyz/api/version

# 5. Once green, prune the old pubkey line from authorized_keys.
doctl compute ssh sitelayer --ssh-command="
  sudo -u sitelayer sed -i '/<old-key-fingerprint-comment>/d' /home/sitelayer/.ssh/authorized_keys
"

# 6. Shred the temp copy.
shred -u /tmp/sitelayer_deploy_*
```

If the key ever leaves the fleet box, treat it as **breach** — immediate rotation, audit `/var/log/auth.log` on the droplet, rotate every other prod secret in this doc.

---

## 7. Preview/dev/demo SSH key — fleet → preview droplet

Dev/demo deploys (`scripts/deploy.sh dev|demo`) and PR previews SSH to the preview droplet as `sitelayer`. This key lives on the fleet box; the legacy GitHub Actions `PREVIEW_SSH_KEY` secret and the self-hosted preview runner are no longer in the deploy path (removed 2026-06-01).

**Grants:** SSH as `sitelayer@159.203.53.218` (preview droplet `566806040`). Same `docker`-group blast radius as the prod deploy key, scoped to the preview droplet only. Public half on droplet at `/home/sitelayer/.ssh/authorized_keys`.

```bash
# 1. Generate new keypair on a trusted local machine.
ssh-keygen -t ed25519 -f /tmp/sitelayer_preview_$(date -u +%Y%m%d) -C "sitelayer-preview-deploy" -N ""

# 2. Append new pubkey on preview droplet (don't remove old yet).
doctl compute ssh sitelayer-preview --ssh-command="
  sudo -u sitelayer bash -c 'cat >> /home/sitelayer/.ssh/authorized_keys' <<< \"$(cat /tmp/sitelayer_preview_*.pub)\"
"

# 3. Prune old pubkey after verifying manual SSH still works with the new key.
doctl compute ssh sitelayer-preview --ssh-command="
  sudo -u sitelayer sed -i '/<old-key-fingerprint-comment>/d' /home/sitelayer/.ssh/authorized_keys
"

# 4. Shred local copies.
shred -u /tmp/sitelayer_preview_*
```

Treat this key at high severity: a compromised preview droplet shares a private VPC with prod and holds non-prod customer-shaped data. (Historically the preview droplet also hosted the self-hosted GH Actions deploy runner; that runner is no longer in the deploy path.)

---

## 8. `DEPLOY_HOST` — hostname/IP (not really a secret)

**Grants:** nothing on its own — just the IP/hostname the deploy script targets. Listed for completeness.

**Stored in:** the `DEPLOY_HOST` env (or the default in `scripts/deploy-production-local.sh`, currently `165.245.230.3`). Preview/dev/demo hosts are derived from slug + `preview.sitelayer.sandolab.xyz` / set in `scripts/deploy.sh`.

**When to update:** only if the droplet IP changes (resize, reprovision, reserved-IP swap). Then update the `DEPLOY_HOST` default/env on the fleet (prefer the reserved IP `159.203.51.158`, which survives droplet replacement).

If exposed → no action required. It is public-DNS-discoverable already.

---

## 9. `DATABASE_URL` — managed Postgres connection string

**Grants:** read/write on the production database. Total compromise of customer data.
**Stored in:** `/app/sitelayer/.env` (prod), `/app/previews/.env.shared` (preview, separate `sitelayer_preview` db), `~/.env.local` (dev, points at `sitelayer_dev`).

The string embeds the password for the per-tier app user, for example `sitelayer_prod_app`, `sitelayer_preview_app`, or `sitelayer_dev_app`. Rotation = reset the affected tier's app-user password in DO and patch the matching `.env`.

```bash
# 1. DO Console → Databases → sitelayer-db → Users & Databases → reset password
#    for the affected app user. Or:
doctl databases user reset 9948c96b-b6b6-45ad-adf7-d20e4c206c66 sitelayer_prod_app

# 2. Pull the new connection string.
doctl databases connection 9948c96b-b6b6-45ad-adf7-d20e4c206c66 --format URI

# 3. Patch prod env.
doctl compute ssh sitelayer --ssh-command='
  sudo -u sitelayer sed -i "s|^DATABASE_URL=.*|DATABASE_URL=NEW_URL|" /app/sitelayer/.env &&
  cd /app/sitelayer && GIT_SHA=$(cat .last_successful_deployed_sha) \
    docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
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

**`DATABASE_CA_CERT` — managed Postgres TLS CA bundle.** Not a credential
(it's a public certificate), but it belongs to this section because it gates
verified TLS to the DB. When `DATABASE_CA_CERT` is set, the pg client verifies
the managed-PG server cert against it (`ssl: { ca, rejectUnauthorized: true }`),
so `DATABASE_SSL_REJECT_UNAUTHORIZED=false` is no longer required. Prefer this
over `DATABASE_SSL_REJECT_UNAUTHORIZED=false`. Refresh it only when DigitalOcean
rotates the cluster CA (rare, announced) — download from DO Console → Databases →
sitelayer-db → Connection Details → Download CA certificate, then patch
`/app/sitelayer/.env` (the value may be a single line with `\n`-escaped PEM
newlines) and recreate `api` + `worker`. There is no secret to revoke.

> Wiring note: `resolveDatabaseSslConfig()` in `packages/config` computes the
> pg `ssl` shape from `DATABASE_CA_CERT` / `DATABASE_SSL_REJECT_UNAUTHORIZED`.
> The pg `Pool` builders in `apps/api/src/server.ts` and
> `apps/worker/src/worker.ts` still read `DATABASE_SSL_REJECT_UNAUTHORIZED`
> directly; finishing the CA path means routing those builders through the
> helper (TODO tracked in the helper's doc comment).

---

## 10. `DIGITALOCEAN_ACCESS_TOKEN` — registry/deploy automation token

**Grants:** DigitalOcean API access used by `doctl` on the fleet box (`doctl registry login`) to mint registry Docker credentials and push/pull immutable images in the `sitelayer` registry, plus the registry-tag pruning the prod deploy script runs.
**Stored in:** the `doctl` auth context on the fleet box (`~/.config/doctl`).

```bash
# 1. DO Console → API → Tokens → Generate New Token.
#    Scope it to the minimum project/registry permissions DigitalOcean supports
#    for registry push/pull and deploy automation.

# 2. Re-auth doctl on the fleet box with the new token.
doctl auth init   # paste the new dop_v1_... token
doctl registry login

# 3. Re-deploy from the fleet and verify.
scripts/deploy.sh prod
curl -fsS https://sitelayer.sandolab.xyz/api/version

# 4. Revoke the old token in the DO Console.
```

---

## Calendar reminder template

Paste into Google Calendar, recurring **first Monday of Jan/Apr/Jul/Oct, 09:00 ET**:

```
Title: Sitelayer secret rotation
Duration: 60 min
Body:
  Run docs/SECRET_ROTATION.md sections 1-10 in order.
  Pre-flight: on the prod droplet, grep -c '=' /app/sitelayer/.env and back it up
  Post-flight: curl -fsS https://sitelayer.sandolab.xyz/health
  Log result in mesh: mcp__mesh__add_planning_note project=sitelayer
```
