-- Durable child results for onsite diagnostic actions.
--
-- The parent ops_diagnostic_session_events.result column stores the full
-- accepted_action response for idempotent mobile replay. This table records
-- each child side effect separately, so route/evidence outcomes remain
-- queryable even when one child is still retrying or a final parent-result
-- update fails after side effects have already run.
CREATE TABLE IF NOT EXISTS public.ops_diagnostic_action_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    session_id uuid NOT NULL,
    event_id uuid NOT NULL,
    result_key text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ops_diagnostic_action_results_pkey PRIMARY KEY (id),
    CONSTRAINT ops_diagnostic_action_results_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT ops_diagnostic_action_results_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ops_diagnostic_sessions(id) ON DELETE CASCADE,
    CONSTRAINT ops_diagnostic_action_results_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.ops_diagnostic_session_events(id) ON DELETE CASCADE,
    CONSTRAINT ops_diagnostic_action_results_key_check CHECK (
      result_key = ANY (ARRAY[
        'desktop_evidence'::text,
        'capture_route'::text,
        'agent_feed'::text
      ])
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_diagnostic_action_results_event_key_idx
    ON public.ops_diagnostic_action_results (company_id, event_id, result_key);

CREATE INDEX IF NOT EXISTS ops_diagnostic_action_results_session_idx
    ON public.ops_diagnostic_action_results (company_id, session_id, updated_at DESC);

ALTER TABLE public.ops_diagnostic_action_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.ops_diagnostic_action_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON public.ops_diagnostic_action_results;
CREATE POLICY company_isolation ON public.ops_diagnostic_action_results
    USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())))
    WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));
