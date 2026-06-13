-- 020_notification_channel_preferences.sql
--
-- EXPAND phase only (audit gap #3, Campaign D). Opens the CLOSED per-kind
-- channel-preference enum so new notification kinds (field_request_denied,
-- foreman_assignment, invoice_paid, …) can be pushed / SMS'd / muted instead
-- of being forced email-only by the router's ROUTABLE_KINDS allowlist.
--
-- The legacy `notification_preferences` table (000_baseline.sql) has FOUR
-- FIXED channel columns + a literal CHECK, so a new kind has nowhere to store
-- its preference. This migration adds a row-per-(company, user, kind, channel)
-- table that scales to ANY kind without further schema churn.
--
-- PRODUCTION-SAFETY (expand/backfill/contract):
--   * ADDITIVE ONLY. The old `notification_preferences` columns are NOT
--     modified or dropped. New code dual-reads (this table wins, falls back
--     to the old enum columns) and KEEPS dual-writing the old columns, so a
--     rollback to pre-020 code still finds live preferences.
--   * RE-RUNNABLE. CREATE TABLE IF NOT EXISTS, guarded constraints, and an
--     idempotent backfill (insert … on conflict do nothing).
--   * The CONTRACT phase — dropping the four old channel_* columns + the
--     literal CHECK on notification_preferences — is a DELIBERATELY DEFERRED,
--     later migration, NOT done here. See docs/RUNBOOK_NOTIFICATION_BACKLOG.md
--     (sized follow-up) before contracting.
--
-- tier_origin uses the same `current_setting('app.tier', true)` column default
-- as every other tenant table, populated automatically inside the
-- withCompanyClient / withMutationTx session.

CREATE TABLE IF NOT EXISTS public.notification_channel_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    clerk_user_id text NOT NULL,
    -- The notifications.kind value this preference governs (free-text by
    -- design: the whole point of 020 is that kinds are no longer a closed
    -- enum). E.g. 'assignment_change', 'foreman_assignment',
    -- 'field_request_denied', 'invoice_paid'.
    kind text NOT NULL,
    -- The chosen delivery channel for this (user, kind). Mirrors the legacy
    -- enum domain: push | sms | email | off ('off' = intentional silence).
    channel text NOT NULL,
    tier_origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_channel_preferences_pkey PRIMARY KEY (id),
    CONSTRAINT notification_channel_preferences_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT notification_channel_preferences_kind_nonempty
        CHECK ((btrim(kind) <> ''::text)),
    CONSTRAINT notification_channel_preferences_channel_check
        CHECK ((channel = ANY (ARRAY['push'::text, 'sms'::text, 'email'::text, 'off'::text]))),
    -- One row per (company, user, kind): the channel is the value, not part of
    -- the key, so re-selecting a channel is an UPDATE, not a second row.
    CONSTRAINT notification_channel_preferences_unique
        UNIQUE (company_id, clerk_user_id, kind)
);

-- The router reads by (company_id, clerk_user_id, kind); index that path.
CREATE INDEX IF NOT EXISTS notification_channel_preferences_lookup_idx
    ON public.notification_channel_preferences (company_id, clerk_user_id, kind);

ALTER TABLE public.notification_channel_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.notification_channel_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON public.notification_channel_preferences;
CREATE POLICY company_isolation ON public.notification_channel_preferences
    USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())))
    WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));

-- BACKFILL — carry the four existing enum columns into the new table so
-- current users' preferences survive the read-path cutover. Idempotent:
-- `on conflict do nothing` makes a re-run a no-op, and a later code dual-write
-- that has already inserted a row wins (we never clobber a fresher value).
-- The legacy notification_preferences table has no tier_origin column, so
-- tier_origin is left to the column DEFAULT (current_setting('app.tier')) for
-- the migration session — consistent with how every other tenant table tags
-- rows it can't trace to an explicit origin.
INSERT INTO public.notification_channel_preferences
    (company_id, clerk_user_id, kind, channel)
SELECT np.company_id, np.clerk_user_id, src.kind, src.channel
FROM public.notification_preferences np
CROSS JOIN LATERAL (
    VALUES
        ('assignment_change', np.channel_assignment_change),
        ('time_review_ready', np.channel_time_review_ready),
        ('daily_log_reminder', np.channel_daily_log_reminder),
        ('clock_anomaly',      np.channel_clock_anomaly)
) AS src(kind, channel)
ON CONFLICT (company_id, clerk_user_id, kind) DO NOTHING;

COMMENT ON TABLE public.notification_channel_preferences IS
  'Row-per-(company,user,kind) notification channel preference (push|sms|email|off). EXPAND of the closed 4-column notification_preferences enum (migration 020); new code dual-reads (this wins) + dual-writes the legacy columns. Contracting the legacy columns is a deferred later migration.';
COMMENT ON COLUMN public.notification_channel_preferences.kind IS
  'notifications.kind this preference governs — free-text so new kinds need no schema change.';
COMMENT ON COLUMN public.notification_channel_preferences.channel IS
  'Chosen delivery channel: push | sms | email | off (off = intentional silence).';
