-- 001_job_runs.sql — periodic-job-fleet observability.
--
-- Sitelayer already has a periodic-job substrate: ~20 worker runners
-- (queue-prune, lane-health-keeper, blueprint-storage-gc, notification drain,
-- …) each with its own cadence gate, invoked every worker heartbeat. What was
-- missing was a single place to SEE that fleet — what ran, when, how long,
-- success/failure, and when each is next eligible. This table is that view: a
-- GLOBAL (company-agnostic, like dispatch_lanes) run-ledger that each runner
-- upserts one row into per job. It does NOT schedule anything — the runners
-- keep owning their cadence; they just record their runs here so
-- GET /api/admin/jobs + the read-only /admin/jobs page can surface fleet health.
--
-- Additive only: one new global table + indexes. No RLS (not tenant-scoped,
-- mirrors public.dispatch_lanes). updated_at is set by the writer (no trigger),
-- same convention as dispatch_lanes.

CREATE TABLE IF NOT EXISTS public.job_runs (
    job_name text NOT NULL,
    scope text DEFAULT 'global'::text NOT NULL,
    last_started_at timestamp with time zone,
    last_finished_at timestamp with time zone,
    last_status text DEFAULT 'unknown'::text NOT NULL,
    last_error text DEFAULT ''::text NOT NULL,
    last_duration_ms integer,
    run_count bigint DEFAULT 0 NOT NULL,
    success_count bigint DEFAULT 0 NOT NULL,
    failure_count bigint DEFAULT 0 NOT NULL,
    skipped_count bigint DEFAULT 0 NOT NULL,
    next_eligible_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_runs_pkey PRIMARY KEY (job_name),
    CONSTRAINT job_runs_status_check CHECK ((last_status = ANY (ARRAY['unknown'::text, 'running'::text, 'ok'::text, 'error'::text, 'skipped'::text])))
);

COMMENT ON TABLE public.job_runs IS 'Run-ledger for the worker periodic-job fleet (one row per job_name). GLOBAL/company-agnostic like dispatch_lanes; runners upsert their own row each run for /admin/jobs observability. Does NOT drive scheduling — cadence stays in each runner.';

-- Surface the unhealthy / stale jobs first on the admin page.
CREATE INDEX IF NOT EXISTS job_runs_unhealthy_idx ON public.job_runs USING btree (last_status, last_finished_at DESC) WHERE (last_status = ANY (ARRAY['error'::text, 'running'::text]));
CREATE INDEX IF NOT EXISTS job_runs_finished_idx ON public.job_runs USING btree (last_finished_at DESC);
