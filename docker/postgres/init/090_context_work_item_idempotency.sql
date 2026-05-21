-- Browser retries should not create duplicate work items when the API commits
-- but the response is lost. The client_request_id is stored in metadata so the
-- index is partial and expression-based.

CREATE UNIQUE INDEX IF NOT EXISTS context_work_items_client_request_id_uidx
  ON context_work_items (company_id, created_by_user_id, (metadata ->> 'client_request_id'))
  WHERE metadata ->> 'client_request_id' IS NOT NULL;
