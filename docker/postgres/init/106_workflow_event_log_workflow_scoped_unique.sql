-- 106_workflow_event_log_workflow_scoped_unique.sql
--
-- Widen the workflow_event_log dedupe key so two DIFFERENT workflows that
-- key on the SAME entity_id can coexist.
--
-- The bug: project_lifecycle and project_closeout BOTH write
-- workflow_event_log rows keyed on the same `projects.id` (entity_id), but
-- each carries its OWN independent version counter
-- (projects.lifecycle_state_version vs projects.state_version). The original
-- unique key from 020_workflow_event_log.sql —
--   UNIQUE (entity_id, state_version)
--   (constraint name: workflow_event_log_entity_id_state_version_key)
-- omits workflow_name, so a project_lifecycle row at state_version=1 collides
-- with a project_closeout row at state_version=1 on the same project →
-- 23505 unique_violation → a bare 500 on POST /closeout (after any lifecycle
-- transition) or POST /lifecycle/events (after a closeout).
--
-- The fix: replace the key with the LOOSER, workflow-scoped
--   UNIQUE (entity_id, workflow_name, state_version)
-- This is the correct stream key anyway: per the table's own design notes,
-- "workflow_name + entity_id is the stream key", so per-transition dedupe
-- should be scoped to that stream, not the bare entity.
--
-- Safety: widening a unique key can NEVER introduce a violation. Any pair of
-- rows that satisfied the old (stricter) UNIQUE(entity_id, state_version)
-- also satisfies the new (looser) UNIQUE(entity_id, workflow_name,
-- state_version) — the new key only adds a discriminating column, so it
-- partitions the old equivalence classes into smaller ones. No existing row
-- can collide under the looser key. The single-workflow dedupe backstop that
-- every other workflow relies on is preserved: within one workflow_name the
-- (entity_id, state_version) pair is still unique.
--
-- Idempotent + forward-only + additive: guarded with IF EXISTS / catalog
-- lookups so re-running is a no-op. No data is modified.

DO $$
BEGIN
  -- Drop the legacy entity-only unique key if it is still present (named or
  -- otherwise). 020 created it as the implicit name
  -- workflow_event_log_entity_id_state_version_key.
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'workflow_event_log'::regclass
      AND conname = 'workflow_event_log_entity_id_state_version_key'
  ) THEN
    ALTER TABLE workflow_event_log
      DROP CONSTRAINT workflow_event_log_entity_id_state_version_key;
  END IF;

  -- Create the workflow-scoped unique key if it is not already present.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'workflow_event_log'::regclass
      AND conname = 'workflow_event_log_entity_workflow_version_key'
  ) THEN
    ALTER TABLE workflow_event_log
      ADD CONSTRAINT workflow_event_log_entity_workflow_version_key
      UNIQUE (entity_id, workflow_name, state_version);
  END IF;
END $$;
