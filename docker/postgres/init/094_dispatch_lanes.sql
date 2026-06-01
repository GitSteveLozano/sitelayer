-- Dispatch lanes — named runner-level kill-switches.
--
-- The QBO circuit breaker exists per-integration; lanes generalise that to a
-- per-runner gate that the worker consults before draining each pipeline.
-- Operators can pause a lane from the admin UI (with an audited reason), the
-- auto-pause keeper can flip a lane to `degraded`/`paused` on threshold
-- breach, and a future QBO live-flip rollback path can pause the
-- `estimate_push` lane without redeploying the worker with a flipped env
-- flag.
--
-- This table is global (no company_id) — kill-switches are a fleet-wide
-- runtime concern, not a per-tenant one. The 5-person cohort means we don't
-- need lane-per-company yet.

CREATE TABLE IF NOT EXISTS dispatch_lanes (
    name              TEXT PRIMARY KEY,
    state             TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'paused', 'degraded')),
    pause_reason      TEXT NOT NULL DEFAULT '',
    paused_at         TIMESTAMPTZ,
    resume_after      TIMESTAMPTZ,
    last_decided_by   TEXT NOT NULL DEFAULT '',
    last_decided_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index — most rows stay 'active'. Operator dashboards and the
-- health-keeper care primarily about anything NOT active, so this index
-- stays tiny while still answering "show me everything that's broken".
CREATE INDEX IF NOT EXISTS idx_dispatch_lanes_active_state
    ON dispatch_lanes (state) WHERE state <> 'active';

-- Seed the lanes that actually exist in the worker today. Names match the
-- runner / pipeline names in apps/worker/src/worker.ts so the auto-pause
-- keeper and the operator UI can address them by name. Idempotent on
-- re-run (the worker boots before init.sql re-runs in dev).
INSERT INTO dispatch_lanes (name, state, last_decided_by)
VALUES
    ('estimate_push',           'active', 'system:seed'),
    ('rental_billing_push',     'active', 'system:seed'),
    ('labor_payroll_push',      'active', 'system:seed'),
    ('damage_charges',          'active', 'system:seed'),
    ('notifications',           'active', 'system:seed'),
    ('context_work_dispatch',   'active', 'system:seed'),
    ('rental_invoice',          'active', 'system:seed'),
    ('lock_labor_entries',      'active', 'system:seed'),
    ('field_events',            'active', 'system:seed'),
    ('crew_schedule_confirm',   'active', 'system:seed'),
    ('takeoff_to_bid',          'active', 'system:seed'),
    ('voice_to_log',            'active', 'system:seed'),
    ('companycam_poll',         'active', 'system:seed'),
    ('welcome_email',           'active', 'system:seed'),
    ('blueprint_storage_gc',    'active', 'system:seed'),
    ('capture_artifact_analysis', 'active', 'system:seed'),
    ('capture_artifact_retention_gc', 'active', 'system:seed'),
    ('work_request_stale',      'active', 'system:seed'),
    ('queue_prune',             'active', 'system:seed'),
    ('stuck_workflow_alerts',   'active', 'system:seed')
ON CONFLICT (name) DO NOTHING;

-- Audit trail for lane transitions. Append-only; every flip writes a row,
-- whether driven by the operator UI or the auto-pause keeper. Used to
-- answer "who paused estimate_push and why" + "what tripped degraded mode
-- this morning."
CREATE TABLE IF NOT EXISTS dispatch_lane_decisions (
    id                BIGSERIAL PRIMARY KEY,
    lane_name         TEXT NOT NULL REFERENCES dispatch_lanes(name),
    from_state        TEXT NOT NULL,
    to_state          TEXT NOT NULL,
    reason            TEXT NOT NULL DEFAULT '',
    decided_by        TEXT NOT NULL,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    decided_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_lane_decisions_lane_decided
    ON dispatch_lane_decisions (lane_name, decided_at DESC);
