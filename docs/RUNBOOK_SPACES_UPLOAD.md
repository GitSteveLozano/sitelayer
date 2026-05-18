# Runbook — DigitalOcean Spaces Upload Failure

**When to read this:** blueprint uploads are returning 500s, customers can't
upload PDFs, and API logs reference `Failed to upload to Spaces` or
S3-flavored errors.

**Related code:** `apps/api/src/storage.ts` (storage selector),
`apps/api/src/blueprint-upload.ts` (streaming multipart path).

## Symptom

- `POST /api/projects/:id/blueprints` returns 500.
- API logs show `Failed to upload to Spaces`, `SignatureDoesNotMatch`,
  `InvalidAccessKeyId`, or `AccessDenied` from the `@aws-sdk/client-s3`
  layer.
- Sentry `sitelayer-api` shows `S3ServiceException` issues.
- Existing blueprints still _download_ fine (presigned URLs minted before
  the credential rotation stay valid until their TTL expires).

## Detection

- **API logs:**

  ```bash
  doctl compute ssh sitelayer --ssh-command="
    docker compose -f /app/sitelayer/docker-compose.prod.yml logs api --tail 200 | \
      grep -iE 'spaces|S3|upload|blueprint'
  "
  ```

- **DO Spaces dashboard:**
  https://cloud.digitalocean.com/spaces — open the
  `sitelayer-blueprints-prod` bucket. Recent activity tab shows whether
  PUTs are landing. If the bucket is gone or returns 404, you have a
  different incident — see `docs/DR_RESTORE.md`.

- **Spaces status:**
  https://status.digitalocean.com/ — filter to Spaces in your region
  (Toronto / `tor1`).

## Common causes

1. **`DO_SPACES_KEY` / `DO_SPACES_SECRET` rotated without an env
   update** — most common. DO Spaces keys are scoped and have no built-in
   rotation overlap; a rotation in the console invalidates the old key
   immediately. The render workflow needs to be re-run to write the new
   value into `/app/sitelayer/.env`.
2. **Bucket policy changed** — someone tightened the CORS or
   read/write policy in the DO console; the scoped key no longer has
   the permissions the SDK needs.
3. **Region / endpoint drift** — `DO_SPACES_REGION` (default `tor1`)
   doesn't match `DO_SPACES_ENDPOINT`. SDK signs against the configured
   region; mismatch returns `SignatureDoesNotMatch`.
4. **Spaces outage in region** — rare, but check the status page first;
   if Spaces is degraded in `tor1`, no amount of credential dancing
   helps. See **Fallback** below.

## Diagnosis

```bash
# 1. Are the env values present at all on the droplet?
ssh sitelayer@10.118.0.4 \
  "grep -E '^DO_SPACES_(KEY|SECRET|REGION|ENDPOINT|BUCKET)=' /app/sitelayer/.env | \
   sed 's/SECRET=.*/SECRET=***/; s/KEY=.*/KEY=***/'"

# 2. Smoke the credential outside the API — quickest way to confirm
#    rotation drift. Run from the droplet so the network shape matches.
doctl compute ssh sitelayer --ssh-command="
  docker run --rm -it \
    -e AWS_ACCESS_KEY_ID=\"\$(grep ^DO_SPACES_KEY= /app/sitelayer/.env | cut -d= -f2-)\" \
    -e AWS_SECRET_ACCESS_KEY=\"\$(grep ^DO_SPACES_SECRET= /app/sitelayer/.env | cut -d= -f2-)\" \
    amazon/aws-cli:latest \
    --endpoint-url https://tor1.digitaloceanspaces.com \
    s3 ls s3://sitelayer-blueprints-prod/ --summarize
"
# Expected: a recent ls output. SignatureDoesNotMatch / InvalidAccessKeyId
# = credentials are wrong on the droplet.
```

## Mitigation (in order)

1. **Re-render the production env via GitHub Actions** — this pulls fresh
   secret values from the `production` environment and writes a new
   `/app/sitelayer/.env`:

   ```bash
   gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
   gh run watch -R GitSteveLozano/sitelayer
   ```

   If the cause is rotation drift, this is the whole fix.

2. **Restart the API container** — the deploy workflow does this
   automatically, but if you only need an env reload after a manual
   `.env` edit (avoid this — prefer the workflow):

   ```bash
   ssh sitelayer@10.118.0.4 \
     "cd /app/sitelayer && \
      GIT_SHA=\$(cat .last_successful_deployed_sha) \
        docker compose -f docker-compose.prod.yml up -d --force-recreate api"
   ```

3. **Retry the failed upload from the client.** Streaming multipart
   uploads are idempotent at the API level — the blueprint document
   isn't persisted until the Spaces PUT completes, so a 500 from this
   path leaves no orphan rows. Re-upload from the SPA.

4. **Cred rotation that wasn't propagated yet** — if you (or someone)
   rotated keys in the DO console but forgot to update the `production`
   GitHub environment, do that now:

   ```bash
   gh secret set DO_SPACES_KEY --env production --repo GitSteveLozano/sitelayer
   gh secret set DO_SPACES_SECRET --env production --repo GitSteveLozano/sitelayer
   # Both prompt for values; paste the new ones from DO Spaces "Access Keys".
   ```

   Then re-run the deploy workflow as in step 1.

## Fallback

Per `CLAUDE.md` operating rule (Blueprint storage hygiene #1), local FS
fallback is allowed but requires the off-host backup timer to be live.

1. **Confirm the timer is active** before flipping:

   ```bash
   ssh sitelayer@10.118.0.4 \
     "systemctl list-timers | grep blueprint && \
      systemctl is-active sitelayer-blueprint-backup.timer"
   ```

   Expected: `active`. If it isn't, do not enable local fallback — a
   droplet loss equals blueprint loss without that timer copying off-host.

2. **Flip the flag** for the duration of the Spaces outage:

   ```bash
   gh variable set ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD --env production --body "1"
   gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
   ```

   New uploads now land at `BLUEPRINT_STORAGE_ROOT=/app/storage/blueprints`
   on the droplet. Existing Spaces-stored blueprints continue to
   download from Spaces — the storage selector picks the path that
   matches each row's stored prefix.

3. **Flip it back off** as soon as Spaces is healthy:

   ```bash
   gh variable set ALLOW_LOCAL_BLUEPRINT_STORAGE_IN_PROD --env production --body ""
   gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
   ```

   Any blueprints uploaded during the fallback window stay on local FS;
   migrating them to Spaces is a follow-up, not part of incident
   recovery.

## Verifying recovery

```bash
# Real upload smoke from the API host:
doctl compute ssh sitelayer --ssh-command="
  curl -fsS -X POST \
    -H 'Authorization: Bearer \$CLERK_TEST_JWT' \
    -F 'blueprint_file=@/tmp/smoke.pdf;type=application/pdf' \
    https://sitelayer.sandolab.xyz/api/projects/<test-project-id>/blueprints
"

# Or just confirm errors stopped in the logs:
ssh sitelayer@10.118.0.4 \
  "docker compose -f /app/sitelayer/docker-compose.prod.yml logs api --tail 100 | \
    grep -iE 'spaces|upload|blueprint'"
```

## Post-incident

File a postmortem using [POSTMORTEM_TEMPLATE.md](./POSTMORTEM_TEMPLATE.md).
Likely follow-ups: (a) wire `DO_SPACES_KEY` rotation into
`docs/SECRET_ROTATION.md`, (b) Prometheus alert on
`sitelayer_http_request_errors_total{route=~".*/blueprints"}`.
