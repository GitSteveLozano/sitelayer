-- Idempotency for offline/retried worker issue reports and attachments.
ALTER TABLE public.worker_issues
  ADD COLUMN IF NOT EXISTS client_request_id text;

ALTER TABLE public.worker_issue_attachments
  ADD COLUMN IF NOT EXISTS client_upload_id text;

CREATE UNIQUE INDEX IF NOT EXISTS worker_issues_company_reporter_client_request_uidx
  ON public.worker_issues (company_id, reporter_clerk_user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS worker_issue_attachments_client_upload_uidx
  ON public.worker_issue_attachments (company_id, worker_issue_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL;
