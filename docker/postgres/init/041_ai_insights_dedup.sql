-- Phase 5 follow-on: dedupe key on ai_insights.source_run_id.
--
-- The bid-follow-up agent (and any future agent that wants
-- "one insight per (entity, time-bucket)") writes a stable
-- source_run_id like `bid_follow_up:<project>:<bucket>`. Without a
-- unique index the existence check + insert is racy under the
-- default READ COMMITTED isolation — two concurrent triggers can
-- both pass the SELECT and both INSERT.
--
-- Partial so legacy rows (and runs that don't carry a stable key)
-- aren't constrained.

CREATE UNIQUE INDEX IF NOT EXISTS ai_insights_source_run_id_idx
  ON ai_insights (company_id, source_run_id)
  WHERE source_run_id IS NOT NULL;
