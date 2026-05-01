-- 028_push_subscriptions_and_notification_prefs.sql
--
-- Notification channels foundation (Phase 1 of the design's
-- "field-trustable" rules). The web app and worker land their
-- adapters in 1B/1C; this migration just sets up the data the
-- channel router reads at send time.
--
-- Two tables:
--
-- push_subscriptions — one row per (clerk_user_id, endpoint).
--   The PWA registers a Web Push subscription on first install +
--   permission grant; the worker calls web-push with these credentials
--   when it has a payload. last_seen_at is bumped each successful
--   delivery so we can prune stale endpoints.
--
-- notification_preferences — one row per (company, clerk_user_id).
--   Per-event-type channel choice. The four event types map to the
--   triggers Phase 1 ships:
--     assignment_change   → schedule diff (worker confirm/decline)
--     time_review_ready   → reviewer pinged when a run hits 'pending'
--     daily_log_reminder  → end-of-day nudge for the foreman
--     clock_anomaly       → geofence breach / no-clock-out / OT spike
--   sms_phone + email are the non-push fallback contacts. Twilio adapter
--   reads sms_phone; the existing email path (Resend/SendGrid) reads
--   email. 'off' silences that event for that user entirely.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_unique UNIQUE (clerk_user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_company_user_idx
  ON push_subscriptions (company_id, clerk_user_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  channel_assignment_change text NOT NULL DEFAULT 'push',
  channel_time_review_ready text NOT NULL DEFAULT 'push',
  channel_daily_log_reminder text NOT NULL DEFAULT 'push',
  channel_clock_anomaly text NOT NULL DEFAULT 'push',
  sms_phone text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_unique UNIQUE (company_id, clerk_user_id),
  CONSTRAINT notification_preferences_channel_chk CHECK (
    channel_assignment_change   IN ('push', 'sms', 'email', 'off') AND
    channel_time_review_ready   IN ('push', 'sms', 'email', 'off') AND
    channel_daily_log_reminder  IN ('push', 'sms', 'email', 'off') AND
    channel_clock_anomaly       IN ('push', 'sms', 'email', 'off')
  )
);
