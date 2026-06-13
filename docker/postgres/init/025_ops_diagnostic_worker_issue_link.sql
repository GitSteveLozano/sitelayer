-- Link onsite diagnostics to the field issue that prompted the operator session.
ALTER TABLE public.ops_diagnostic_sessions
  ADD COLUMN IF NOT EXISTS worker_issue_id uuid;

ALTER TABLE public.ops_diagnostic_sessions
  DROP CONSTRAINT IF EXISTS ops_diagnostic_sessions_worker_issue_id_fkey;

ALTER TABLE public.ops_diagnostic_sessions
  ADD CONSTRAINT ops_diagnostic_sessions_worker_issue_id_fkey
  FOREIGN KEY (worker_issue_id) REFERENCES public.worker_issues(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ops_diagnostic_sessions_worker_issue_idx
  ON public.ops_diagnostic_sessions (company_id, worker_issue_id)
  WHERE worker_issue_id IS NOT NULL;
