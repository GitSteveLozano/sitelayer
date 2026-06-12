-- ops_diagnostic_sessions - phone-safe onsite diagnostic control sessions.
--
-- These rows are the durable counterpart to /api/ops/diagnostics readiness:
-- a platform operator starts a short-lived session from Mobile Ops, receives a
-- one-time control token, and records bounded action requests. The token is
-- never stored raw; only a SHA-256 hash is persisted. Action requests are
-- audit-only in this migration. Worker/agent pickup can subscribe to the event
-- table later without changing the phone contract.
CREATE TABLE IF NOT EXISTS public.ops_diagnostic_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    operator_user_id text,
    label text,
    intent text,
    plan jsonb NOT NULL,
    control_token_hash text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ops_diagnostic_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT ops_diagnostic_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT ops_diagnostic_sessions_state_check CHECK ((state = ANY (ARRAY['active'::text, 'cancelled'::text]))),
    CONSTRAINT ops_diagnostic_sessions_intent_check CHECK (
      intent IS NULL OR intent = ANY (ARRAY[
        'capture_field_context'::text,
        'capture_desktop_context'::text,
        'route_support_packet'::text,
        'dispatch_agent_review'::text
      ])
    ),
    CONSTRAINT ops_diagnostic_sessions_control_token_hash_nonempty CHECK ((btrim(control_token_hash) <> ''::text))
);

CREATE INDEX IF NOT EXISTS ops_diagnostic_sessions_company_active_idx
    ON public.ops_diagnostic_sessions (company_id, expires_at DESC)
    WHERE state = 'active';

CREATE TABLE IF NOT EXISTS public.ops_diagnostic_session_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    session_id uuid NOT NULL,
    actor_user_id text,
    event_type text NOT NULL,
    action_key text,
    effect text DEFAULT 'audit_only'::text NOT NULL,
    summary text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ops_diagnostic_session_events_pkey PRIMARY KEY (id),
    CONSTRAINT ops_diagnostic_session_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT ops_diagnostic_session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ops_diagnostic_sessions(id) ON DELETE CASCADE,
    CONSTRAINT ops_diagnostic_session_events_event_type_check CHECK ((event_type = ANY (ARRAY['session.started'::text, 'action.requested'::text]))),
    CONSTRAINT ops_diagnostic_session_events_action_key_check CHECK (
      action_key IS NULL OR action_key = ANY (ARRAY[
        'capture_field_context'::text,
        'capture_desktop_context'::text,
        'route_support_packet'::text,
        'dispatch_agent_review'::text
      ])
    ),
    CONSTRAINT ops_diagnostic_session_events_effect_check CHECK ((effect = 'audit_only'::text)),
    CONSTRAINT ops_diagnostic_session_events_summary_nonempty CHECK ((btrim(summary) <> ''::text))
);

CREATE INDEX IF NOT EXISTS ops_diagnostic_session_events_session_idx
    ON public.ops_diagnostic_session_events (session_id, created_at);

ALTER TABLE public.ops_diagnostic_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.ops_diagnostic_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON public.ops_diagnostic_sessions;
CREATE POLICY company_isolation ON public.ops_diagnostic_sessions
    USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())))
    WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));

ALTER TABLE public.ops_diagnostic_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.ops_diagnostic_session_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON public.ops_diagnostic_session_events;
CREATE POLICY company_isolation ON public.ops_diagnostic_session_events
    USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())))
    WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));
