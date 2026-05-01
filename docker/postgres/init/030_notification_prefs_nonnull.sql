-- 030_notification_prefs_nonnull.sql
--
-- Tighten constraints on push_subscriptions and notification_preferences.
--
-- Why: 028 left clerk_user_id as nullable text on both tables. The
-- channel router queries `where clerk_user_id = $X`; a NULL row would
-- silently match nothing and surface as DEFAULT_PREFERENCES even when
-- a deleted-user row was expected to flag the bad state. The route
-- handlers already require a non-null clerk_user_id (sourced from
-- ctx.currentUserId), so this is a tightening migration with no
-- backfill needed.
--
-- Both columns get NOT NULL added; pre-existing rows shouldn't have
-- NULLs because the only insert paths set the value explicitly. If a
-- prior tier somehow persisted a NULL, the migration will fail loudly
-- (correct behaviour — the row is corrupt and needs investigating
-- before the constraint goes on).

ALTER TABLE push_subscriptions
  ALTER COLUMN clerk_user_id SET NOT NULL;

ALTER TABLE notification_preferences
  ALTER COLUMN clerk_user_id SET NOT NULL;
