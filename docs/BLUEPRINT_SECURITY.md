# Blueprint Security — Untrusted PII Blobs

## TL;DR

Blueprints are **user-supplied PDFs that legitimately contain customer PII**
(site addresses, owner names, contract terms, phone numbers). Sitelayer does
**not** scan, redact, or scrub them. **RLS + company-scoped access control is
the only protection.** Treat every blueprint blob as untrusted PII.

This is the security contract for `blueprint_documents`, `blueprint_pages`, and
their stored objects. It pairs with CLAUDE.md → "Blueprint storage hygiene" #3
and `docs/SECURITY_RLS.md`.

## The protection model

There is no server-side PII detection. The guarantees are:

1. **Clerk JWT auth** gates every request.
2. **Company-scoped access control** — every blueprint read/list/download is
   bound to the caller's company, both via RLS GUC binding
   (`withCompanyClient` / `withMutationTx`) **and** an explicit
   `company_id = $1` predicate. See `docs/SECURITY_RLS.md` for why RLS alone is
   not sufficient (the IS-NULL escape) and why route-level binding is the real
   control.
3. **Soft-delete is honored on read** — see below.

## Soft-delete defense-in-depth (`deleted_at IS NULL`)

Blueprints soft-delete via `blueprint_documents.deleted_at` (lineage of
replacements via `replaces_blueprint_document_id`); the underlying Spaces
object is GC'd asynchronously by the worker (`blueprint-storage-gc`).

**A soft-deleted blueprint must never be served.** Every read / list / download
query filters `deleted_at IS NULL` as defense-in-depth beyond RLS — RLS scopes
by company, but it does not encode the soft-delete contract, so a missing
`deleted_at` filter would serve a "deleted" document's bytes or metadata.

Paths that enforce it:

- `GET /api/projects/:id/blueprints` (list) — `blueprints.ts`
- `GET /api/blueprints/:id/file` (download) — `blueprints.ts`
- `PATCH /api/blueprints/:id`, `POST /api/blueprints/:id/versions` (source read)
  — `blueprints.ts`
- `GET /api/blueprints/:docId/pages` (page list) — `blueprint-pages.ts`
  (correlated `EXISTS` on the parent doc's `deleted_at IS NULL`; pages are not
  soft-deleted themselves, the doc is the gate)
- `GET /api/blueprint-pages/:id/file` (page download) — `blueprint-pages.ts`
  (`JOIN ... AND d.deleted_at IS NULL`)
- `GET /api/blueprints/:id/diffs` — `blueprint-diffs.ts`
- `POST /api/blueprints/:docId/pages` (write) also requires the parent doc to
  be live, so you cannot graft pages onto a deleted blueprint.

If you add a new blueprint read/list/download query, it **must** carry the
`deleted_at IS NULL` filter. There is test coverage that locks this in
(`blueprints.test.ts`, `blueprint-pages.test.ts`).

## Presigned download is OFF by default (`BLUEPRINT_DOWNLOAD_PRESIGNED`)

`GET /api/blueprints/:id/file` (and the page-file route) **stream bytes through
the API by default**. The presigned-URL 302 redirect path is gated behind
`BLUEPRINT_DOWNLOAD_PRESIGNED` (only `1`/`true` enables it). When OFF:

- No Spaces URL ever leaves the server. A presigned URL is a **credential-free
  read** of a PII blob for anyone who obtains it (a referrer leak, a shared
  link, a proxy log), so the default keeps the bytes behind the
  company-scoped, authenticated API.

When you do enable it:

- **Validate Spaces CORS for the SPA origin first** (`docs/RUNBOOK_SPACES_CORS.md`).
- **Never widen the presigned TTL past the 15-minute Spaces default.** A longer
  TTL widens the window a leaked URL is usable.

There is a guard test asserting the default-OFF wiring streams bytes and never
calls `getDownloadUrl` / issues a redirect.

## Logging / error-reporting rule

**Never log, echo, or include blueprint contents** in:

- application logs,
- error responses or Sentry events (blob bytes / extracted text must not be
  attached to error context),
- any audit row.

Only store / log **content-free** references: the opaque `storage_path`
(`<companyId>/<blueprintId>/<filename>`), ids, and counts.

## Future: opt-in PII scan (`BLUEPRINT_PII_SCAN`)

A future hook can flag PII regions in a blueprint (e.g. a Claude-vision pass).
It is reserved, **OFF by default, and currently a no-op stub** —
`apps/api/src/blueprint-pii-scan.ts`:

- `isBlueprintPiiScanEnabled()` is the single gate (default OFF; only
  `1/true/on/yes` flips it on).
- `maybeScanBlueprintForPii()` is the seam. It performs **no scan, no model
  call, and reads no blob contents** today; flipping the flag on changes
  nothing until the real scan ships. This mirrors `BLUEPRINT_VISION_MODE` — an
  accidentally-set flag must never start spending or touching blob contents on
  its own.

When the real scan is implemented behind this gate, it **must** obey the
logging rule above: emit only content-free tags + a boolean, never the raw
bytes or extracted text.

## Related

- CLAUDE.md → "Blueprint storage hygiene"
- `docs/SECURITY_RLS.md` — tenancy / GUC-binding control
- `docs/RUNBOOK_SPACES_CORS.md` — CORS validation before enabling presigned
- `docs/RUNBOOK_SPACES_UPLOAD.md` — upload failure triage
