# Multi-Draft Takeoff Spec

Status: design / not started
Author: Claude Opus 4.7 (1M context)
Last updated: 2026-04-29

## Why

Steve's original README/prototype notes claimed "Multiple measurement drafts per project. Create, rename, duplicate, switch between drafts. Each draft has its own canvas state and estimate. Auto-saves polygons and calibration. Extensible `type` column supports future tools (scaffolding design)." None of that exists in code today — `takeoff_measurements` rows hang directly off `project_id` with a `status` text column that has values like `draft` but no real grouping. Estimating off two competing scopes for the same project means deleting the first set first.

## Target shape

### Schema

New table `takeoff_drafts`:

```sql
CREATE TABLE takeoff_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'measurement',  -- 'measurement' today; 'scaffolding' for the future scaffolding-design tool
  status text NOT NULL DEFAULT 'active',     -- 'active' | 'archived'
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

ALTER TABLE takeoff_measurements ADD COLUMN draft_id uuid;
CREATE INDEX takeoff_measurements_draft_idx ON takeoff_measurements (company_id, draft_id);
```

### Backfill

For every existing project, create a default `takeoff_drafts` row with `name='Default'` and link all of that project's existing `takeoff_measurements` rows to it. After backfill, mark `draft_id NOT NULL` in a follow-up migration once code is fully cut over.

### API surface

- `GET /api/projects/:projectId/takeoff-drafts` — list drafts (active first, archived hidden by default; `?include_archived=1` to show all).
- `POST /api/projects/:projectId/takeoff-drafts` — create new draft. Body: `{ name, type? }`.
- `PATCH /api/takeoff-drafts/:id` — rename / archive. Body: `{ name?, status? }`.
- `POST /api/takeoff-drafts/:id/duplicate` — clone a draft. Copies the draft row + all measurements scoped by `draft_id`. Returns the new draft.
- `DELETE /api/takeoff-drafts/:id` — soft delete (sets `deleted_at`, cascades nothing — measurements stay around but are inaccessible to the UI).

Existing `GET/POST/PATCH /api/projects/:id/takeoff/measurements` endpoints add an optional `?draft_id=...` filter. When omitted, server returns the project's active default draft (or 400 if more than one active draft exists post-rollout — pick one).

### UI

The takeoffs canvas (`apps/web/src/views/takeoffs.tsx`) gets a dropdown picker above the toolbar: "Draft: [Default ▾]" with options to switch, plus a "+ New draft" entry and "Duplicate this draft" action. The canvas state machine should treat `draft_id` as part of its key so switching drafts cleanly resets the polygon array, calibration, and estimate cache.

Existing scope: blueprint selection is sticky per project; draft selection should be sticky per `(project, blueprint)` pair.

### Estimate

Each draft owns its own estimate. The existing `/api/projects/:id/estimate/recompute` endpoint takes a `draft_id` param and computes from that draft's measurements only. Default behavior (no draft_id) uses the project's active default.

Bid-vs-scope comparison is per-draft.

## Build order

1. **Migration** — `018_takeoff_drafts.sql` creates the table, backfills one default draft per project, links measurements via `draft_id`. Don't add NOT NULL yet; let the API ship first to populate new rows correctly.
2. **API** — list/create/patch/duplicate/delete endpoints; extend measurement endpoints with `?draft_id=` filter.
3. **UI** — draft picker dropdown + actions; wire canvas state-machine to draft.
4. **Estimate** — thread `draft_id` through estimate recompute + scope-vs-bid + PDF export.
5. **NOT NULL constraint** — once all code paths supply `draft_id`, follow-up migration to add `NOT NULL` constraint.

## Open questions for Steve

- "Each draft has its own canvas state and calibration" — calibration today is stored on `blueprint_documents`. Does each draft need its own calibration override, or is calibration still pinned to the blueprint regardless of draft?
- Type `'measurement'` vs `'scaffolding'` — what fields differ between the two? Schema design needs this if scaffolding ships within 6 months; otherwise leave `type` as a free-text column for now and figure it out when scaffolding starts.
- Archive vs delete semantics — is "archive" useful for keeping old proposals around, or do we just need delete?

## Why this spec is here, not built yet

Phase N is substantively bigger than the rest of the rental UX work (Phases G-O). Schema migration + backfill + API + canvas state-machine integration is a multi-day chunk. Better to design it explicitly first and let Steve confirm the open questions before building.
