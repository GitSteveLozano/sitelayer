-- One finalized capture session should create at most one context work item.
-- Browser retries and operator double-clicks must replay the existing work item
-- instead of forking duplicate investigation tasks.

CREATE UNIQUE INDEX IF NOT EXISTS context_work_items_capture_session_finalize_uidx
  ON context_work_items (company_id, capture_session_id)
  WHERE capture_session_id IS NOT NULL
    AND metadata ->> 'source' = 'capture_session_finalize';
