-- 054_worker_issue_attachments.sql
--
-- Persist voice + photo attachments for `wk-issue` (worker_issues).
--
-- Until now, apps/web/src/screens/mobile/worker-issue.tsx captured a voice
-- recording and an optional photo, encoded both as data URLs, and shoved
-- them into the JSON body of POST /api/worker-issues as `voice_data_url`
-- and `photo_data_url`. The server ignored those fields entirely (no
-- columns, no multipart route) so every voice note + photo was discarded
-- after the API responded. fm-blocker-detail then read the same fields
-- back from the row hoping they would be there.
--
-- Schema choice — separate table, not columns on worker_issues:
--   * A single issue can carry multiple photos (the design lets the
--     worker re-shoot, and a follow-up "more context" photo is plausible).
--     A scalar `photo_storage_key text` would force the client to choose
--     one and discard the rest, repeating the data-URL bug at a different
--     layer.
--   * We also want mime + size per attachment so the GET path can stream
--     bytes back with the correct Content-Type / Content-Length without
--     re-deriving it from the file extension.
--   * Voice note is also rowed in here under kind='voice'. There can be
--     at most one voice note per issue (the recorder UI replaces on
--     re-record), enforced by the partial unique index below.
--
-- Storage keys live in the same bucket as everything else under a
-- `<companyId>/worker-issues/<issueId>/<filename>` prefix — same shape as
-- `<companyId>/daily-logs/<id>/...`, so assertKeyInCompany still gates
-- cross-tenant access via the first segment.

CREATE TABLE IF NOT EXISTS worker_issue_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_issue_id uuid NOT NULL REFERENCES worker_issues(id) ON DELETE CASCADE,
  kind text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_issue_attachments_kind_chk CHECK (
    kind IN ('voice', 'photo')
  ),
  CONSTRAINT worker_issue_attachments_size_chk CHECK (
    size_bytes >= 0
  )
);

-- Hot path: list attachments for one issue, newest first. The detail
-- screen renders attachments in the order they arrived.
CREATE INDEX IF NOT EXISTS worker_issue_attachments_issue_idx
  ON worker_issue_attachments(worker_issue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS worker_issue_attachments_company_idx
  ON worker_issue_attachments(company_id, created_at DESC);

-- Storage keys are globally unique inside a bucket; if the same key
-- somehow showed up twice we'd be exposing the same bytes under two
-- attachment rows. Deduplicate at the DB layer.
CREATE UNIQUE INDEX IF NOT EXISTS worker_issue_attachments_storage_key_uidx
  ON worker_issue_attachments(storage_key);

-- At most one `voice` attachment per issue. Re-recording in the UI
-- should DELETE the prior row before INSERT-ing the new one; the
-- partial unique index is the structural guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS worker_issue_attachments_one_voice_uidx
  ON worker_issue_attachments(worker_issue_id)
  WHERE kind = 'voice';
