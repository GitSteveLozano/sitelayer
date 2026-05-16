-- CompanyCam one-way photo mirror.
--
-- integration_connections already holds the OAuth tokens. integration_mappings
-- holds the (companycam project_id → sitelayer project_id) pin per company.
-- This migration just adds a dedupe ledger so the worker doesn't re-insert
-- the same photo on every poll.
--
-- daily_log_photos (migration 026/056) is the destination; we record the
-- external photo id and the daily_log_photo id we wrote so a re-poll is
-- a no-op.

CREATE TABLE IF NOT EXISTS companycam_photo_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_photo_id text NOT NULL,
  external_project_id text,
  daily_log_photo_id uuid,
  project_id uuid,
  captured_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, external_photo_id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS companycam_photo_imports_project_idx
  ON companycam_photo_imports (company_id, project_id, imported_at DESC);
