-- Composite indexes for the hottest read paths.
--
-- Query origins (apps/api/src/server.ts):
--   * /api/bootstrap loads projects/labor_entries/crew_schedules ordered by
--     updated_at / occurred_on / scheduled_for filtered by company_id.
--   * /api/projects/:id/summary and the takeoff endpoints scan
--     takeoff_measurements by (company_id, project_id) ordered by created_at.
--   * /api/sync/events (and the activity feeds at lines 132, 1207, 1239) scan
--     sync_events by company_id ordered by created_at — distinct from the
--     status-partial sync_events_ready_idx which only covers pending rows.
--
-- audit_events_company_recent_idx already covers the audit ledger; not added
-- here. The migration runner wraps each file in BEGIN/COMMIT, so we cannot use
-- CREATE INDEX CONCURRENTLY. At pilot data volumes the brief AccessShareLock is
-- acceptable; if a future table grows past ~10M rows split this file out and
-- run it manually outside the transaction wrapper.

CREATE INDEX IF NOT EXISTS projects_company_updated_idx
  ON projects (company_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS labor_entries_company_occurred_idx
  ON labor_entries (company_id, occurred_on DESC, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS crew_schedules_company_scheduled_idx
  ON crew_schedules (company_id, scheduled_for DESC);

CREATE INDEX IF NOT EXISTS takeoff_measurements_project_created_idx
  ON takeoff_measurements (company_id, project_id, created_at);

CREATE INDEX IF NOT EXISTS sync_events_company_created_idx
  ON sync_events (company_id, created_at DESC);
