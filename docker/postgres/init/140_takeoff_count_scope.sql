-- 140_takeoff_count_scope.sql
--
-- Per-symbol AI count scope (M1) — persist the count scope a capture was run
-- against.
--
-- The takeoff deep dive (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md, M1) flags that
-- the AI auto-count scope controls (the tapped symbol, the STRICT/NORMAL/LOOSE
-- match sensitivity, and the selected sheets) are presentational: they never
-- reach the capture endpoint, so an estimator taps one outlet symbol and gets
-- a whole-draft result back instead of a count of that one symbol.
--
-- This slice threads those controls into the capture payload and honors them
-- in the dry-run pipeline (a per-symbol count path that returns the instance
-- count + marker coordinates for the chosen symbol, scoped to the chosen
-- sheets at the chosen sensitivity). This migration only adds the audit /
-- traceability destination: a nullable jsonb column recording the scope the
-- draft was captured with.
--
-- It stays NULL for every existing draft and for any whole-draft capture
-- (the default when no symbol is chosen), so old and new code both tolerate
-- the column during rollout (expand step only — additive, forward-only).
-- Nothing reads it as a hard dependency.
--
-- Shape (when set):
--   {
--     "symbol":      { "label": "Diffuser — 24\" round", "sheet": "A-104" },
--     "sheets":      ["M-101", "M-102"],
--     "sensitivity": "NORMAL"            -- 'STRICT' | 'NORMAL' | 'LOOSE'
--   }
--
-- FOLLOW-UP (flagged in the PR): the LIVE single-symbol vision detector. This
-- slice honors the scope deterministically in the dry-run only; wiring the
-- live Claude/Gemini single-symbol count (read the chosen sheets, detect just
-- the tapped symbol, return real instance coordinates) is a separate slice.

ALTER TABLE takeoff_drafts
  ADD COLUMN IF NOT EXISTS count_scope_json jsonb;

COMMENT ON COLUMN takeoff_drafts.count_scope_json IS
  'Per-symbol AI count scope this capture was run against (M1): { symbol, sheets[], sensitivity }. NULL = whole-draft capture (no symbol chosen). Live single-symbol detection is a follow-up slice.';
