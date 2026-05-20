# Runbook — Validate DO Spaces CORS for Presigned Blueprint Downloads

**When to read this:** you are about to flip `BLUEPRINT_DOWNLOAD_PRESIGNED=1`
in production, or the web client is throwing `CORS` errors when fetching
blueprint PDFs / page images from `*.digitaloceanspaces.com`.

**Related code:**

- `apps/api/src/server.ts:154-158` — env flag is read here.
- `apps/api/src/routes/blueprints.ts:520-553` — `GET /api/blueprints/:id/file`
  branches on the flag and either streams bytes through the API or issues a
  `302` to a presigned URL.
- `apps/api/src/storage.ts:288-295` — presigned URL minting (`expiresIn`
  default `900s`, optional `ResponseContentDisposition`).
- `CRITICAL_PATH.md:44` — gates this flag on CORS validation.

## What the flag actually does

With `BLUEPRINT_DOWNLOAD_PRESIGNED=1` (or `=true`), the
`GET /api/blueprints/:id/file` handler in `apps/api/src/routes/blueprints.ts:540`
mints a 15-minute presigned `GetObject` URL against the Spaces bucket and
issues a `302` redirect to it. Off (default), the API reads the bytes
from Spaces itself and streams them back inline with CORS headers
attached by `sendFileContent` (`apps/api/src/http-utils.ts`). When off,
no Spaces CORS config is needed — the bytes look like they come from
`sitelayer.sandolab.xyz`. When on, the browser fetches directly from
`<bucket>.<region>.digitaloceanspaces.com`, so the bucket's CORS must
allow our web origin and the `Range` header (PDF.js issues range
requests for partial PDFs and renders byte ranges progressively; without
CORS-allowed `Range`, the request fails the preflight).

The same flag also gates worker-issue attachments
(`apps/api/src/routes/worker-issues.ts:371`) and daily-log photos via
`attachmentDownloadPresigned` / `photoDownloadPresigned` in
`apps/api/src/routes/dispatch.ts:254,648,820`. All three storage paths
live in the same bucket (`sitelayer-blueprints-prod`) — one CORS rule
covers them.

## Inputs

| What                 | Value                                                       | Source                          |
| -------------------- | ----------------------------------------------------------- | ------------------------------- |
| Bucket               | `sitelayer-blueprints-prod`                                 | `docker-compose.prod.yml:28`    |
| Region               | `tor1`                                                      | `INFRASTRUCTURE_READY.md`       |
| Endpoint             | `https://tor1.digitaloceanspaces.com`                       | `DEPLOYMENT.md:144`             |
| Web origin (prod)    | `https://sitelayer.sandolab.xyz`                            | `apps/api/src/server.ts:149`    |
| Preview origin       | `https://main.preview.sitelayer.sandolab.xyz`               | `CRITICAL_PATH.md:29`           |
| Required HTTP verbs  | `GET`, `HEAD`                                               | PDF.js + browser image fetch    |
| Required req headers | `Range`, `If-Match`, `If-Modified-Since`, `If-None-Match`   | PDF.js range fetch              |
| Required exp headers | `Content-Range`, `Content-Length`, `ETag`, `Last-Modified`, `Accept-Ranges`, `Content-Disposition` | PDF.js |
| Max age              | `3600` (seconds; cap preflight churn)                       | n/a — recommended               |

## Step 1: Inspect the current CORS rule

Run from any machine with the production Spaces key in
`/app/sitelayer/.env`, or from the prod droplet itself. The droplet
already has the credential, so it's the cheapest place to run it.

```bash
doctl compute ssh sitelayer --ssh-command="
  set -a; source /app/sitelayer/.env; set +a
  docker run --rm \
    -e AWS_ACCESS_KEY_ID=\"\$DO_SPACES_KEY\" \
    -e AWS_SECRET_ACCESS_KEY=\"\$DO_SPACES_SECRET\" \
    -e AWS_DEFAULT_REGION=tor1 \
    amazon/aws-cli:latest \
    s3api get-bucket-cors \
      --bucket sitelayer-blueprints-prod \
      --endpoint-url https://tor1.digitaloceanspaces.com
"
```

Expected outcomes:

- `NoSuchCORSConfiguration` (HTTP 404): CORS is not configured. Go to
  Step 2.
- A JSON dump of `CORSRules`: compare against the required-rule
  template below. If origins/methods/headers match (or are supersets of)
  the template, Step 2 is unnecessary; jump to Step 3 (browser smoke).
- `AccessDenied`: the scoped Spaces key cannot read CORS. DO Spaces
  scoped keys do **not** grant `s3:GetBucketCORS`; CORS is an
  account-owner operation. Run the check with the account-owner Spaces
  key (one-time, captured outside `/app/sitelayer/.env`) or in the DO
  console: Spaces → `sitelayer-blueprints-prod` → Settings → CORS
  Configurations.

## Step 2: Apply the required CORS rule

Save this JSON to `/tmp/sitelayer-cors.json`:

