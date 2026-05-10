-- 055_rental_requests_review_columns.sql
--
-- Adds operator-side review columns to `rental_requests`. Migration 053
-- shipped the table with `approved_at` + `approved_by` (text) and a
-- `rejected_at` placeholder, but the operator approval queue needs:
--
--   * `approved_by_user_id` — Clerk-identifiable user that approved the
--     request, so audit trails join cleanly against `company_memberships`.
--   * `declined_at` + `decline_reason` — explicit decline path used by the
--     queue UI's "Decline" action. Mirrors the estimate share-link decline
--     shape from 052_estimate_share_links.sql.
--
-- All additions are nullable / `IF NOT EXISTS`; older databases that
-- already migrated past 053 still apply this cleanly without rewrites.

ALTER TABLE rental_requests
  ADD COLUMN IF NOT EXISTS approved_by_user_id text,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS decline_reason text;
