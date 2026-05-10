-- 050_field_event_escalation_index.sql
--
-- Indexes for the field-event escalation queues introduced in migration 049.
--
-- Foreman inbox query (the hot path that drives the foreman dashboard):
--   select ... from worker_issues
--   where company_id = $1 and resolved_at is null
--   order by severity desc, created_at desc;
-- We sort by severity then time so the 'stopped' tickets float above
-- 'slowing' / 'question'. The composite index covers the equality on
-- company_id + resolved_at and gives us a usable order on severity for the
-- common "open & sort" path.
--
-- Estimator escalation queue:
--   select ... from worker_issues
--   where company_id = $1 and escalated_to_estimator_at is not null
--   order by escalated_to_estimator_at desc;
-- Partial would be ideal, but we want both "currently escalated" and the
-- post-resolution audit (e.g. an estimator looking back at the last 30 days
-- of escalations they handled), so a non-partial index keeps both queries on
-- the same scan.

CREATE INDEX IF NOT EXISTS worker_issues_inbox_idx
  ON worker_issues(company_id, resolved_at, severity);

CREATE INDEX IF NOT EXISTS worker_issues_estimator_queue_idx
  ON worker_issues(company_id, escalated_to_estimator_at);
