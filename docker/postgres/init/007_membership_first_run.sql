-- 007_membership_first_run.sql — per-membership first-run-complete flag.
--
-- The self-serve pilot onboarding flow lands a freshly-accepted teammate on a
-- role-specific first-run screen (worker/foreman/estimator-first-run.tsx) that
-- primes permissions before dropping them into the workspace. Once a member has
-- walked that priming once we must not show it again on the next login — but
-- there was no place to remember that they finished it. The flag lives on
-- `company_memberships` (the auth identity row, one per (company, user)) because
-- first-run is per-membership: a user who is a worker at company A and a foreman
-- at company B walks first-run independently for each.
--
-- Additive only: one nullable timestamptz, NULL = "has not finished first run".
-- A non-NULL `first_run_completed_at` records when they did. No backfill —
-- existing members carry NULL and would re-see first-run once; harmless, since
-- the screens are skippable priming, not data entry. No new index: the column is
-- only ever read alongside the existing (company_id, clerk_user_id) /
-- (clerk_user_id) membership lookups, which are already indexed.

ALTER TABLE public.company_memberships
    ADD COLUMN IF NOT EXISTS first_run_completed_at timestamp with time zone;
