-- 084_fk_orphan_backfills.sql
--
-- Backfill foreign key constraints on high-exposure dangling *_id columns.
--
-- Historical pattern in this schema: most tables already declare composite
-- (company_id, id) → parent(company_id, id) FKs (see 015, 057, 058, 059, 060).
-- A handful of mutation-path columns slipped through as plain uuid without
-- any FK declaration, leaving room for orphans if the parent row is hard
-- deleted. Each row below:
--
--   1. Counts orphans first; aborts the migration if any are present so the
--      operator can decide between cleaning up the data or rolling back this
--      file.
--   2. Adds the FK with ON DELETE RESTRICT (financial / audit / safety
--      lineage — never silently cascade or null).
--   3. Guards constraint creation with a pg_constraint existence check so
--      reapplying the migration is a no-op once it has succeeded.
--
-- Skipped intentionally:
--   * Polymorphic columns whose parent table is selected by a sibling
--     entity_type discriminator (workflow_event_log.entity_id,
--     ai_insights.entity_id, audit_events.entity_id). The whole point of
--     those rows is to outlive their referent.
--   * clerk_user_id columns (Clerk is external; no parent in this DB).
--   * Columns flagged as intentional in the originating migration
--     (rentals.damage_work_order_id — see comment in 053).
--
-- Where the parent table lacks a UNIQUE (company_id, id) constraint, we
-- fall back to a single-column FK on (id). Noted inline so a follow-up can
-- promote the parent and tighten the FK if cross-tenant collisions ever
-- become a concern.

-- ---------------------------------------------------------------------------
-- 1. estimate_push_lines.source_estimate_line_id -> estimate_lines(id)
--
-- estimate_push_lines snapshots a project's live estimate at push time so
-- the QBO post stays deterministic across review/approve/post. The
-- source_estimate_line_id link is what lets a bookkeeper trace a posted
-- QBO line back to the originating estimate row. If the parent is hard
-- deleted today, the lineage is silently lost.
--
-- NOTE: estimate_lines (defined in 001_schema.sql) does not declare
-- UNIQUE (company_id, id), so we cannot use a composite FK. Fall back to
-- a single-column FK on id. A follow-up migration can promote the parent
-- and tighten this constraint.
-- ---------------------------------------------------------------------------

DO $$
DECLARE orphan_count int;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM estimate_push_lines c
  WHERE c.source_estimate_line_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM estimate_lines p
      WHERE p.id = c.source_estimate_line_id
    );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'cannot add FK: % orphan rows in estimate_push_lines.source_estimate_line_id', orphan_count;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_estimate_push_lines_source_estimate_line_id'
  ) THEN
    ALTER TABLE estimate_push_lines
      ADD CONSTRAINT fk_estimate_push_lines_source_estimate_line_id
      FOREIGN KEY (source_estimate_line_id)
      REFERENCES estimate_lines (id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. scaffold_tags.last_inspection_id -> scaffold_inspections(company_id, id)
--
-- scaffold_tags carries a denormalized mirror of the most recent
-- scaffold_inspection (status/timestamp/id) so the site-map render is a
-- single query rather than a join. The inspection row drives safety
-- sign-offs; an orphan pointer would silently flip a "pass" tag into an
-- ambiguous state on QR scan.
--
-- Both tables already declare UNIQUE (company_id, id) — composite FK is
-- safe and enforces the same-company invariant explicitly.
-- ---------------------------------------------------------------------------

DO $$
DECLARE orphan_count int;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM scaffold_tags c
  WHERE c.last_inspection_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM scaffold_inspections p
      WHERE p.id = c.last_inspection_id
        AND p.company_id = c.company_id
    );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'cannot add FK: % orphan rows in scaffold_tags.last_inspection_id', orphan_count;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_scaffold_tags_last_inspection_id'
  ) THEN
    ALTER TABLE scaffold_tags
      ADD CONSTRAINT fk_scaffold_tags_last_inspection_id
      FOREIGN KEY (company_id, last_inspection_id)
      REFERENCES scaffold_inspections (company_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. companycam_photo_imports.daily_log_photo_id -> daily_log_photos(id)
--
-- companycam_photo_imports is the dedupe ledger that prevents the worker
-- from re-inserting the same CompanyCam photo on every poll. The
-- daily_log_photo_id back-reference is what proves a photo was actually
-- written to the foreman timeline. An orphan would let the worker
-- re-import a photo whose daily_log_photos row was deleted, producing
-- duplicates on the foreman screen.
--
-- NOTE: daily_log_photos (defined in 056) does not declare
-- UNIQUE (company_id, id), so we fall back to a single-column FK on id.
-- ---------------------------------------------------------------------------

DO $$
DECLARE orphan_count int;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM companycam_photo_imports c
  WHERE c.daily_log_photo_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM daily_log_photos p
      WHERE p.id = c.daily_log_photo_id
    );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'cannot add FK: % orphan rows in companycam_photo_imports.daily_log_photo_id', orphan_count;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_companycam_photo_imports_daily_log_photo_id'
  ) THEN
    ALTER TABLE companycam_photo_imports
      ADD CONSTRAINT fk_companycam_photo_imports_daily_log_photo_id
      FOREIGN KEY (daily_log_photo_id)
      REFERENCES daily_log_photos (id)
      ON DELETE RESTRICT;
  END IF;
END $$;
