-- 126_worker_issue_material_request.sql
--
-- Typed structured-material-capture for the field_event "out of materials"
-- blocker (Sitemap §11; design crop docs/steve-handoff/audit/shots/msg__38).
--
-- Until now an `out_of_materials` ping carried the material + quantity only as
-- free text inside `message`, and the foreman blocker detail BEST-EFFORT
-- parsed it (apps/web/src/screens/mobile/foreman-blocker-detail.tsx
-- parseMaterialNeed) to render the design's "12 SHEETS / EPS INSULATION"
-- quantity hero. That parse is fragile (it only matched a leading "<number>
-- <word>") and discarded the unit. The dossier
-- (docs/steve-handoff/audit/statecharts/specs/field-event.md Gap 6 option (b))
-- deferred the typed capture; this migration lands it.
--
-- These are the field_event "material-request fulfillment fields": the
-- structured content a materials_out blocker needs so the hero, the
-- fulfillment picker, and a future yard-stock read-model can key off typed
-- values rather than re-parsing the worker's prose.
--
-- Lifecycle note: this is issue CONTENT, not workflow state. Per the
-- field_event reducer's contract (packages/workflows/src/field-event.ts) the
-- reducer models the open/resolved/escalated/dismissed lifecycle only; material
-- name / quantity / unit gate no transition and have no per-state field-clear
-- semantics, so they live on the row alongside `message`, NOT in the reducer
-- event. The columns are therefore plain nullable content columns and are
-- preserved untouched across every RESOLVE / ESCALATE / DISMISS / REOPEN.
--
-- Expand-only: all columns are additive and nullable. Existing rows (and every
-- non-materials_out ping) keep NULLs and continue to fall back to the
-- message-parse path on the read side, so this is safe to apply mid-rollout
-- with old code still reading.

ALTER TABLE worker_issues
  ADD COLUMN IF NOT EXISTS material_label text,
  ADD COLUMN IF NOT EXISTS material_quantity numeric,
  ADD COLUMN IF NOT EXISTS material_unit text;

-- material_label is the human spec line ("EPS INSULATION · 1.5\" · 4'x8'").
-- Bounded so a pasted blob can't bloat the foreman inbox / notification
-- payloads, mirroring the resolution_message length guard from migration 049.
ALTER TABLE worker_issues
  DROP CONSTRAINT IF EXISTS worker_issues_material_label_len_chk;

ALTER TABLE worker_issues
  ADD CONSTRAINT worker_issues_material_label_len_chk CHECK (
    material_label IS NULL OR char_length(material_label) BETWEEN 1 AND 200
  );

-- material_unit is a short token ("sheets", "lf", "bags"). Same defensive cap.
ALTER TABLE worker_issues
  DROP CONSTRAINT IF EXISTS worker_issues_material_unit_len_chk;

ALTER TABLE worker_issues
  ADD CONSTRAINT worker_issues_material_unit_len_chk CHECK (
    material_unit IS NULL OR char_length(material_unit) BETWEEN 1 AND 32
  );

-- Quantity is non-negative when present (you can't be short "-5 sheets").
ALTER TABLE worker_issues
  DROP CONSTRAINT IF EXISTS worker_issues_material_quantity_chk;

ALTER TABLE worker_issues
  ADD CONSTRAINT worker_issues_material_quantity_chk CHECK (
    material_quantity IS NULL OR material_quantity >= 0
  );
