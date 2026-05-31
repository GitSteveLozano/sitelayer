-- 122_takeoff_draft_kind.sql
--
-- AI-queue auto-takeoff vs auto-count distinction (audit finding D11).
--
-- Background. `takeoff_drafts` already carries a capture-pipeline `source`
-- (`manual` / `roomplan` / `photogrammetry` / `drone` / `blueprint_vision`,
-- added by 069). That records WHICH pipeline produced the draft, but not WHAT
-- KIND of AI run it was. The estimator desktop has two distinct AI flows that
-- both run through the same `blueprint_vision` pipeline today:
--
--   * AI auto-takeoff  → est-ai-takeoff.tsx → review at /desktop/ai-takeoff/:id/review
--   * AI auto-count     → est-ai-count.tsx   → review at /desktop/ai-count/:id/review
--
-- Because they share a `source`, the company-wide AI review feed
-- (GET /api/takeoff-drafts, rendered by est-ai-queue.tsx) could not tell them
-- apart and always routed "Review draft →" to the takeoff-review screen. A
-- count draft opened in the takeoff reviewer instead of the keyboard-driven
-- count reviewer.
--
-- This migration adds a narrow `kind` discriminator on `takeoff_drafts`:
--
--   'takeoff' (default) — measurement/area auto-takeoff or a plain manual draft
--   'count'             — symbol auto-count run (count-a-symbol flow)
--
-- Kept orthogonal to `source` on purpose: `source` says how the geometry was
-- captured, `kind` says how the operator should review it. A future RoomPlan
-- count, or a manual count, stays expressible.
--
-- Like `takeoff_drafts.type` / `.source`, this is text + a CHECK constraint
-- rather than a Postgres ENUM so the vocabulary evolves with an in-transaction
-- ALTER TABLE … DROP/ADD CONSTRAINT instead of ALTER TYPE … ADD VALUE.
--
-- Additive / expand-only: the column defaults to 'takeoff' so every existing
-- draft (including the 066-backfilled Default rows) keeps working without an
-- UPDATE. The only backfill is a targeted reclassification of the auto-count
-- drafts the est-ai-count flow has already produced — they were inserted by
-- POST .../capture with name='AI auto-count', so we key the backfill on that
-- exact name. Manual and auto-takeoff drafts are left at the default.

ALTER TABLE takeoff_drafts
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'takeoff';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'takeoff_drafts_kind_check'
  ) THEN
    ALTER TABLE takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_kind_check
      CHECK (kind IN ('takeoff', 'count'));
  END IF;
END $$;

-- Partial index mirrors the source/review_required indexes from 069 — the AI
-- review feed filters on non-default rows, so only index the 'count' drafts.
CREATE INDEX IF NOT EXISTS takeoff_drafts_kind_idx
  ON takeoff_drafts (company_id, kind)
  WHERE kind <> 'takeoff' AND deleted_at IS NULL;

-- Backfill: reclassify the auto-count drafts already produced by the
-- est-ai-count setup flow. Those were inserted via the capture endpoint with
-- a literal name of 'AI auto-count' (see apps/web/src/screens/desktop/
-- est-ai-count.tsx). Scope to capture-pipeline drafts (source <> 'manual') so
-- a manually-named draft can't be reclassified out from under the operator.
-- Idempotent: re-running only touches rows still at the 'takeoff' default.
UPDATE takeoff_drafts
   SET kind = 'count'
 WHERE name = 'AI auto-count'
   AND source <> 'manual'
   AND kind = 'takeoff';
