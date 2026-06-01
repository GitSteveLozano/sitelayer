-- 121_project_target_margin.sql
--
-- Interactive margin re-pricing (U01 / D10 · MARGIN slider). The estimator's
-- price aside shows a draggable margin handle that re-prices the project's
-- contract bid off the internal cost basis: bid_total = cost / (1 - margin).
-- Persist the operator's chosen target so the slider survives a reload and the
-- scope-vs-bid surfaces compare against an intentional, recorded margin instead
-- of a transient client-only override.
--
-- The recompute solver is NOT touched: per-line `estimate_lines.amount` stay the
-- sum-of-priced-scope (scope_total). target_margin_pct only drives the project's
-- `bid_total` (the contract/sell price), which is the revenue side every margin
-- and scope-vs-bid calculation already reads.
--
-- Expand/backfill only (CLAUDE.md deploy rule 2: migrations are immutable once
-- committed; schema changes are additive forward migrations). Nullable: a null
-- target_margin_pct means "no explicit target set" — the existing derived-margin
-- behaviour is unchanged for every legacy row.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS target_margin_pct numeric;