```json
{
  "CORSRules": [
    {
      "ID": "sitelayer-blueprint-pdfjs",
      "AllowedOrigins": [
        "https://sitelayer.sandolab.xyz",
        "https://main.preview.sitelayer.sandolab.xyz"
      ],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": [
        "Range",
        "If-Match",
        "If-Modified-Since",
        "If-None-Match",
        "Authorization"
      ],
      "ExposeHeaders": [
        "Accept-Ranges",
        "Content-Range",
        "Content-Length",
        "ETag",
        "Last-Modified",
        "Content-Disposition"
      ],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Apply with the account-owner Spaces key (the scoped app key cannot do
this — it only has GetObject/PutObject/DeleteObject):

```bash
AWS_ACCESS_KEY_ID=<owner-key> \
AWS_SECRET_ACCESS_KEY=<owner-secret> \
AWS_DEFAULT_REGION=tor1 \
aws s3api put-bucket-cors \
  --bucket sitelayer-blueprints-prod \
  --endpoint-url https://tor1.digitaloceanspaces.com \
  --cors-configuration file:///tmp/sitelayer-cors.json
```

Then re-run Step 1 to confirm the rule landed.

Console fallback (if no owner key handy): Spaces →
`sitelayer-blueprints-prod` → Settings → CORS Configurations → Add
CORS Configuration. Repeat for both origins.

## Step 3: Browser-level smoke (no code changes yet)

Even with `BLUEPRINT_DOWNLOAD_PRESIGNED=0`, you can mint a presigned URL
manually and confirm the CORS handshake works before flipping the env.

1. SSH to the droplet:

   ```bash
   doctl compute ssh sitelayer
   set -a; source /app/sitelayer/.env; set +a
   ```

2. Mint a presigned URL for any existing blueprint key. (Pick any
   `storage_path` from `blueprint_documents` in prod Postgres.)

   ```bash
   docker run --rm \
     -e AWS_ACCESS_KEY_ID="$DO_SPACES_KEY" \
     -e AWS_SECRET_ACCESS_KEY="$DO_SPACES_SECRET" \
     -e AWS_DEFAULT_REGION=tor1 \
     amazon/aws-cli:latest \
     s3 presign s3://sitelayer-blueprints-prod/<key> \
       --endpoint-url https://tor1.digitaloceanspaces.com \
       --expires-in 600
   ```

3. From a browser on `https://sitelayer.sandolab.xyz`, paste the URL
   into the JS console:

   ```js
   const url = '<presigned-url>'
   const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } })
   console.log(r.status, r.headers.get('content-range'), r.headers.get('access-control-allow-origin'))
   ```

   Expected: `206`, a `Content-Range` like `bytes 0-1023/...`, and an
   `access-control-allow-origin` that matches the page origin
   (Spaces echoes the request origin when the rule matches).

   Failures and what they mean:
   - `CORS error: ... has been blocked by CORS policy` in the console:
     the rule is missing or the origin doesn't match. Re-check Step 2.
   - Status `200` instead of `206`: Spaces accepted the request but
     ignored the `Range` header. PDF.js will still work but progressive
     rendering will not. Acceptable; not a blocker.
   - Status `403` with `SignatureDoesNotMatch`: the presigned URL was
     re-quoted by the shell. Re-mint without shell mangling.

## Step 4: Flip the env flag

Once Step 3 succeeds:

1. Add `BLUEPRINT_DOWNLOAD_PRESIGNED=1` to the production environment.
   Source of truth is GitHub Actions `production` environment secrets;
   `/app/sitelayer/.env` is regenerated by the deploy workflow.

   ```bash
   gh secret set BLUEPRINT_DOWNLOAD_PRESIGNED \
     --repo GitSteveLozano/sitelayer \
     --env production \
     --body '1'
   ```

2. Re-deploy so the new env is rendered onto the droplet:

   ```bash
   gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
   gh run watch -R GitSteveLozano/sitelayer
   ```

3. Verify post-deploy: hit `GET /api/blueprints/<id>/file` while logged
   in and confirm the response is a `302` with a `Location` header that
   points at `*.digitaloceanspaces.com`. The current implementation
   keeps CORS headers on the redirect itself
   (`apps/api/src/routes/blueprints.ts:540-545`).

4. Tick the gate in `CRITICAL_PATH.md:44` (already `[x]`, but update
   the parenthetical: drop "until Spaces CORS is validated").

## Rollback

Unset the secret and re-deploy:

```bash
gh secret delete BLUEPRINT_DOWNLOAD_PRESIGNED --repo GitSteveLozano/sitelayer --env production
gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
```

The API falls back to streaming through itself; no Spaces config has to
be removed for the rollback to take effect.

## Why not just bake this into the deploy

CORS rules on object storage are infrastructure config, not app code.
We considered terraforming the bucket policy, but the bucket is shared
between prod / preview / future tenants and the CORS rule names each
allowed origin individually. Hand-applying it once and recording the
rule here costs less than wiring it through CI.
