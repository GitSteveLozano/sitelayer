-- Idempotent capture artifact uploads from unreliable mobile/portal clients.
-- The client_upload_id is caller-provided and scoped to a capture session so a
-- retry returns the original artifact row instead of registering duplicates.
ALTER TABLE public.capture_artifacts
  ADD COLUMN IF NOT EXISTS client_upload_id text;

CREATE UNIQUE INDEX IF NOT EXISTS capture_artifacts_client_upload_idx
  ON public.capture_artifacts (company_id, capture_session_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL
    AND deleted_at IS NULL;
