-- agent_feed_concerns — the producer-side feed projectkit pull-executors poll
-- (apps/api/src/routes/agent-feed.ts). One row per addressed @operator/projectkit
-- Concern (wire v1.4.0: Concern.audience routes the row to an executor lane —
-- e.g. 'capture-analyzer' for the local analyzer, 'steve' for the collaborator's
-- Claude Code). The pull-executor GETs pending concerns for its audience and
-- POSTs Callbacks back:
--   accepted              -> the CLAIM (pending -> claimed; second claim = 409)
--   succeeded|failed|...  -> terminal: the Callback JSON is stored on the row.
--
-- `concern` is the FULL projectkit Concern JSON (the wire shape the executor
-- consumes verbatim); `callback` is the terminal projectkit Callback JSON.
-- (project_key, concern_ref) is the producer-stable idempotency key the
-- contract dedupes on — finalize/dispatch inserts are ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS public.agent_feed_concerns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    audience text NOT NULL,
    project_key text DEFAULT 'sitelayer'::text NOT NULL,
    concern_ref text NOT NULL,
    concern jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    callback jsonb,
    work_item_id uuid,
    capture_session_id uuid,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_feed_concerns_pkey PRIMARY KEY (id),
    CONSTRAINT agent_feed_concerns_audience_nonempty CHECK ((btrim(audience) <> ''::text)),
    CONSTRAINT agent_feed_concerns_concern_ref_nonempty CHECK ((btrim(concern_ref) <> ''::text)),
    CONSTRAINT agent_feed_concerns_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT agent_feed_concerns_project_ref_unique UNIQUE (project_key, concern_ref),
    CONSTRAINT agent_feed_concerns_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id),
    CONSTRAINT agent_feed_concerns_work_item_id_fkey FOREIGN KEY (work_item_id) REFERENCES public.context_work_items(id)
);

-- The pull-executor poll: WHERE audience = $1 AND status = 'pending'.
CREATE INDEX IF NOT EXISTS agent_feed_concerns_audience_status_idx
    ON public.agent_feed_concerns (audience, status);

-- The artifact-route authorization join: a capture artifact is servable to an
-- audience only when a concern row of that audience references its session.
CREATE INDEX IF NOT EXISTS agent_feed_concerns_capture_session_idx
    ON public.agent_feed_concerns (capture_session_id)
    WHERE capture_session_id IS NOT NULL;

-- Same RLS posture as the other company tables: the company_isolation policy
-- keeps the permissive NULL-GUC branch, so the machine-token feed routes (which
-- are cross-tenant BY DESIGN and gated by AGENT_FEED_TOKENS bearer auth —
-- reviewed in routes/rls-route-lint.test.ts RAW_QUERY_REVIEWED) read with the
-- plain pool, while the company-scoped writers (capture finalize via
-- withMutationTx) stay bound to their tenant.
ALTER TABLE public.agent_feed_concerns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.agent_feed_concerns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON public.agent_feed_concerns;
CREATE POLICY company_isolation ON public.agent_feed_concerns
    USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())))
    WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));
