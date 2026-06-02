-- 000_baseline.sql
--
-- GENERATED ARTIFACT — do NOT hand-edit. Produced by
-- scripts/squash-migrations-baseline.sh, which pg_dumps the schema-only
-- result of applying the full docker/postgres/init/*.sql history to a
-- throwaway postgres:18 and rewrites each statement to an idempotent form.
--
-- This file is a SQUASHED BASELINE. It is allowed ONLY during the learning
-- phase, while prod has no irreplaceable customer data. Read
-- docs/MIGRATION_BASELINE.md before adopting it — the per-environment cutover
-- (marking this baseline applied + retiring the old ledger rows) and the
-- maturity-curve "stop squashing" trigger live there.
--
-- Idempotent: safe to re-run against an already-migrated DB. CREATE ... IF NOT
-- EXISTS / CREATE OR REPLACE cover tables/indexes/functions/triggers; each
-- CREATE POLICY is preceded by a DROP POLICY IF EXISTS; each ADD CONSTRAINT is
-- wrapped in a duplicate-tolerant DO block; RLS ENABLE/FORCE are no-ops when
-- already set. Verified by the tool's own equivalence + re-apply check before
-- it was written.

--
-- PostgreSQL database dump
--

\restrict AifUTOhIr5PzRIODeId1c2MBhK1BVTm0jwFwOkF6dfo9e3MScwlaObDimc5bU7X

-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: app_current_company_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.app_current_company_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid;
$$;


--
-- Name: FUNCTION app_current_company_id(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.app_current_company_id() IS 'Reads app.company_id GUC set via SET LOCAL on each request transaction. Returns NULL when unset (RLS permissive).';


--
-- Name: budget_snapshot_no_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.budget_snapshot_no_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception
    'budget snapshots are immutable (table %): a change order mints a new version, existing snapshots are never modified',
    tg_table_name
    using errcode = 'restrict_violation';
end;
$$;


--
-- Name: bump_company_bootstrap_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.bump_company_bootstrap_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT company_id) INTO affected FROM old_rows;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT company_id) INTO affected FROM new_rows;
  ELSE
    -- UPDATE: include both, in case an UPDATE moved the row across companies
    -- (it shouldn't, but the bump is correctness, not cost-sensitive).
    SELECT array_agg(DISTINCT company_id) INTO affected FROM (
      SELECT company_id FROM new_rows
      UNION
      SELECT company_id FROM old_rows
    ) cs;
  END IF;

  IF affected IS NOT NULL THEN
    INSERT INTO company_bootstrap_state (company_id, token, updated_at)
    SELECT cid, gen_random_uuid(), now()
    FROM unnest(affected) AS t(cid)
    WHERE cid IS NOT NULL
    ON CONFLICT (company_id) DO UPDATE
    SET token = excluded.token, updated_at = excluded.updated_at;
  END IF;

  RETURN NULL;
END;
$$;


--
-- Name: get_inventory_availability(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.get_inventory_availability(company_uuid uuid) RETURNS TABLE(inventory_item_id uuid, total_stock_quantity numeric, available_quantity numeric, yard_quantity numeric, on_rent_quantity numeric, on_rent_lines integer, on_rent_projects integer)
    LANGUAGE sql STABLE
    AS $$
  WITH active_rentals AS (
    SELECT
      l.inventory_item_id,
      COALESCE(SUM(l.quantity), 0)::numeric(12,2) AS on_rent_quantity,
      COUNT(*)::int AS on_rent_lines,
      COUNT(DISTINCT c.project_id)::int AS on_rent_projects
    FROM job_rental_lines l
    JOIN job_rental_contracts c
      ON c.company_id = l.company_id AND c.id = l.contract_id AND c.deleted_at IS NULL
    WHERE l.company_id = company_uuid
      AND l.deleted_at IS NULL
      AND l.off_rent_date IS NULL
      AND l.status = 'active'
    GROUP BY l.inventory_item_id
  ),
  movement_balances AS (
    SELECT
      m.inventory_item_id,
      COALESCE(SUM(
        CASE
          WHEN m.to_location_id IS NOT NULL AND COALESCE(tl.location_type, '') NOT IN ('lost', 'damaged') THEN m.quantity
          ELSE 0
        END
        -
        CASE
          WHEN m.from_location_id IS NOT NULL AND COALESCE(fl.location_type, '') NOT IN ('lost', 'damaged') THEN m.quantity
          ELSE 0
        END
      ), 0)::numeric(12,2) AS total_stock_quantity,
      COALESCE(SUM(
        CASE WHEN m.to_location_id IS NOT NULL AND tl.location_type = 'yard' THEN m.quantity ELSE 0 END
        -
        CASE WHEN m.from_location_id IS NOT NULL AND fl.location_type = 'yard' THEN m.quantity ELSE 0 END
      ), 0)::numeric(12,2) AS yard_quantity
    FROM inventory_movements m
    LEFT JOIN inventory_locations fl ON fl.company_id = m.company_id AND fl.id = m.from_location_id
    LEFT JOIN inventory_locations tl ON tl.company_id = m.company_id AND tl.id = m.to_location_id
    WHERE m.company_id = company_uuid
    GROUP BY m.inventory_item_id
  )
  SELECT
    i.id AS inventory_item_id,
    COALESCE(b.total_stock_quantity, 0)::numeric(12,2) AS total_stock_quantity,
    GREATEST(COALESCE(b.total_stock_quantity, 0) - COALESCE(a.on_rent_quantity, 0), 0)::numeric(12,2)
      AS available_quantity,
    COALESCE(b.yard_quantity, 0)::numeric(12,2) AS yard_quantity,
    COALESCE(a.on_rent_quantity, 0)::numeric(12,2) AS on_rent_quantity,
    COALESCE(a.on_rent_lines, 0)::int AS on_rent_lines,
    COALESCE(a.on_rent_projects, 0)::int AS on_rent_projects
  FROM inventory_items i
  LEFT JOIN active_rentals a ON a.inventory_item_id = i.id
  LEFT JOIN movement_balances b ON b.inventory_item_id = i.id
  WHERE i.company_id = company_uuid
    AND i.deleted_at IS NULL
  ORDER BY i.code ASC;
$$;


--
-- Name: get_inventory_availability_by_branch(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.get_inventory_availability_by_branch(company_uuid uuid) RETURNS TABLE(inventory_item_id uuid, branch_id uuid, total_stock_quantity numeric, yard_quantity numeric, on_rent_quantity numeric, external_on_rent_quantity numeric, available_quantity numeric)
    LANGUAGE sql STABLE
    AS $$
  WITH movement_balances AS (
    SELECT
      m.inventory_item_id,
      COALESCE(tl.branch_id, fl.branch_id) AS branch_id,
      COALESCE(SUM(
        CASE
          WHEN m.to_location_id IS NOT NULL
            AND COALESCE(tl.location_type, '') NOT IN ('lost', 'damaged') THEN m.quantity
          ELSE 0
        END
        -
        CASE
          WHEN m.from_location_id IS NOT NULL
            AND COALESCE(fl.location_type, '') NOT IN ('lost', 'damaged') THEN m.quantity
          ELSE 0
        END
      ), 0)::numeric(12,2) AS total_stock_quantity,
      COALESCE(SUM(
        CASE WHEN m.to_location_id IS NOT NULL AND tl.location_type = 'yard' THEN m.quantity ELSE 0 END
        -
        CASE WHEN m.from_location_id IS NOT NULL AND fl.location_type = 'yard' THEN m.quantity ELSE 0 END
      ), 0)::numeric(12,2) AS yard_quantity
    FROM inventory_movements m
    LEFT JOIN inventory_locations fl ON fl.company_id = m.company_id AND fl.id = m.from_location_id
    LEFT JOIN inventory_locations tl ON tl.company_id = m.company_id AND tl.id = m.to_location_id
    WHERE m.company_id = company_uuid
    GROUP BY m.inventory_item_id, COALESCE(tl.branch_id, fl.branch_id)
  ),
  active_rentals AS (
    SELECT
      l.inventory_item_id,
      COALESCE(SUM(l.quantity), 0)::numeric(12,2) AS on_rent_quantity
    FROM job_rental_lines l
    JOIN job_rental_contracts c
      ON c.company_id = l.company_id AND c.id = l.contract_id AND c.deleted_at IS NULL
    WHERE l.company_id = company_uuid
      AND l.deleted_at IS NULL
      AND l.off_rent_date IS NULL
      AND l.status = 'active'
    GROUP BY l.inventory_item_id
  ),
  external_active AS (
    SELECT
      e.inventory_item_id,
      e.branch_id,
      COALESCE(SUM(e.quantity - e.returned_quantity), 0)::numeric(12,2) AS external_on_rent_quantity
    FROM external_rentals e
    WHERE e.company_id = company_uuid
      AND e.deleted_at IS NULL
      AND e.off_rent_date IS NULL
      AND e.status = 'active'
    GROUP BY e.inventory_item_id, e.branch_id
  )
  SELECT
    i.id AS inventory_item_id,
    b.branch_id,
    COALESCE(b.total_stock_quantity, 0)::numeric(12,2) AS total_stock_quantity,
    COALESCE(b.yard_quantity, 0)::numeric(12,2) AS yard_quantity,
    COALESCE(a.on_rent_quantity, 0)::numeric(12,2) AS on_rent_quantity,
    COALESCE(ex.external_on_rent_quantity, 0)::numeric(12,2) AS external_on_rent_quantity,
    GREATEST(
      COALESCE(b.total_stock_quantity, 0)
      + COALESCE(ex.external_on_rent_quantity, 0)
      - COALESCE(a.on_rent_quantity, 0),
      0
    )::numeric(12,2) AS available_quantity
  FROM inventory_items i
  LEFT JOIN movement_balances b ON b.inventory_item_id = i.id
  LEFT JOIN active_rentals a ON a.inventory_item_id = i.id
  LEFT JOIN external_active ex
    ON ex.inventory_item_id = i.id
   AND ex.branch_id IS NOT DISTINCT FROM b.branch_id
  WHERE i.company_id = company_uuid
    AND i.deleted_at IS NULL;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.ai_insights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    kind text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence text DEFAULT 'med'::text NOT NULL,
    attribution text NOT NULL,
    source_run_id text,
    produced_by text DEFAULT 'system'::text NOT NULL,
    applied_at timestamp with time zone,
    applied_by text,
    dismissed_at timestamp with time zone,
    dismissed_by text,
    dismiss_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_insights_confidence_check CHECK ((confidence = ANY (ARRAY['low'::text, 'med'::text, 'high'::text])))
);

ALTER TABLE ONLY public.ai_insights FORCE ROW LEVEL SECURITY;


--
-- Name: asset_deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.asset_deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    inventory_movement_id uuid,
    status text DEFAULT 'staged'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    project_id uuid,
    from_location_id uuid,
    handoff_worker_id uuid,
    handoff_confirmed_at timestamp with time zone,
    handoff_confirmed_by text,
    dispatched_at timestamp with time zone,
    estimated_return_on date,
    overdue_since timestamp with time zone,
    return_started_at timestamp with time zone,
    returned_at timestamp with time zone,
    returned_by text,
    condition_grade text,
    day_rate_cents integer,
    bill_mode text,
    extension_reason text,
    write_off_reason text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    tier_origin text DEFAULT current_setting('app.tier'::text, true),
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_deployments_status_check CHECK ((status = ANY (ARRAY['staged'::text, 'out'::text, 'overdue'::text, 'returning'::text, 'returned'::text, 'written_off'::text])))
);

ALTER TABLE ONLY public.asset_deployments FORCE ROW LEVEL SECURITY;


--
-- Name: audit_escrow_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.audit_escrow_entries (
    id bigint NOT NULL,
    entry_hash text NOT NULL,
    previous_entry_hash text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    company_id uuid,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    source_count integer DEFAULT 0 NOT NULL,
    payload_hash text NOT NULL,
    context_hash text NOT NULL,
    key_id text NOT NULL,
    signature_b64 text NOT NULL,
    material_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    s3_bucket text DEFAULT ''::text NOT NULL,
    s3_key text DEFAULT ''::text NOT NULL,
    s3_version_id text DEFAULT ''::text NOT NULL,
    s3_object_locked boolean DEFAULT false NOT NULL,
    ots_proof_path text DEFAULT ''::text NOT NULL,
    ots_status text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_escrow_entries_action_nonempty CHECK ((length(action) > 0)),
    CONSTRAINT audit_escrow_entries_entry_hash_nonempty CHECK ((length(entry_hash) > 0)),
    CONSTRAINT audit_escrow_entries_signature_nonempty CHECK ((length(signature_b64) > 0)),
    CONSTRAINT audit_escrow_entries_window_order CHECK ((window_end >= window_start))
);


--
-- Name: audit_escrow_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.audit_escrow_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_escrow_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_escrow_entries_id_seq OWNED BY public.audit_escrow_entries.id;


--
-- Name: audit_escrow_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.audit_escrow_keys (
    key_id text NOT NULL,
    host_id text DEFAULT ''::text NOT NULL,
    algorithm text DEFAULT 'Ed25519'::text NOT NULL,
    public_key_b64 text NOT NULL,
    private_key_b64 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT audit_escrow_keys_algorithm_supported CHECK ((algorithm = 'Ed25519'::text)),
    CONSTRAINT audit_escrow_keys_key_id_nonempty CHECK ((length(key_id) > 0)),
    CONSTRAINT audit_escrow_keys_retired_after_created CHECK (((retired_at IS NULL) OR (retired_at >= created_at)))
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    actor_user_id text DEFAULT 'system'::text NOT NULL,
    actor_role text,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    request_id text,
    sentry_trace text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    escrow_anchor_id bigint,
    capture_session_id uuid,
    impersonated_by text
);


--
-- Name: blueprint_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.blueprint_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    file_name text NOT NULL,
    storage_path text NOT NULL,
    preview_type text DEFAULT 'storage_path'::text NOT NULL,
    calibration_length numeric(12,2),
    calibration_unit text,
    sheet_scale numeric(12,4),
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    replaces_blueprint_document_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true)
);

ALTER TABLE ONLY public.blueprint_documents FORCE ROW LEVEL SECURITY;


--
-- Name: blueprint_page_diffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.blueprint_page_diffs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    new_page_id uuid NOT NULL,
    prior_page_id uuid,
    change_kind text NOT NULL,
    bbox_x numeric(8,4) NOT NULL,
    bbox_y numeric(8,4) NOT NULL,
    bbox_w numeric(8,4) NOT NULL,
    bbox_h numeric(8,4) NOT NULL,
    confidence numeric(4,3) DEFAULT 1 NOT NULL,
    affected_measurement_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blueprint_page_diffs_bbox_chk CHECK (((bbox_x >= (0)::numeric) AND (bbox_y >= (0)::numeric) AND (bbox_w > (0)::numeric) AND (bbox_h > (0)::numeric) AND ((bbox_x + bbox_w) <= (100)::numeric) AND ((bbox_y + bbox_h) <= (100)::numeric))),
    CONSTRAINT blueprint_page_diffs_change_chk CHECK ((change_kind = ANY (ARRAY['added'::text, 'removed'::text, 'modified'::text]))),
    CONSTRAINT blueprint_page_diffs_confidence_chk CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))
);

ALTER TABLE ONLY public.blueprint_page_diffs FORCE ROW LEVEL SECURITY;


--
-- Name: blueprint_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.blueprint_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    blueprint_document_id uuid NOT NULL,
    page_number integer NOT NULL,
    storage_path text,
    calibration_world_distance numeric(12,4),
    calibration_world_unit text,
    calibration_x1 numeric(10,4),
    calibration_y1 numeric(10,4),
    calibration_x2 numeric(10,4),
    calibration_y2 numeric(10,4),
    calibration_set_at timestamp with time zone,
    calibration_set_by text,
    measurement_count integer DEFAULT 0 NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scale_verified_at timestamp with time zone,
    scale_verified_by text,
    CONSTRAINT blueprint_pages_page_chk CHECK ((page_number >= 1))
);

ALTER TABLE ONLY public.blueprint_pages FORCE ROW LEVEL SECURITY;


--
-- Name: bom_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.bom_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    bom_id uuid NOT NULL,
    catalog_part_id uuid NOT NULL,
    quantity numeric(14,3) NOT NULL,
    notes text,
    attrs jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.bom_lines FORCE ROW LEVEL SECURITY;


--
-- Name: boms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.boms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    source_ref text,
    name text NOT NULL,
    notes text,
    status text DEFAULT 'draft'::text NOT NULL,
    approved_at timestamp with time zone,
    approved_by text,
    superseded_by uuid,
    total_weight_kg numeric(14,3) DEFAULT 0 NOT NULL,
    total_lines integer DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    superseded_at timestamp with time zone,
    superseded_by_user text
);

ALTER TABLE ONLY public.boms FORCE ROW LEVEL SECURITY;


--
-- Name: bonus_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.bonus_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.bonus_rules FORCE ROW LEVEL SECURITY;


--
-- Name: branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.branches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    address text,
    is_default boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.branches FORCE ROW LEVEL SECURITY;


--
-- Name: broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.broadcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    author_user_id text NOT NULL,
    audience text DEFAULT 'all'::text NOT NULL,
    body text NOT NULL,
    project_id uuid,
    origin text DEFAULT current_setting('app.tier'::text, true),
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT broadcasts_audience_check CHECK ((audience = ANY (ARRAY['all'::text, 'foremen'::text, 'crew'::text])))
);

ALTER TABLE ONLY public.broadcasts FORCE ROW LEVEL SECURITY;


--
-- Name: budget_snapshot_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.budget_snapshot_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    budget_snapshot_id uuid NOT NULL,
    cost_code text,
    division_code text,
    service_item_code text NOT NULL,
    qty numeric(12,2) DEFAULT 0 NOT NULL,
    unit text DEFAULT ''::text NOT NULL,
    material_amount numeric(12,2) DEFAULT 0 NOT NULL,
    labor_amount numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.budget_snapshot_lines FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE budget_snapshot_lines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.budget_snapshot_lines IS 'Immutable per-cost-code budget lines rolled up from estimate_lines at freeze time. Roll-up key is service_item_code; cost_code/division_code carry the optional higher-level cost-code axis (populated from division_code today). material_amount + labor_amount = the frozen budget for the line.';


--
-- Name: budget_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.budget_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    frozen_at timestamp with time zone DEFAULT now() NOT NULL,
    frozen_by text,
    note text,
    material_total numeric(12,2) DEFAULT 0 NOT NULL,
    labor_total numeric(12,2) DEFAULT 0 NOT NULL,
    budget_total numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true)
);

ALTER TABLE ONLY public.budget_snapshots FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE budget_snapshots; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.budget_snapshots IS 'Immutable frozen BUDGET at award (Deep Dive §4). Taken by an explicit operator freeze, NOT tied to project_lifecycle. A change order mints a new version (monotonic per project); an existing snapshot is never mutated (enforced by trigger). estimate_lines stays the live bid.';


--
-- Name: capture_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.capture_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    capture_session_id uuid NOT NULL,
    kind text NOT NULL,
    storage_key text,
    uri text,
    content_type text,
    byte_size bigint,
    content_hash text,
    duration_ms integer,
    pii_level text DEFAULT 'internal'::text NOT NULL,
    access_policy text DEFAULT 'support_only'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    retention_expires_at timestamp with time zone,
    redaction_version text DEFAULT 'capture-session-v1'::text NOT NULL,
    CONSTRAINT capture_artifacts_access_policy_check CHECK ((access_policy = ANY (ARRAY['support_only'::text, 'operator_only'::text, 'tenant_visible'::text]))),
    CONSTRAINT capture_artifacts_kind_nonempty CHECK ((btrim(kind) <> ''::text)),
    CONSTRAINT capture_artifacts_pii_level_check CHECK ((pii_level = ANY (ARRAY['low'::text, 'internal'::text, 'private'::text, 'restricted'::text])))
);

ALTER TABLE ONLY public.capture_artifacts FORCE ROW LEVEL SECURITY;


--
-- Name: capture_session_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.capture_session_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    capture_session_id uuid NOT NULL,
    seq bigint DEFAULT 0 NOT NULL,
    client_event_id text,
    event_type text NOT NULL,
    event_class text DEFAULT ''::text NOT NULL,
    route_path text,
    workflow_id text,
    entity_type text,
    entity_id text,
    request_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    redaction_version text DEFAULT 'capture-session-v1'::text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capture_session_events_event_type_nonempty CHECK ((btrim(event_type) <> ''::text))
);

ALTER TABLE ONLY public.capture_session_events FORCE ROW LEVEL SECURITY;


--
-- Name: capture_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.capture_sessions (
    id uuid NOT NULL,
    company_id uuid NOT NULL,
    actor_user_id text,
    mode text DEFAULT 'trace'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    route_path text,
    device_kind text,
    platform text,
    viewport text,
    app_build_sha text,
    consent_version text DEFAULT ''::text NOT NULL,
    redaction_version text DEFAULT 'capture-session-v1'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    stopped_at timestamp with time zone,
    discarded_at timestamp with time zone,
    retention_expires_at timestamp with time zone,
    consent_actor_kind text,
    consent_actor_ref text,
    consent_authority text,
    consent_scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    consented_at timestamp with time zone,
    CONSTRAINT capture_sessions_mode_check CHECK ((mode = ANY (ARRAY['trace'::text, 'feedback'::text, 'desktop'::text, 'native'::text, 'manual_upload'::text]))),
    CONSTRAINT capture_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'stopped'::text, 'discarded'::text, 'failed'::text, 'redacted'::text])))
);

ALTER TABLE ONLY public.capture_sessions FORCE ROW LEVEL SECURITY;


--
-- Name: catalog_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.catalog_parts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    manufacturer_id uuid,
    scaffold_system_id uuid,
    inventory_item_id uuid,
    sku text NOT NULL,
    description text NOT NULL,
    unit text DEFAULT 'ea'::text NOT NULL,
    weight_kg numeric(12,3),
    length_mm integer,
    width_mm integer,
    height_mm integer,
    surface_area_m2 numeric(12,3),
    attrs jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.catalog_parts FORCE ROW LEVEL SECURITY;


--
-- Name: change_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.change_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    number integer NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    value_delta numeric(14,2) DEFAULT 0 NOT NULL,
    schedule_impact_days integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    sent_at timestamp with time zone,
    accepted_at timestamp with time zone,
    rejected_at timestamp with time zone,
    voided_at timestamp with time zone,
    reject_reason text,
    created_by text,
    approved_by text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    origin text DEFAULT current_setting('app.tier'::text, true),
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT change_orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'rejected'::text, 'voided'::text])))
);

ALTER TABLE ONLY public.change_orders FORCE ROW LEVEL SECURITY;


--
-- Name: clerk_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.clerk_users (
    clerk_user_id text NOT NULL,
    email text,
    first_name text,
    last_name text,
    image_url text,
    origin text DEFAULT current_setting('app.tier'::text, true),
    clerk_created_at timestamp with time zone,
    clerk_updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.clerk_users FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE clerk_users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.clerk_users IS 'Global mirror of Clerk users, keyed by clerk_user_id. Populated by the Svix-verified Clerk webhook. NOT company-scoped — per-company role lives in company_memberships.';


--
-- Name: COLUMN clerk_users.clerk_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clerk_users.clerk_user_id IS 'Clerk user id (e.g. user_xxx). Primary key; matches company_memberships.clerk_user_id.';


--
-- Name: COLUMN clerk_users.clerk_created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clerk_users.clerk_created_at IS 'created_at reported by Clerk in the webhook payload (epoch ms → timestamptz).';


--
-- Name: COLUMN clerk_users.deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clerk_users.deleted_at IS 'Soft-delete marker set on user.deleted. Memberships and audit rows are intentionally left intact.';


--
-- Name: clock_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.clock_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    worker_id uuid,
    project_id uuid,
    clerk_user_id text,
    event_type text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    lat numeric(9,6),
    lng numeric(9,6),
    accuracy_m numeric(8,2),
    inside_geofence boolean,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    correctible_until timestamp with time zone,
    voided_at timestamp with time zone,
    voided_by text,
    photo_storage_path text,
    photo_uploaded_at timestamp with time zone,
    photo_verified_at timestamp with time zone,
    photo_verified_by text,
    photo_verification_status text,
    CONSTRAINT clock_events_photo_status_chk CHECK (((photo_verification_status IS NULL) OR (photo_verification_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))),
    CONSTRAINT clock_events_source_chk CHECK ((source = ANY (ARRAY['manual'::text, 'auto_geofence'::text, 'foreman_override'::text])))
);

ALTER TABLE ONLY public.clock_events FORCE ROW LEVEL SECURITY;


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    modules jsonb DEFAULT '{"takeoff": true, "estimating": true, "rental_ops": true, "field_labor": true, "scaffold_bom": false, "customer_portal": true, "payroll_exports": true, "scaffold_design": false, "scaffold_inspections": false}'::jsonb NOT NULL,
    portal_settings jsonb DEFAULT '{"show_photos": true, "show_invoices": false, "show_estimates": true, "show_inspections": false}'::jsonb NOT NULL,
    ot_service_item_code text,
    legal_name text,
    license_no text,
    address text,
    phone text,
    website text,
    working_hours jsonb,
    labor_payroll_auto_post_enabled boolean DEFAULT false NOT NULL,
    labor_payroll_auto_post_weekday integer,
    labor_payroll_auto_post_after time without time zone,
    notification_from_email text,
    notification_from_name text
);


--
-- Name: COLUMN companies.ot_service_item_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.ot_service_item_code IS 'Per-company service_items.code used for QBO TimeActivity push OT split. NULL = no OT split (worker posts one TimeActivity per labor_entry against the existing service_item_code). Set = worker posts two TimeActivities when splitStraightAndOt produces ot_hours > 0: one straight against the entry''s code, one OT against this code. Validated by apps/api/src/routes/companies.ts PATCH /api/companies/:id/settings.';


--
-- Name: COLUMN companies.legal_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.legal_name IS 'Registered legal entity name (vs companies.name display name). Edited via PATCH /api/companies/:id; surfaced on estimates/invoices.';


--
-- Name: COLUMN companies.license_no; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.license_no IS 'Contractor license number, surfaced on estimates/invoices. Edited via PATCH /api/companies/:id.';


--
-- Name: COLUMN companies.address; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.address IS 'Business mailing address. Edited via PATCH /api/companies/:id.';


--
-- Name: COLUMN companies.phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.phone IS 'Main business phone. Edited via PATCH /api/companies/:id.';


--
-- Name: COLUMN companies.website; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.website IS 'Public website URL. Edited via PATCH /api/companies/:id.';


--
-- Name: COLUMN companies.working_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.working_hours IS 'Standard work window + working days + holidays. NULL = company has not configured working hours (UI falls back to Mon-Fri 07:00-16:00, OT 8h). Shape { days: Record<weekday,bool>, day_start, day_end, ot_rule, holidays: [{name,date}] } validated by apps/api/src/routes/companies.ts PUT /api/companies/:id/working-hours (route is the integrity gate, no DB constraint — mirrors modules / portal_settings).';


--
-- Name: COLUMN companies.labor_payroll_auto_post_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.labor_payroll_auto_post_enabled IS 'Per-company opt-in for the weekly labor-payroll auto-post. false (default) = no auto-advance; runs only move via human APPROVE / POST_REQUESTED. true = the worker labor_payroll_auto_post lane may dispatch AUTO_APPROVE / AUTO_POST_REQUESTED for runs in the configured weekly window.';


--
-- Name: COLUMN companies.labor_payroll_auto_post_weekday; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.labor_payroll_auto_post_weekday IS 'ISO weekday (1=Mon .. 7=Sun) the weekly auto-post window opens. NULL when auto-post is disabled.';


--
-- Name: COLUMN companies.labor_payroll_auto_post_after; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.labor_payroll_auto_post_after IS 'Local time-of-day the weekly auto-post window opens (e.g. 17:00). The worker tick reads the clock; the reducer never does.';


--
-- Name: COLUMN companies.notification_from_email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.notification_from_email IS 'Per-company From: address for outbound notifications (invites, estimate shares, sync alerts, welcome emails). NULL (default) = fall back to the global EMAIL_FROM env. EXPAND-only: not yet used on the send path — that requires per-company domain/sender VERIFICATION first (see docs/MULTI_TENANCY.md flagged follow-ups). resolveCompanyNotificationSender reads this with the env as a fallback so the default posture is unchanged.';


--
-- Name: COLUMN companies.notification_from_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.notification_from_name IS 'Per-company display name paired with notification_from_email (e.g. "Acme Construction"). NULL (default) = no display name / env behavior. Same EXPAND-only status + verification gate as notification_from_email.';


--
-- Name: company_bootstrap_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.company_bootstrap_state (
    company_id uuid NOT NULL,
    token uuid DEFAULT gen_random_uuid() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: company_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.company_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    token text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    invited_by text NOT NULL,
    accepted_by text,
    accepted_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    CONSTRAINT company_invites_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.company_invites FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE company_invites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_invites IS 'Teammate invitations. email is the addressee; token is the unguessable accept key; accepted_by is the Clerk user id that claimed it.';


--
-- Name: company_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.company_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    clerk_user_id text NOT NULL,
    role text DEFAULT 'admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_role_id uuid,
    CONSTRAINT company_memberships_valid_role CHECK ((role = ANY (ARRAY['admin'::text, 'foreman'::text, 'office'::text, 'member'::text, 'bookkeeper'::text])))
);

ALTER TABLE ONLY public.company_memberships FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN company_memberships.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_memberships.role IS 'App-recognized values: admin | foreman | office | member | bookkeeper. No DB constraint — permission gates in apps/web/src/lib/permissions.ts and the API requireRole() helper are the enforcement points.';


--
-- Name: COLUMN company_memberships.custom_role_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_memberships.custom_role_id IS 'Optional link to a custom_roles row. NULL = member gates purely on its raw company role (zero behaviour change).';


--
-- Name: company_pricing_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.company_pricing_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    service_item_code text NOT NULL,
    rate numeric(12,2) NOT NULL,
    unit text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.company_pricing_overrides FORCE ROW LEVEL SECURITY;


--
-- Name: company_usage_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.company_usage_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    operation text NOT NULL,
    cost_usd numeric(10,6) NOT NULL,
    description text,
    request_id text,
    sentry_trace text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.company_usage_log FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE company_usage_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_usage_log IS 'Per-company cost log for expensive operations (QBO sync, blueprint vision). Append-only.';


--
-- Name: COLUMN company_usage_log.operation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_usage_log.operation IS 'Operation kind (e.g. qbo_api_call, blueprint_vision_page).';


--
-- Name: COLUMN company_usage_log.cost_usd; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_usage_log.cost_usd IS 'Estimated cost in USD; 6 decimal places allow $0.000050 precision.';


--
-- Name: companycam_photo_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.companycam_photo_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    external_photo_id text NOT NULL,
    external_project_id text,
    daily_log_photo_id uuid,
    project_id uuid,
    captured_at timestamp with time zone,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    error text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.companycam_photo_imports FORCE ROW LEVEL SECURITY;


--
-- Name: context_handoff_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.context_handoff_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_kind text NOT NULL,
    actor_user_id text,
    actor_ref text,
    source_system text DEFAULT 'sitelayer'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key text,
    causation_event_id uuid,
    correlation_id uuid,
    request_id text,
    sentry_trace text,
    sentry_baggage text,
    build_sha text,
    redaction_version text DEFAULT 'v1'::text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    escrow_anchor_id bigint,
    capture_session_id uuid,
    CONSTRAINT context_handoff_events_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'agent'::text, 'system'::text, 'external'::text]))),
    CONSTRAINT context_handoff_events_event_type_nonempty CHECK ((btrim(event_type) <> ''::text))
);

ALTER TABLE ONLY public.context_handoff_events FORCE ROW LEVEL SECURITY;


--
-- Name: context_work_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.context_work_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    support_packet_id uuid NOT NULL,
    title text NOT NULL,
    summary text,
    status text DEFAULT 'new'::text NOT NULL,
    lane text DEFAULT 'triage'::text NOT NULL,
    severity text,
    route text,
    entity_type text,
    entity_id text,
    assignee_user_id text,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    agent_callback_token_hash text,
    agent_callback_token_issued_at timestamp with time zone,
    reversibility_window_seconds bigint DEFAULT 86400 NOT NULL,
    reversed_at timestamp with time zone,
    capture_session_id uuid,
    CONSTRAINT context_work_items_lane_check CHECK ((lane = ANY (ARRAY['triage'::text, 'human'::text, 'agent'::text, 'both'::text, 'done'::text]))),
    CONSTRAINT context_work_items_severity_check CHECK (((severity IS NULL) OR (severity = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])))),
    CONSTRAINT context_work_items_status_check CHECK ((status = ANY (ARRAY['new'::text, 'triaged'::text, 'agent_running'::text, 'human_assigned'::text, 'review_ready'::text, 'review_stale'::text, 'proposal_expired'::text, 'resolved'::text, 'reopened'::text, 'wont_do'::text, 'reversed'::text]))),
    CONSTRAINT context_work_items_title_nonempty CHECK ((btrim(title) <> ''::text))
);

ALTER TABLE ONLY public.context_work_items FORCE ROW LEVEL SECURITY;


--
-- Name: cost_library_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.cost_library_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    trade text DEFAULT 'general'::text NOT NULL,
    code text NOT NULL,
    name text,
    unit text DEFAULT 'ea'::text NOT NULL,
    material_rate numeric(12,4),
    labor_rate numeric(12,4),
    region text,
    source text DEFAULT 'manual'::text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    origin text DEFAULT current_setting('app.tier'::text, true)
);

ALTER TABLE ONLY public.cost_library_items FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE cost_library_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cost_library_items IS 'Shared trade cost library (Deep Dive M5). Additive catalog of (trade, code, unit, material_rate, labor_rate, region?, source) rows. company_id NULL = shared/global reference data; non-NULL = a company''s imported price book. Consulted by pricing.ts only as the lowest-priority fallback (layer 6, BELOW service_items.default_rate) so an empty library changes nothing. Does NOT replace service_items.';


--
-- Name: COLUMN cost_library_items.company_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cost_library_items.company_id IS 'NULL = shared/global catalog row (cross-tenant reference data, read-only to tenants). Non-NULL = that company''s own imported price book.';


--
-- Name: COLUMN cost_library_items.region; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cost_library_items.region IS 'Free-text region tag preserved from the source price book. Regional MULTIPLIER resolution is a follow-up slice — this column only preserves the source value.';


--
-- Name: crew_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.crew_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    scheduled_for date NOT NULL,
    crew jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    state_version integer DEFAULT 1 NOT NULL,
    confirmed_at timestamp with time zone,
    confirmed_by text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    start_time time without time zone,
    end_time time without time zone,
    takeoff_measurement_id uuid,
    created_by text,
    declined_at timestamp with time zone,
    declined_by text,
    decline_reason text
);

ALTER TABLE ONLY public.crew_schedules FORCE ROW LEVEL SECURITY;


--
-- Name: custom_role_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.custom_role_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    custom_role_id uuid NOT NULL,
    company_id uuid NOT NULL,
    action text NOT NULL,
    constraints jsonb
);

ALTER TABLE ONLY public.custom_role_grants FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE custom_role_grants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.custom_role_grants IS 'Extra named actions a custom role grants. action is one of the 9 PERMISSION_ACTIONS; constraints jsonb holds optional caps (e.g. {"max_amount_cents":100000}). company_id is stored redundantly for single-table RLS.';


--
-- Name: custom_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.custom_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    inherit_from text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    created_by text,
    CONSTRAINT custom_roles_inherit_from_check CHECK ((inherit_from = ANY (ARRAY['owner'::text, 'estimator'::text, 'foreman'::text, 'crew'::text, 'bookkeeper'::text])))
);

ALTER TABLE ONLY public.custom_roles FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE custom_roles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.custom_roles IS 'Per-company custom roles. inherit_from is the immutable built-in base; the long tail gates on builtinToCompanyRole(inherit_from), the 9 named actions resolve via the matrix plus this role''s grants. Built-in roles are NOT stored here.';


--
-- Name: customer_portal_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.customer_portal_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    customer_id uuid,
    project_id uuid,
    portal_token text NOT NULL,
    recipient_email text,
    recipient_name text,
    allows jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '180 days'::interval) NOT NULL,
    revoked_at timestamp with time zone,
    viewed_at timestamp with time zone,
    view_count integer DEFAULT 0 NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_portal_links_token_min_length CHECK ((length(portal_token) >= 32))
);

ALTER TABLE ONLY public.customer_portal_links FORCE ROW LEVEL SECURITY;


--
-- Name: customer_pricing_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.customer_pricing_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    service_item_code text NOT NULL,
    rate numeric(12,2) NOT NULL,
    unit text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.customer_pricing_overrides FORCE ROW LEVEL SECURITY;


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    external_id text,
    name text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.customers FORCE ROW LEVEL SECURITY;


--
-- Name: daily_log_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.daily_log_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    daily_log_id uuid NOT NULL,
    storage_key text NOT NULL,
    scope_step_id uuid,
    scope_step_label text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.daily_log_photos FORCE ROW LEVEL SECURITY;


--
-- Name: daily_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.daily_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    occurred_on date NOT NULL,
    foreman_user_id text NOT NULL,
    scope_progress jsonb DEFAULT '[]'::jsonb NOT NULL,
    weather jsonb,
    notes text,
    schedule_deviations jsonb DEFAULT '[]'::jsonb NOT NULL,
    crew_summary jsonb DEFAULT '[]'::jsonb NOT NULL,
    photo_keys text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    submitted_at timestamp with time zone,
    origin text DEFAULT current_setting('app.tier'::text, true),
    version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT daily_logs_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text]))),
    CONSTRAINT daily_logs_submitted_chk CHECK ((((status = 'submitted'::text) AND (submitted_at IS NOT NULL)) OR ((status = 'draft'::text) AND (submitted_at IS NULL))))
);

ALTER TABLE ONLY public.daily_logs FORCE ROW LEVEL SECURITY;


--
-- Name: damage_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.damage_charges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    customer_id uuid,
    shipment_id uuid,
    shipment_line_id uuid,
    inventory_item_id uuid,
    catalog_part_id uuid,
    kind text NOT NULL,
    quantity numeric(14,3) DEFAULT 0 NOT NULL,
    unit_amount numeric(12,2) DEFAULT 0 NOT NULL,
    total_amount numeric(12,2) DEFAULT 0 NOT NULL,
    description text NOT NULL,
    taxable boolean DEFAULT true NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    qbo_invoice_id text,
    invoiced_at timestamp with time zone,
    invoiced_by text,
    waived_at timestamp with time zone,
    waived_by text,
    waive_reason text,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    CONSTRAINT damage_charges_kind_check CHECK ((kind = ANY (ARRAY['damage'::text, 'loss'::text, 'late_return'::text, 'cleanup'::text])))
);

ALTER TABLE ONLY public.damage_charges FORCE ROW LEVEL SECURITY;


--
-- Name: dispatch_lane_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.dispatch_lane_decisions (
    id bigint NOT NULL,
    lane_name text NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    decided_by text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_lane_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.dispatch_lane_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_lane_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_lane_decisions_id_seq OWNED BY public.dispatch_lane_decisions.id;


--
-- Name: dispatch_lanes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.dispatch_lanes (
    name text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    pause_reason text DEFAULT ''::text NOT NULL,
    paused_at timestamp with time zone,
    resume_after timestamp with time zone,
    last_decided_by text DEFAULT ''::text NOT NULL,
    last_decided_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dispatch_lanes_state_check CHECK ((state = ANY (ARRAY['active'::text, 'paused'::text, 'degraded'::text])))
);


--
-- Name: divisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.divisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    sort_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.divisions FORCE ROW LEVEL SECURITY;


--
-- Name: estimate_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.estimate_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    service_item_code text NOT NULL,
    quantity numeric(12,2) DEFAULT 0 NOT NULL,
    unit text NOT NULL,
    rate numeric(12,2) DEFAULT 0 NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    division_code text,
    draft_id uuid NOT NULL,
    assembly_id uuid,
    assembly_component_id uuid,
    kind text,
    unit_canonical text,
    CONSTRAINT estimate_lines_kind_chk CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['material'::text, 'labor'::text, 'sub'::text, 'freight'::text])))),
    CONSTRAINT estimate_lines_unit_canonical_chk CHECK (((unit_canonical IS NULL) OR (unit_canonical = ANY (ARRAY['IN'::text, 'FT'::text, 'LF'::text, 'YD'::text, 'SQIN'::text, 'SQFT'::text, 'SQYD'::text, 'SQUARE'::text, 'CUFT'::text, 'CUYD'::text, 'EA'::text, 'JOB'::text, 'HR'::text]))))
);

ALTER TABLE ONLY public.estimate_lines FORCE ROW LEVEL SECURITY;


--
-- Name: estimate_push_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.estimate_push_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    estimate_push_id uuid NOT NULL,
    source_estimate_line_id uuid,
    description text NOT NULL,
    service_item_code text,
    division_code text,
    quantity numeric(12,4) DEFAULT 0 NOT NULL,
    unit_price numeric(12,4) DEFAULT 0 NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    taxable boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.estimate_push_lines FORCE ROW LEVEL SECURITY;


--
-- Name: estimate_pushes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.estimate_pushes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    customer_id uuid,
    status text DEFAULT 'drafted'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    qbo_estimate_id text,
    reviewed_at timestamp with time zone,
    reviewed_by text,
    approved_at timestamp with time zone,
    approved_by text,
    posted_at timestamp with time zone,
    failed_at timestamp with time zone,
    error text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.estimate_pushes FORCE ROW LEVEL SECURITY;


--
-- Name: estimate_share_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.estimate_share_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    estimate_snapshot jsonb NOT NULL,
    share_token text NOT NULL,
    recipient_email text,
    recipient_name text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    decline_reason text,
    viewed_at timestamp with time zone,
    view_count integer DEFAULT 0 NOT NULL,
    signature_data_url text,
    signer_name text,
    signer_ip inet,
    origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text,
    state_version integer DEFAULT 1 NOT NULL,
    message text,
    include_signed_link boolean DEFAULT true NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT estimate_share_links_share_token_min_length CHECK ((length(share_token) >= 32))
);

ALTER TABLE ONLY public.estimate_share_links FORCE ROW LEVEL SECURITY;


--
-- Name: external_rentals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.external_rentals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    project_id uuid,
    branch_id uuid,
    quantity numeric(12,2) NOT NULL,
    returned_quantity numeric(12,2) DEFAULT 0 NOT NULL,
    vendor_rate numeric(12,2) DEFAULT 0 NOT NULL,
    rate_unit text DEFAULT 'cycle'::text NOT NULL,
    on_rent_date date NOT NULL,
    off_rent_date date,
    vendor_po text,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.external_rentals FORCE ROW LEVEL SECURITY;


--
-- Name: guardrails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.guardrails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    type text NOT NULL,
    threshold numeric(14,4) DEFAULT 0 NOT NULL,
    current_value numeric(14,4) DEFAULT 0 NOT NULL,
    status text DEFAULT 'armed'::text NOT NULL,
    triggered_at timestamp with time zone,
    snoozed_until timestamp with time zone,
    muted_reason text,
    label text DEFAULT ''::text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guardrails_status_check CHECK ((status = ANY (ARRAY['armed'::text, 'triggered'::text, 'snoozed'::text, 'muted'::text]))),
    CONSTRAINT guardrails_type_check CHECK ((type = ANY (ARRAY['margin'::text, 'schedule'::text, 'safety'::text])))
);

ALTER TABLE ONLY public.guardrails FORCE ROW LEVEL SECURITY;


--
-- Name: impersonation_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.impersonation_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id text NOT NULL,
    subject_user_id text NOT NULL,
    reason text NOT NULL,
    mode text DEFAULT 'read_only'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integration_circuit_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.integration_circuit_state (
    integration text NOT NULL,
    state text DEFAULT 'closed'::text NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    last_error text,
    opened_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_circuit_state_state_chk CHECK ((state = ANY (ARRAY['closed'::text, 'open'::text])))
);


--
-- Name: integration_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.integration_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    provider text NOT NULL,
    provider_account_id text,
    access_token text,
    refresh_token text,
    webhook_secret text,
    sync_cursor text,
    last_synced_at timestamp with time zone,
    retry_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    rate_limit_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'connected'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    access_token_expires_at timestamp with time zone,
    qbo_live_enabled boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.integration_connections FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN integration_connections.qbo_live_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.integration_connections.qbo_live_enabled IS 'Per-company QBO live/dry-run switch for the worker push runners. false (default) = stub/dry-run (synthetic ids, no Intuit POST). true = this company MAY push to real QBO, but ONLY when the cluster-wide kill switch (env QBO_LIVE_*=1) also allows it. live = global-env-on AND this-flag-on; either off keeps the company in dry-run. Fail-safe: no company goes live by default.';


--
-- Name: integration_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.integration_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    provider text NOT NULL,
    entity_type text NOT NULL,
    local_ref text NOT NULL,
    external_id text NOT NULL,
    label text,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.integration_mappings FORCE ROW LEVEL SECURITY;


--
-- Name: inventory_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.inventory_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    description text NOT NULL,
    category text DEFAULT 'scaffold'::text NOT NULL,
    unit text DEFAULT 'ea'::text NOT NULL,
    default_rental_rate numeric(12,2) DEFAULT 0 NOT NULL,
    replacement_value numeric(12,2),
    tracking_mode text DEFAULT 'quantity'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.inventory_items FORCE ROW LEVEL SECURITY;


--
-- Name: inventory_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.inventory_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid,
    name text NOT NULL,
    location_type text DEFAULT 'yard'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    branch_id uuid
);

ALTER TABLE ONLY public.inventory_locations FORCE ROW LEVEL SECURITY;


--
-- Name: inventory_movement_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.inventory_movement_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    inventory_movement_id uuid NOT NULL,
    storage_key text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inventory_movement_photos_size_chk CHECK ((size_bytes >= 0))
);

ALTER TABLE ONLY public.inventory_movement_photos FORCE ROW LEVEL SECURITY;


--
-- Name: inventory_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.inventory_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    from_location_id uuid,
    to_location_id uuid,
    project_id uuid,
    movement_type text NOT NULL,
    quantity numeric(12,2) NOT NULL,
    occurred_on date DEFAULT (now())::date NOT NULL,
    ticket_number text,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    worker_id uuid,
    clerk_user_id text,
    scan_payload text,
    scanned_at timestamp with time zone,
    lat numeric(10,7),
    lng numeric(10,7)
);

ALTER TABLE ONLY public.inventory_movements FORCE ROW LEVEL SECURITY;


--
-- Name: inventory_service_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.inventory_service_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_by text,
    completed_at timestamp with time zone,
    notes text,
    tier_origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inventory_service_tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_service'::text, 'done'::text])))
);

ALTER TABLE ONLY public.inventory_service_tickets FORCE ROW LEVEL SECURITY;


--
-- Name: job_rental_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.job_rental_contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    customer_id uuid,
    billing_cycle_days integer DEFAULT 25 NOT NULL,
    billing_mode text DEFAULT 'arrears'::text NOT NULL,
    billing_start_date date NOT NULL,
    last_billed_through date,
    next_billing_date date NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.job_rental_contracts FORCE ROW LEVEL SECURITY;


--
-- Name: job_rental_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.job_rental_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    quantity numeric(12,2) NOT NULL,
    agreed_rate numeric(12,2) DEFAULT 0 NOT NULL,
    rate_unit text DEFAULT 'cycle'::text NOT NULL,
    on_rent_date date NOT NULL,
    off_rent_date date,
    last_billed_through date,
    billable boolean DEFAULT true NOT NULL,
    taxable boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.job_rental_lines FORCE ROW LEVEL SECURITY;


--
-- Name: labor_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.labor_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    worker_id uuid,
    service_item_code text NOT NULL,
    hours numeric(12,2) DEFAULT 0 NOT NULL,
    sqft_done numeric(12,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    occurred_on date NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    division_code text,
    review_locked_at timestamp with time zone,
    review_run_id uuid,
    payroll_run_id uuid
);

ALTER TABLE ONLY public.labor_entries FORCE ROW LEVEL SECURITY;


--
-- Name: labor_payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.labor_payroll_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    state text DEFAULT 'generated'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    approved_at timestamp with time zone,
    approved_by_user_id text,
    posted_at timestamp with time zone,
    failed_at timestamp with time zone,
    error_message text,
    qbo_payroll_batch_ref jsonb,
    covered_labor_entry_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    total_hours numeric(10,2) DEFAULT 0 NOT NULL,
    total_cents bigint DEFAULT 0 NOT NULL,
    time_review_run_id uuid,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    version integer DEFAULT 1 NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_posted boolean DEFAULT false NOT NULL,
    CONSTRAINT labor_payroll_runs_period_chk CHECK ((period_end >= period_start)),
    CONSTRAINT labor_payroll_runs_state_chk CHECK ((state = ANY (ARRAY['generated'::text, 'approved'::text, 'posting'::text, 'posted'::text, 'failed'::text, 'voided'::text])))
);

ALTER TABLE ONLY public.labor_payroll_runs FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN labor_payroll_runs.auto_posted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.labor_payroll_runs.auto_posted IS 'True when the worker auto-post tick advanced this run via AUTO_APPROVE / AUTO_POST_REQUESTED instead of a human APPROVE / POST_REQUESTED. Maps to LaborPayrollWorkflowSnapshot.auto_posted. Default false = human-driven.';


--
-- Name: material_bills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.material_bills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    external_id text,
    vendor_name text NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    bill_type text DEFAULT 'material'::text NOT NULL,
    description text,
    occurred_on date,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true)
);

ALTER TABLE ONLY public.material_bills FORCE ROW LEVEL SECURITY;


--
-- Name: mesh_trace_forward_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.mesh_trace_forward_state (
    company_id uuid NOT NULL,
    event_ref text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    capture_session_id uuid,
    project_key text DEFAULT 'sitelayer'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    forwarded_at timestamp with time zone,
    last_status integer,
    last_error text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT mesh_trace_forward_state_source_kind_check CHECK ((source_kind = ANY (ARRAY['workflow_event_log'::text, 'capture_session_event'::text]))),
    CONSTRAINT mesh_trace_forward_state_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'forwarded'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.mesh_trace_forward_state FORCE ROW LEVEL SECURITY;


--
-- Name: message_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.message_reads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    user_id text NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.message_reads FORCE ROW LEVEL SECURITY;


--
-- Name: mutation_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.mutation_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    device_id text DEFAULT 'server'::text NOT NULL,
    actor_user_id text,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    mutation_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sentry_trace text,
    sentry_baggage text,
    request_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_session_id uuid
);


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    clerk_user_id text NOT NULL,
    channel_assignment_change text DEFAULT 'push'::text NOT NULL,
    channel_time_review_ready text DEFAULT 'push'::text NOT NULL,
    channel_daily_log_reminder text DEFAULT 'push'::text NOT NULL,
    channel_clock_anomaly text DEFAULT 'push'::text NOT NULL,
    sms_phone text,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_preferences_channel_chk CHECK (((channel_assignment_change = ANY (ARRAY['push'::text, 'sms'::text, 'email'::text, 'off'::text])) AND (channel_time_review_ready = ANY (ARRAY['push'::text, 'sms'::text, 'email'::text, 'off'::text])) AND (channel_daily_log_reminder = ANY (ARRAY['push'::text, 'sms'::text, 'email'::text, 'off'::text])) AND (channel_clock_anomaly = ANY (ARRAY['push'::text, 'sms'::text, 'email'::text, 'off'::text]))))
);

ALTER TABLE ONLY public.notification_preferences FORCE ROW LEVEL SECURITY;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    recipient_clerk_user_id text,
    recipient_email text,
    kind text NOT NULL,
    subject text NOT NULL,
    body_text text NOT NULL,
    body_html text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    next_delivery_at timestamp with time zone,
    last_delivery_error text,
    state_version integer DEFAULT 0 NOT NULL,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    CONSTRAINT notifications_at_least_one_recipient CHECK (((recipient_clerk_user_id IS NOT NULL) OR (recipient_email IS NOT NULL)))
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


--
-- Name: payroll_exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.payroll_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    payroll_run_id uuid NOT NULL,
    format text NOT NULL,
    storage_path text,
    download_url text,
    presigned_expires_at timestamp with time zone,
    byte_size bigint,
    row_count integer,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    requested_by_user_id text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    origin text DEFAULT current_setting('app.tier'::text, true),
    CONSTRAINT payroll_exports_format_check CHECK ((format = ANY (ARRAY['xlsx'::text, 'csv'::text, 'xero_csv'::text, 'payworks_csv'::text, 'json'::text]))),
    CONSTRAINT payroll_exports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.payroll_exports FORCE ROW LEVEL SECURITY;


--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.platform_admins (
    clerk_user_id text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pricing_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.pricing_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.pricing_profiles FORCE ROW LEVEL SECURITY;


--
-- Name: project_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.project_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    clerk_user_id text NOT NULL,
    role text NOT NULL,
    assigned_by_clerk_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT project_assignments_role_chk CHECK ((role = ANY (ARRAY['foreman'::text, 'worker'::text])))
);

ALTER TABLE ONLY public.project_assignments FORCE ROW LEVEL SECURITY;


--
-- Name: project_billing_milestones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.project_billing_milestones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    label text NOT NULL,
    pct numeric(6,2),
    amount numeric(14,2),
    sort_order integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'not_yet'::text NOT NULL,
    estimate_push_id uuid,
    invoiced_at timestamp with time zone,
    paid_at timestamp with time zone,
    tier_origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_billing_milestones_status_check CHECK ((status = ANY (ARRAY['not_yet'::text, 'invoiced'::text, 'paid'::text])))
);

ALTER TABLE ONLY public.project_billing_milestones FORCE ROW LEVEL SECURITY;


--
-- Name: project_briefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.project_briefs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    foreman_user_id text NOT NULL,
    effective_date date NOT NULL,
    goal text NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    crew jsonb DEFAULT '[]'::jsonb NOT NULL,
    materials jsonb DEFAULT '[]'::jsonb NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_briefs_goal_nonempty CHECK ((length(TRIM(BOTH FROM goal)) > 0))
);

ALTER TABLE ONLY public.project_briefs FORCE ROW LEVEL SECURITY;


--
-- Name: project_lost_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.project_lost_reasons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    reason text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    lost_value numeric(14,2) DEFAULT 0 NOT NULL,
    recorded_by text,
    origin text DEFAULT current_setting('app.tier'::text, true),
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_lost_reasons_reason_check CHECK ((reason = ANY (ARRAY['price'::text, 'timing'::text, 'scope'::text, 'ghosted'::text, 'competitor'::text, 'other'::text])))
);

ALTER TABLE ONLY public.project_lost_reasons FORCE ROW LEVEL SECURITY;


--
-- Name: project_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.project_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    author_user_id text NOT NULL,
    author_role text DEFAULT ''::text NOT NULL,
    body text NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb
);

ALTER TABLE ONLY public.project_messages FORCE ROW LEVEL SECURITY;


--
-- Name: project_pricing_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.project_pricing_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    service_item_code text NOT NULL,
    rate numeric(12,2) NOT NULL,
    unit text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.project_pricing_overrides FORCE ROW LEVEL SECURITY;


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    customer_id uuid,
    name text NOT NULL,
    customer_name text NOT NULL,
    division_code text NOT NULL,
    status text DEFAULT 'lead'::text NOT NULL,
    bid_total numeric(12,2) DEFAULT 0 NOT NULL,
    labor_rate numeric(12,2) DEFAULT 0 NOT NULL,
    target_sqft_per_hr numeric(12,2),
    bonus_pool numeric(12,2) DEFAULT 0 NOT NULL,
    closed_at timestamp with time zone,
    summary_locked_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    site_lat numeric(9,6),
    site_lng numeric(9,6),
    site_radius_m integer DEFAULT 100,
    state_version integer DEFAULT 1 NOT NULL,
    closed_by text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    auto_clock_in_enabled boolean DEFAULT true NOT NULL,
    auto_clock_out_grace_seconds integer DEFAULT 300 NOT NULL,
    auto_clock_correction_window_seconds integer DEFAULT 120 NOT NULL,
    daily_budget_cents integer DEFAULT 0 NOT NULL,
    lifecycle_state text DEFAULT 'draft'::text NOT NULL,
    lifecycle_state_version integer DEFAULT 1 NOT NULL,
    lifecycle_sent_at timestamp with time zone,
    lifecycle_accepted_at timestamp with time zone,
    lifecycle_declined_at timestamp with time zone,
    lifecycle_decline_reason text,
    lifecycle_started_at timestamp with time zone,
    lifecycle_completed_at timestamp with time zone,
    lifecycle_archived_at timestamp with time zone,
    post_mortem_acknowledged_at timestamp with time zone,
    post_mortem_acknowledged_by text,
    target_margin_pct numeric,
    CONSTRAINT projects_auto_clock_correction_chk CHECK (((auto_clock_correction_window_seconds >= 0) AND (auto_clock_correction_window_seconds <= 1800))),
    CONSTRAINT projects_auto_clock_grace_chk CHECK (((auto_clock_out_grace_seconds >= 0) AND (auto_clock_out_grace_seconds <= 3600))),
    CONSTRAINT projects_daily_budget_cents_chk CHECK ((daily_budget_cents >= 0)),
    CONSTRAINT projects_lifecycle_state_chk CHECK ((lifecycle_state = ANY (ARRAY['draft'::text, 'estimating'::text, 'sent'::text, 'accepted'::text, 'declined'::text, 'in_progress'::text, 'done'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.projects FORCE ROW LEVEL SECURITY;


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    clerk_user_id text NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.push_subscriptions FORCE ROW LEVEL SECURITY;


--
-- Name: qbo_custom_field_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.qbo_custom_field_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    entity_type text NOT NULL,
    field_name text NOT NULL,
    qbo_definition_id text NOT NULL,
    qbo_label text,
    notes text,
    origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT qbo_custom_field_mappings_entity_chk CHECK ((entity_type = ANY (ARRAY['Estimate'::text, 'Invoice'::text, 'Bill'::text, 'PurchaseOrder'::text])))
);

ALTER TABLE ONLY public.qbo_custom_field_mappings FORCE ROW LEVEL SECURITY;


--
-- Name: qbo_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.qbo_sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    integration_connection_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    started_at timestamp with time zone,
    succeeded_at timestamp with time zone,
    failed_at timestamp with time zone,
    retried_at timestamp with time zone,
    error text,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    triggered_by text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.qbo_sync_runs FORCE ROW LEVEL SECURITY;


--
-- Name: rental_billing_run_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.rental_billing_run_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    billing_run_id uuid NOT NULL,
    contract_line_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    quantity numeric(12,2) NOT NULL,
    agreed_rate numeric(12,2) DEFAULT 0 NOT NULL,
    rate_unit text NOT NULL,
    billable_days integer DEFAULT 0 NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    taxable boolean DEFAULT true NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.rental_billing_run_lines FORCE ROW LEVEL SECURITY;


--
-- Name: rental_billing_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.rental_billing_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    project_id uuid NOT NULL,
    customer_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    status text DEFAULT 'generated'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    qbo_invoice_id text,
    approved_at timestamp with time zone,
    approved_by text,
    posted_at timestamp with time zone,
    failed_at timestamp with time zone,
    error text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.rental_billing_runs FORCE ROW LEVEL SECURITY;


--
-- Name: rental_rate_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.rental_rate_tiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    job_rental_line_id uuid NOT NULL,
    rate_unit text NOT NULL,
    min_days integer NOT NULL,
    max_days integer,
    rate numeric(12,2) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rental_rate_tiers_min_days_chk CHECK ((min_days >= 1)),
    CONSTRAINT rental_rate_tiers_range_chk CHECK (((max_days IS NULL) OR (max_days >= min_days))),
    CONSTRAINT rental_rate_tiers_rate_chk CHECK ((rate >= (0)::numeric)),
    CONSTRAINT rental_rate_tiers_unit_chk CHECK ((rate_unit = ANY (ARRAY['day'::text, 'week'::text, 'month'::text, 'cycle'::text, 'each'::text])))
);

ALTER TABLE ONLY public.rental_rate_tiers FORCE ROW LEVEL SECURITY;


--
-- Name: rental_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.rental_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    share_link_id uuid,
    customer_id uuid,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    requested_start date,
    requested_end date,
    contact_name text,
    contact_email text,
    contact_phone text,
    notes text,
    status text DEFAULT 'pending'::text NOT NULL,
    approved_at timestamp with time zone,
    approved_by text,
    rejected_at timestamp with time zone,
    converted_rental_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by_user_id text,
    declined_at timestamp with time zone,
    decline_reason text,
    state_version integer DEFAULT 1 NOT NULL,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text
);

ALTER TABLE ONLY public.rental_requests FORCE ROW LEVEL SECURITY;


--
-- Name: rental_share_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.rental_share_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    customer_id uuid,
    share_token text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.rental_share_links FORCE ROW LEVEL SECURITY;


--
-- Name: rental_vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.rental_vendors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    contact_email text,
    contact_phone text,
    notes text,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.rental_vendors FORCE ROW LEVEL SECURITY;


--
-- Name: rentals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.rentals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid,
    customer_id uuid,
    item_description text NOT NULL,
    daily_rate numeric(12,2) DEFAULT 0 NOT NULL,
    delivered_on date NOT NULL,
    returned_on date,
    next_invoice_at timestamp with time zone,
    invoice_cadence_days integer DEFAULT 7 NOT NULL,
    last_invoice_amount numeric(12,2),
    last_invoiced_through date,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    returned_at timestamp with time zone,
    returned_by text,
    closed_at timestamp with time zone,
    closed_by text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    qty_good integer,
    qty_damaged integer,
    qty_lost integer,
    damage_photos text[] DEFAULT ARRAY[]::text[] NOT NULL,
    damage_charges_cents bigint DEFAULT 0 NOT NULL,
    damage_work_order_id uuid,
    transferred_from_rental_id uuid
);

ALTER TABLE ONLY public.rentals FORCE ROW LEVEL SECURITY;


--
-- Name: scaffold_inspections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scaffold_inspections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    project_id uuid NOT NULL,
    inspector_user_id text NOT NULL,
    inspector_name text,
    status text NOT NULL,
    checklist jsonb DEFAULT '[]'::jsonb NOT NULL,
    photo_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    defects text,
    remediation text,
    signed_at timestamp with time zone DEFAULT now() NOT NULL,
    next_due_on date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scaffold_inspections_status_check CHECK ((status = ANY (ARRAY['pass'::text, 'fail'::text, 'tagged_out'::text])))
);

ALTER TABLE ONLY public.scaffold_inspections FORCE ROW LEVEL SECURITY;


--
-- Name: scaffold_manufacturers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scaffold_manufacturers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    website text,
    notes text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scaffold_systems; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scaffold_systems (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    manufacturer_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scaffold_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scaffold_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    qr_token text NOT NULL,
    label text NOT NULL,
    structure_type text DEFAULT 'scaffold'::text NOT NULL,
    erected_on date,
    dismantled_on date,
    height_m numeric(8,2),
    load_class text,
    last_inspection_id uuid,
    last_inspection_status text,
    last_inspection_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    lat numeric(10,6),
    lng numeric(10,6),
    notes text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.scaffold_tags FORCE ROW LEVEL SECURITY;


--
-- Name: service_item_assemblies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.service_item_assemblies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    service_item_code text NOT NULL,
    name text NOT NULL,
    description text,
    total_rate numeric(12,4) DEFAULT 0 NOT NULL,
    unit text DEFAULT 'sqft'::text NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    deleted_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.service_item_assemblies FORCE ROW LEVEL SECURITY;


--
-- Name: service_item_assembly_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.service_item_assembly_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    assembly_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    quantity_per_unit numeric(12,4) DEFAULT 1 NOT NULL,
    unit text NOT NULL,
    unit_cost numeric(12,4) DEFAULT 0 NOT NULL,
    waste_pct numeric(5,2) DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    quantity_formula text,
    formula_vars jsonb,
    include_when text,
    unit_canonical text,
    CONSTRAINT service_item_assembly_components_cost_chk CHECK ((unit_cost >= (0)::numeric)),
    CONSTRAINT service_item_assembly_components_formula_len_chk CHECK (((quantity_formula IS NULL) OR (length(quantity_formula) <= 500))),
    CONSTRAINT service_item_assembly_components_include_when_len_chk CHECK (((include_when IS NULL) OR (length(include_when) <= 500))),
    CONSTRAINT service_item_assembly_components_kind_chk CHECK ((kind = ANY (ARRAY['material'::text, 'labor'::text, 'sub'::text, 'freight'::text]))),
    CONSTRAINT service_item_assembly_components_qty_chk CHECK ((quantity_per_unit >= (0)::numeric)),
    CONSTRAINT service_item_assembly_components_unit_canonical_chk CHECK (((unit_canonical IS NULL) OR (unit_canonical = ANY (ARRAY['IN'::text, 'FT'::text, 'LF'::text, 'YD'::text, 'SQIN'::text, 'SQFT'::text, 'SQYD'::text, 'SQUARE'::text, 'CUFT'::text, 'CUYD'::text, 'EA'::text, 'JOB'::text, 'HR'::text])))),
    CONSTRAINT service_item_assembly_components_waste_chk CHECK (((waste_pct >= (0)::numeric) AND (waste_pct <= (200)::numeric)))
);

ALTER TABLE ONLY public.service_item_assembly_components FORCE ROW LEVEL SECURITY;


--
-- Name: service_item_divisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.service_item_divisions (
    company_id uuid NOT NULL,
    service_item_code text NOT NULL,
    division_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.service_item_divisions FORCE ROW LEVEL SECURITY;


--
-- Name: service_item_rate_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.service_item_rate_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    service_item_code text NOT NULL,
    rate numeric(12,2),
    unit text DEFAULT 'ea'::text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.service_item_rate_history FORCE ROW LEVEL SECURITY;


--
-- Name: service_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.service_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    unit text NOT NULL,
    default_rate numeric(12,2),
    source text DEFAULT 'manual'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    labor_multiplier numeric(6,3) DEFAULT 1.0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    unit_canonical text,
    CONSTRAINT service_items_status_check CHECK ((status = ANY (ARRAY['active'::text, 'seasonal'::text, 'retired'::text]))),
    CONSTRAINT service_items_unit_canonical_chk CHECK (((unit_canonical IS NULL) OR (unit_canonical = ANY (ARRAY['IN'::text, 'FT'::text, 'LF'::text, 'YD'::text, 'SQIN'::text, 'SQFT'::text, 'SQYD'::text, 'SQUARE'::text, 'CUFT'::text, 'CUYD'::text, 'EA'::text, 'JOB'::text, 'HR'::text]))))
);

ALTER TABLE ONLY public.service_items FORCE ROW LEVEL SECURITY;


--
-- Name: shipment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.shipment_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    shipment_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    state_before text,
    state_after text,
    state_version integer NOT NULL,
    produced_by text DEFAULT 'system'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.shipment_events FORCE ROW LEVEL SECURITY;


--
-- Name: shipment_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.shipment_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    shipment_id uuid NOT NULL,
    inventory_item_id uuid,
    catalog_part_id uuid,
    bom_line_id uuid,
    quantity_planned numeric(14,3) NOT NULL,
    quantity_shipped numeric(14,3) DEFAULT 0 NOT NULL,
    quantity_delivered numeric(14,3) DEFAULT 0 NOT NULL,
    quantity_returned numeric(14,3) DEFAULT 0 NOT NULL,
    quantity_damaged numeric(14,3) DEFAULT 0 NOT NULL,
    quantity_lost numeric(14,3) DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shipment_lines_check CHECK ((((inventory_item_id IS NOT NULL) AND (catalog_part_id IS NULL)) OR ((inventory_item_id IS NULL) AND (catalog_part_id IS NOT NULL))))
);

ALTER TABLE ONLY public.shipment_lines FORCE ROW LEVEL SECURITY;


--
-- Name: shipments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.shipments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    bom_id uuid,
    source_branch_id uuid,
    destination_location_id uuid,
    direction text DEFAULT 'outbound'::text NOT NULL,
    status text DEFAULT 'planned'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    scheduled_for date,
    shipped_at timestamp with time zone,
    delivered_at timestamp with time zone,
    confirmed_by text,
    driver text,
    ticket_number text,
    notes text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.shipments FORCE ROW LEVEL SECURITY;


--
-- Name: support_debug_packets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.support_debug_packets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    actor_user_id text NOT NULL,
    request_id text,
    route text,
    build_sha text,
    problem text,
    client jsonb DEFAULT '{}'::jsonb NOT NULL,
    server_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    redaction_version text DEFAULT 'support-packet-v1'::text NOT NULL,
    capture_session_id uuid
);

ALTER TABLE ONLY public.support_debug_packets FORCE ROW LEVEL SECURITY;


--
-- Name: support_packet_access_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.support_packet_access_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    support_packet_id uuid NOT NULL,
    actor_user_id text NOT NULL,
    access_type text NOT NULL,
    route text,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT support_packet_access_type_check CHECK ((access_type = ANY (ARRAY['read'::text, 'list'::text, 'agent_prompt'::text, 'export'::text])))
);

ALTER TABLE ONLY public.support_packet_access_log FORCE ROW LEVEL SECURITY;


--
-- Name: sync_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.sync_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    integration_connection_id uuid,
    direction text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sentry_trace text,
    sentry_baggage text,
    request_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_session_id uuid
);


--
-- Name: takeoff_capture_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.takeoff_capture_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    kind text NOT NULL,
    blob_uri text NOT NULL,
    mime text,
    size_bytes bigint,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.takeoff_capture_artifacts FORCE ROW LEVEL SECURITY;


--
-- Name: takeoff_conditions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.takeoff_conditions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#2f7d32'::text NOT NULL,
    measurement_kind text DEFAULT 'area'::text NOT NULL,
    height_value numeric(12,4),
    thickness_value numeric(12,4),
    sides integer,
    slope_value numeric(12,4),
    default_assembly_id uuid,
    emit_linear boolean DEFAULT false NOT NULL,
    emit_area boolean DEFAULT true NOT NULL,
    emit_volume boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    origin text DEFAULT current_setting('app.tier'::text, true),
    CONSTRAINT takeoff_conditions_measurement_kind_check CHECK ((measurement_kind = ANY (ARRAY['area'::text, 'linear'::text, 'count'::text, 'volume'::text]))),
    CONSTRAINT takeoff_conditions_sides_check CHECK (((sides IS NULL) OR (sides = ANY (ARRAY[1, 2]))))
);

ALTER TABLE ONLY public.takeoff_conditions FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE takeoff_conditions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.takeoff_conditions IS 'Company-level reusable typed takeoff template (Deep Dive H1). Fixes measurement_kind + drivers (height/thickness/sides/slope) + an optional default assembly + result-emission flags. Additive: measurements record condition_id but the legacy tag model remains the fallback (no backfill).';


--
-- Name: takeoff_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.takeoff_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'measurement'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    takeoff_result_blob_uri text,
    review_required boolean DEFAULT false NOT NULL,
    pipeline_version text,
    takeoff_result_json jsonb,
    kind text DEFAULT 'takeoff'::text NOT NULL,
    measured_blueprint_document_id uuid,
    count_scope_json jsonb,
    CONSTRAINT takeoff_drafts_kind_check CHECK ((kind = ANY (ARRAY['takeoff'::text, 'count'::text]))),
    CONSTRAINT takeoff_drafts_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'roomplan'::text, 'photogrammetry'::text, 'drone'::text, 'blueprint_vision'::text]))),
    CONSTRAINT takeoff_drafts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.takeoff_drafts FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN takeoff_drafts.measured_blueprint_document_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.takeoff_drafts.measured_blueprint_document_id IS 'Blueprint document revision this draft''s measurements were taken against (H3 version stamp). NULL = unstamped. Writer wiring is a follow-up slice.';


--
-- Name: COLUMN takeoff_drafts.count_scope_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.takeoff_drafts.count_scope_json IS 'Per-symbol AI count scope this capture was run against (M1): { symbol, sheets[], sensitivity }. NULL = whole-draft capture (no symbol chosen). Live single-symbol detection is a follow-up slice.';


--
-- Name: takeoff_measurement_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.takeoff_measurement_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    measurement_id uuid NOT NULL,
    service_item_code text NOT NULL,
    quantity numeric(14,4) DEFAULT 0 NOT NULL,
    unit text DEFAULT 'sqft'::text NOT NULL,
    rate numeric(12,4) DEFAULT 0 NOT NULL,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT takeoff_measurement_tags_quantity_chk CHECK ((quantity >= (0)::numeric)),
    CONSTRAINT takeoff_measurement_tags_rate_chk CHECK ((rate >= (0)::numeric))
);

ALTER TABLE ONLY public.takeoff_measurement_tags FORCE ROW LEVEL SECURITY;


--
-- Name: takeoff_measurements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.takeoff_measurements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid NOT NULL,
    blueprint_document_id uuid,
    service_item_code text NOT NULL,
    quantity numeric(12,2) DEFAULT 0 NOT NULL,
    unit text NOT NULL,
    notes text,
    geometry jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT current_setting('app.tier'::text, true),
    division_code text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    page_id uuid,
    geometry_kind text DEFAULT 'polygon'::text NOT NULL,
    elevation text,
    image_thumbnail text,
    draft_id uuid NOT NULL,
    is_deduction boolean DEFAULT false NOT NULL,
    assembly_id uuid,
    condition_id uuid,
    unit_canonical text,
    CONSTRAINT takeoff_measurements_geometry_kind_chk CHECK ((geometry_kind = ANY (ARRAY['polygon'::text, 'lineal'::text, 'count'::text, 'volume'::text]))),
    CONSTRAINT takeoff_measurements_unit_canonical_chk CHECK (((unit_canonical IS NULL) OR (unit_canonical = ANY (ARRAY['IN'::text, 'FT'::text, 'LF'::text, 'YD'::text, 'SQIN'::text, 'SQFT'::text, 'SQYD'::text, 'SQUARE'::text, 'CUFT'::text, 'CUYD'::text, 'EA'::text, 'JOB'::text, 'HR'::text]))))
);

ALTER TABLE ONLY public.takeoff_measurements FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN takeoff_measurements.condition_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.takeoff_measurements.condition_id IS 'Optional link to the takeoff_conditions row this measurement was drawn against (Deep Dive H1). NULL = legacy shape-first measurement (tags/flat-line). Additive, no backfill — existing rows stay NULL.';


--
-- Name: tenant_provisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.tenant_provisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'company_pending'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    slug text,
    name text,
    company_id uuid,
    seed_request jsonb DEFAULT '{}'::jsonb NOT NULL,
    invited jsonb DEFAULT '[]'::jsonb NOT NULL,
    failed_seeds jsonb DEFAULT '[]'::jsonb NOT NULL,
    error text,
    suggested_slug text,
    created_by text,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: time_review_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.time_review_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    state_version integer DEFAULT 1 NOT NULL,
    covered_entry_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    total_hours numeric(10,2) DEFAULT 0 NOT NULL,
    total_entries integer DEFAULT 0 NOT NULL,
    anomaly_count integer DEFAULT 0 NOT NULL,
    reviewer_user_id text,
    approved_at timestamp with time zone,
    rejected_at timestamp with time zone,
    rejection_reason text,
    reopened_at timestamp with time zone,
    workflow_engine text DEFAULT 'postgres'::text NOT NULL,
    workflow_run_id text,
    origin text DEFAULT current_setting('app.tier'::text, true),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT time_review_runs_decision_chk CHECK ((((state = 'pending'::text) AND (approved_at IS NULL) AND (rejected_at IS NULL)) OR ((state = 'approved'::text) AND (approved_at IS NOT NULL) AND (rejected_at IS NULL)) OR ((state = 'rejected'::text) AND (rejected_at IS NOT NULL) AND (approved_at IS NULL)))),
    CONSTRAINT time_review_runs_period_chk CHECK ((period_end >= period_start)),
    CONSTRAINT time_review_runs_state_chk CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.time_review_runs FORCE ROW LEVEL SECURITY;


--
-- Name: worker_issue_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.worker_issue_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    worker_issue_id uuid NOT NULL,
    kind text NOT NULL,
    storage_key text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_session_id uuid,
    CONSTRAINT worker_issue_attachments_kind_chk CHECK ((kind = ANY (ARRAY['voice'::text, 'photo'::text]))),
    CONSTRAINT worker_issue_attachments_size_chk CHECK ((size_bytes >= 0))
);

ALTER TABLE ONLY public.worker_issue_attachments FORCE ROW LEVEL SECURITY;


--
-- Name: worker_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.worker_issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    project_id uuid,
    worker_id uuid,
    reporter_clerk_user_id text NOT NULL,
    kind text NOT NULL,
    message text NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by_clerk_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    severity text DEFAULT 'slowing'::text NOT NULL,
    resolved_action text,
    resolution_message text,
    state_version integer DEFAULT 1 NOT NULL,
    escalated_to_estimator_at timestamp with time zone,
    escalation_reason text,
    state text DEFAULT 'open'::text NOT NULL,
    dismissed_at timestamp with time zone,
    dismissed_by_clerk_user_id text,
    capture_session_id uuid,
    material_label text,
    material_quantity numeric,
    material_unit text,
    CONSTRAINT worker_issues_kind_chk CHECK ((kind = ANY (ARRAY['materials_out'::text, 'crew_short'::text, 'safety'::text, 'other'::text]))),
    CONSTRAINT worker_issues_material_label_len_chk CHECK (((material_label IS NULL) OR ((char_length(material_label) >= 1) AND (char_length(material_label) <= 200)))),
    CONSTRAINT worker_issues_material_quantity_chk CHECK (((material_quantity IS NULL) OR (material_quantity >= (0)::numeric))),
    CONSTRAINT worker_issues_material_unit_len_chk CHECK (((material_unit IS NULL) OR ((char_length(material_unit) >= 1) AND (char_length(material_unit) <= 32)))),
    CONSTRAINT worker_issues_message_len_chk CHECK (((char_length(message) >= 1) AND (char_length(message) <= 2000))),
    CONSTRAINT worker_issues_resolution_message_len_chk CHECK (((resolution_message IS NULL) OR ((char_length(resolution_message) >= 1) AND (char_length(resolution_message) <= 4000)))),
    CONSTRAINT worker_issues_severity_chk CHECK ((severity = ANY (ARRAY['question'::text, 'slowing'::text, 'stopped'::text]))),
    CONSTRAINT worker_issues_state_chk CHECK ((state = ANY (ARRAY['open'::text, 'resolved'::text, 'escalated'::text, 'dismissed'::text])))
);

ALTER TABLE ONLY public.worker_issues FORCE ROW LEVEL SECURITY;


--
-- Name: workers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.workers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    role text DEFAULT 'crew'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    base_hourly_cents integer DEFAULT 0 NOT NULL,
    insurance_pct numeric(5,2) DEFAULT 20 NOT NULL,
    benefits_pct numeric(5,2) DEFAULT 8 NOT NULL,
    ot_premium_pct numeric(5,2) DEFAULT 50 NOT NULL,
    CONSTRAINT workers_base_hourly_cents_chk CHECK ((base_hourly_cents >= 0)),
    CONSTRAINT workers_benefits_pct_chk CHECK (((benefits_pct >= (0)::numeric) AND (benefits_pct <= (200)::numeric))),
    CONSTRAINT workers_insurance_pct_chk CHECK (((insurance_pct >= (0)::numeric) AND (insurance_pct <= (200)::numeric))),
    CONSTRAINT workers_ot_premium_pct_chk CHECK (((ot_premium_pct >= (0)::numeric) AND (ot_premium_pct <= (200)::numeric)))
);

ALTER TABLE ONLY public.workers FORCE ROW LEVEL SECURITY;


--
-- Name: workflow_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.workflow_event_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    workflow_name text NOT NULL,
    schema_version integer NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    state_version integer NOT NULL,
    event_type text NOT NULL,
    event_payload jsonb NOT NULL,
    snapshot_after jsonb NOT NULL,
    actor_user_id text,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id text,
    sentry_trace text,
    sentry_baggage text,
    capture_session_id uuid
);


--
-- Name: audit_escrow_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_escrow_entries ALTER COLUMN id SET DEFAULT nextval('public.audit_escrow_entries_id_seq'::regclass);


--
-- Name: dispatch_lane_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_lane_decisions ALTER COLUMN id SET DEFAULT nextval('public.dispatch_lane_decisions_id_seq'::regclass);


--
-- Name: ai_insights ai_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.ai_insights
      ADD CONSTRAINT ai_insights_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_company_id_inventory_movement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_company_id_inventory_movement_id_key UNIQUE (company_id, inventory_movement_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: audit_escrow_entries audit_escrow_entries_entry_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.audit_escrow_entries
      ADD CONSTRAINT audit_escrow_entries_entry_hash_key UNIQUE (entry_hash);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: audit_escrow_entries audit_escrow_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.audit_escrow_entries
      ADD CONSTRAINT audit_escrow_entries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: audit_escrow_keys audit_escrow_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.audit_escrow_keys
      ADD CONSTRAINT audit_escrow_keys_pkey PRIMARY KEY (key_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.audit_events
      ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_documents blueprint_documents_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_documents
      ADD CONSTRAINT blueprint_documents_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_documents blueprint_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_documents
      ADD CONSTRAINT blueprint_documents_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_page_diffs blueprint_page_diffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_page_diffs
      ADD CONSTRAINT blueprint_page_diffs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_pages blueprint_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_pages
      ADD CONSTRAINT blueprint_pages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_pages blueprint_pages_unique_page; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_pages
      ADD CONSTRAINT blueprint_pages_unique_page UNIQUE (blueprint_document_id, page_number);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: bom_lines bom_lines_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.bom_lines
      ADD CONSTRAINT bom_lines_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: bom_lines bom_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.bom_lines
      ADD CONSTRAINT bom_lines_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: boms boms_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.boms
      ADD CONSTRAINT boms_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: boms boms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.boms
      ADD CONSTRAINT boms_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: bonus_rules bonus_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.bonus_rules
      ADD CONSTRAINT bonus_rules_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: branches branches_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.branches
      ADD CONSTRAINT branches_company_id_code_key UNIQUE (company_id, code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: branches branches_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.branches
      ADD CONSTRAINT branches_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.branches
      ADD CONSTRAINT branches_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: broadcasts broadcasts_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.broadcasts
      ADD CONSTRAINT broadcasts_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: broadcasts broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.broadcasts
      ADD CONSTRAINT broadcasts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshot_lines budget_snapshot_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshot_lines
      ADD CONSTRAINT budget_snapshot_lines_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshots budget_snapshots_company_id_uk; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshots
      ADD CONSTRAINT budget_snapshots_company_id_uk UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshots budget_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshots
      ADD CONSTRAINT budget_snapshots_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: capture_artifacts capture_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.capture_artifacts
      ADD CONSTRAINT capture_artifacts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: capture_session_events capture_session_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.capture_session_events
      ADD CONSTRAINT capture_session_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: capture_sessions capture_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.capture_sessions
      ADD CONSTRAINT capture_sessions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: catalog_parts catalog_parts_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.catalog_parts
      ADD CONSTRAINT catalog_parts_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: catalog_parts catalog_parts_company_id_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.catalog_parts
      ADD CONSTRAINT catalog_parts_company_id_sku_key UNIQUE (company_id, sku);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: catalog_parts catalog_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.catalog_parts
      ADD CONSTRAINT catalog_parts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: change_orders change_orders_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.change_orders
      ADD CONSTRAINT change_orders_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: change_orders change_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.change_orders
      ADD CONSTRAINT change_orders_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: change_orders change_orders_project_id_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.change_orders
      ADD CONSTRAINT change_orders_project_id_number_key UNIQUE (project_id, number);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: clerk_users clerk_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.clerk_users
      ADD CONSTRAINT clerk_users_pkey PRIMARY KEY (clerk_user_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: clock_events clock_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.clock_events
      ADD CONSTRAINT clock_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: companies companies_labor_payroll_auto_post_weekday_chk; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE public.companies
      ADD CONSTRAINT companies_labor_payroll_auto_post_weekday_chk CHECK (((labor_payroll_auto_post_weekday IS NULL) OR ((labor_payroll_auto_post_weekday >= 1) AND (labor_payroll_auto_post_weekday <= 7)))) NOT VALID;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.companies
      ADD CONSTRAINT companies_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: companies companies_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.companies
      ADD CONSTRAINT companies_slug_key UNIQUE (slug);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_bootstrap_state company_bootstrap_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_bootstrap_state
      ADD CONSTRAINT company_bootstrap_state_pkey PRIMARY KEY (company_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_invites company_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_invites
      ADD CONSTRAINT company_invites_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_invites company_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_invites
      ADD CONSTRAINT company_invites_token_key UNIQUE (token);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_memberships company_memberships_company_id_clerk_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_memberships
      ADD CONSTRAINT company_memberships_company_id_clerk_user_id_key UNIQUE (company_id, clerk_user_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_memberships company_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_memberships
      ADD CONSTRAINT company_memberships_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_pricing_overrides company_pricing_overrides_company_id_service_item_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_pricing_overrides
      ADD CONSTRAINT company_pricing_overrides_company_id_service_item_code_key UNIQUE (company_id, service_item_code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_pricing_overrides company_pricing_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_pricing_overrides
      ADD CONSTRAINT company_pricing_overrides_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_usage_log company_usage_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_usage_log
      ADD CONSTRAINT company_usage_log_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: companycam_photo_imports companycam_photo_imports_company_id_external_photo_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.companycam_photo_imports
      ADD CONSTRAINT companycam_photo_imports_company_id_external_photo_id_key UNIQUE (company_id, external_photo_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: companycam_photo_imports companycam_photo_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.companycam_photo_imports
      ADD CONSTRAINT companycam_photo_imports_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: context_handoff_events context_handoff_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.context_handoff_events
      ADD CONSTRAINT context_handoff_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: context_work_items context_work_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.context_work_items
      ADD CONSTRAINT context_work_items_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: cost_library_items cost_library_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.cost_library_items
      ADD CONSTRAINT cost_library_items_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: crew_schedules crew_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.crew_schedules
      ADD CONSTRAINT crew_schedules_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: custom_role_grants custom_role_grants_custom_role_id_action_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.custom_role_grants
      ADD CONSTRAINT custom_role_grants_custom_role_id_action_key UNIQUE (custom_role_id, action);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: custom_role_grants custom_role_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.custom_role_grants
      ADD CONSTRAINT custom_role_grants_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: custom_roles custom_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.custom_roles
      ADD CONSTRAINT custom_roles_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_portal_links customer_portal_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_portal_links
      ADD CONSTRAINT customer_portal_links_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_portal_links customer_portal_links_portal_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_portal_links
      ADD CONSTRAINT customer_portal_links_portal_token_key UNIQUE (portal_token);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_pricing_overrides customer_pricing_overrides_company_id_customer_id_service_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_pricing_overrides
      ADD CONSTRAINT customer_pricing_overrides_company_id_customer_id_service_i_key UNIQUE (company_id, customer_id, service_item_code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_pricing_overrides customer_pricing_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_pricing_overrides
      ADD CONSTRAINT customer_pricing_overrides_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customers customers_company_id_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customers
      ADD CONSTRAINT customers_company_id_external_id_key UNIQUE (company_id, external_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customers customers_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customers
      ADD CONSTRAINT customers_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customers
      ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: daily_log_photos daily_log_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.daily_log_photos
      ADD CONSTRAINT daily_log_photos_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: daily_log_photos daily_log_photos_unique_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.daily_log_photos
      ADD CONSTRAINT daily_log_photos_unique_key UNIQUE (daily_log_id, storage_key);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: daily_logs daily_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.daily_logs
      ADD CONSTRAINT daily_logs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: daily_logs daily_logs_unique_per_foreman_day; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.daily_logs
      ADD CONSTRAINT daily_logs_unique_per_foreman_day UNIQUE (company_id, project_id, occurred_on, foreman_user_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: dispatch_lane_decisions dispatch_lane_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.dispatch_lane_decisions
      ADD CONSTRAINT dispatch_lane_decisions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: dispatch_lanes dispatch_lanes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.dispatch_lanes
      ADD CONSTRAINT dispatch_lanes_pkey PRIMARY KEY (name);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: divisions divisions_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.divisions
      ADD CONSTRAINT divisions_company_id_code_key UNIQUE (company_id, code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: divisions divisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.divisions
      ADD CONSTRAINT divisions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_lines estimate_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_lines
      ADD CONSTRAINT estimate_lines_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_push_lines estimate_push_lines_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_push_lines
      ADD CONSTRAINT estimate_push_lines_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_push_lines estimate_push_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_push_lines
      ADD CONSTRAINT estimate_push_lines_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_pushes estimate_pushes_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_pushes
      ADD CONSTRAINT estimate_pushes_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_pushes estimate_pushes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_pushes
      ADD CONSTRAINT estimate_pushes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_share_links estimate_share_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_share_links
      ADD CONSTRAINT estimate_share_links_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_share_links estimate_share_links_share_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_share_links
      ADD CONSTRAINT estimate_share_links_share_token_key UNIQUE (share_token);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: external_rentals external_rentals_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.external_rentals
      ADD CONSTRAINT external_rentals_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: external_rentals external_rentals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.external_rentals
      ADD CONSTRAINT external_rentals_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: guardrails guardrails_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.guardrails
      ADD CONSTRAINT guardrails_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: guardrails guardrails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.guardrails
      ADD CONSTRAINT guardrails_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: guardrails guardrails_project_id_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.guardrails
      ADD CONSTRAINT guardrails_project_id_type_key UNIQUE (project_id, type);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: impersonation_sessions impersonation_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.impersonation_sessions
      ADD CONSTRAINT impersonation_sessions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: integration_circuit_state integration_circuit_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.integration_circuit_state
      ADD CONSTRAINT integration_circuit_state_pkey PRIMARY KEY (integration);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: integration_connections integration_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.integration_connections
      ADD CONSTRAINT integration_connections_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: integration_mappings integration_mappings_company_id_provider_entity_type_local__key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.integration_mappings
      ADD CONSTRAINT integration_mappings_company_id_provider_entity_type_local__key UNIQUE (company_id, provider, entity_type, local_ref);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: integration_mappings integration_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.integration_mappings
      ADD CONSTRAINT integration_mappings_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_items inventory_items_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_items
      ADD CONSTRAINT inventory_items_company_id_code_key UNIQUE (company_id, code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_items inventory_items_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_items
      ADD CONSTRAINT inventory_items_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_items inventory_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_items
      ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_locations inventory_locations_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_locations
      ADD CONSTRAINT inventory_locations_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_locations inventory_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_locations
      ADD CONSTRAINT inventory_locations_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movement_photos inventory_movement_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movement_photos
      ADD CONSTRAINT inventory_movement_photos_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_service_tickets inventory_service_tickets_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_service_tickets
      ADD CONSTRAINT inventory_service_tickets_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_service_tickets inventory_service_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_service_tickets
      ADD CONSTRAINT inventory_service_tickets_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_contracts job_rental_contracts_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_contracts
      ADD CONSTRAINT job_rental_contracts_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_contracts job_rental_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_contracts
      ADD CONSTRAINT job_rental_contracts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_lines job_rental_lines_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_lines
      ADD CONSTRAINT job_rental_lines_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_lines job_rental_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_lines
      ADD CONSTRAINT job_rental_lines_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_entries labor_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_entries
      ADD CONSTRAINT labor_entries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_payroll_runs labor_payroll_runs_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_payroll_runs
      ADD CONSTRAINT labor_payroll_runs_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_payroll_runs labor_payroll_runs_company_id_period_start_period_end_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_payroll_runs
      ADD CONSTRAINT labor_payroll_runs_company_id_period_start_period_end_key UNIQUE (company_id, period_start, period_end);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_payroll_runs labor_payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_payroll_runs
      ADD CONSTRAINT labor_payroll_runs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: material_bills material_bills_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.material_bills
      ADD CONSTRAINT material_bills_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: material_bills material_bills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.material_bills
      ADD CONSTRAINT material_bills_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: mesh_trace_forward_state mesh_trace_forward_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.mesh_trace_forward_state
      ADD CONSTRAINT mesh_trace_forward_state_pkey PRIMARY KEY (company_id, event_ref);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: message_reads message_reads_company_id_project_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.message_reads
      ADD CONSTRAINT message_reads_company_id_project_id_user_id_key UNIQUE (company_id, project_id, user_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: message_reads message_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.message_reads
      ADD CONSTRAINT message_reads_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: mutation_outbox mutation_outbox_company_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.mutation_outbox
      ADD CONSTRAINT mutation_outbox_company_id_idempotency_key_key UNIQUE (company_id, idempotency_key);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: mutation_outbox mutation_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.mutation_outbox
      ADD CONSTRAINT mutation_outbox_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.notification_preferences
      ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: notification_preferences notification_preferences_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.notification_preferences
      ADD CONSTRAINT notification_preferences_unique UNIQUE (company_id, clerk_user_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: payroll_exports payroll_exports_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.payroll_exports
      ADD CONSTRAINT payroll_exports_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: payroll_exports payroll_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.payroll_exports
      ADD CONSTRAINT payroll_exports_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.platform_admins
      ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (clerk_user_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: pricing_profiles pricing_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.pricing_profiles
      ADD CONSTRAINT pricing_profiles_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_assignments project_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_assignments
      ADD CONSTRAINT project_assignments_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_billing_milestones project_billing_milestones_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_billing_milestones
      ADD CONSTRAINT project_billing_milestones_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_billing_milestones project_billing_milestones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_billing_milestones
      ADD CONSTRAINT project_billing_milestones_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_briefs project_briefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_briefs
      ADD CONSTRAINT project_briefs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_lost_reasons project_lost_reasons_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_lost_reasons
      ADD CONSTRAINT project_lost_reasons_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_lost_reasons project_lost_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_lost_reasons
      ADD CONSTRAINT project_lost_reasons_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_lost_reasons project_lost_reasons_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_lost_reasons
      ADD CONSTRAINT project_lost_reasons_project_id_key UNIQUE (project_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_messages project_messages_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_messages
      ADD CONSTRAINT project_messages_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_messages project_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_messages
      ADD CONSTRAINT project_messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_pricing_overrides project_pricing_overrides_company_id_project_id_service_ite_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_pricing_overrides
      ADD CONSTRAINT project_pricing_overrides_company_id_project_id_service_ite_key UNIQUE (company_id, project_id, service_item_code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_pricing_overrides project_pricing_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_pricing_overrides
      ADD CONSTRAINT project_pricing_overrides_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: projects projects_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.projects
      ADD CONSTRAINT projects_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.projects
      ADD CONSTRAINT projects_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.push_subscriptions
      ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: push_subscriptions push_subscriptions_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.push_subscriptions
      ADD CONSTRAINT push_subscriptions_unique UNIQUE (clerk_user_id, endpoint);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: qbo_custom_field_mappings qbo_custom_field_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.qbo_custom_field_mappings
      ADD CONSTRAINT qbo_custom_field_mappings_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: qbo_custom_field_mappings qbo_custom_field_mappings_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.qbo_custom_field_mappings
      ADD CONSTRAINT qbo_custom_field_mappings_unique UNIQUE (company_id, entity_type, field_name);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: qbo_sync_runs qbo_sync_runs_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.qbo_sync_runs
      ADD CONSTRAINT qbo_sync_runs_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: qbo_sync_runs qbo_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.qbo_sync_runs
      ADD CONSTRAINT qbo_sync_runs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_run_lines rental_billing_run_lines_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_run_lines
      ADD CONSTRAINT rental_billing_run_lines_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_run_lines rental_billing_run_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_run_lines
      ADD CONSTRAINT rental_billing_run_lines_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_runs rental_billing_runs_company_id_contract_id_period_start_per_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_runs
      ADD CONSTRAINT rental_billing_runs_company_id_contract_id_period_start_per_key UNIQUE (company_id, contract_id, period_start, period_end);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_runs rental_billing_runs_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_runs
      ADD CONSTRAINT rental_billing_runs_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_runs rental_billing_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_runs
      ADD CONSTRAINT rental_billing_runs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_rate_tiers rental_rate_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_rate_tiers
      ADD CONSTRAINT rental_rate_tiers_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_requests rental_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_requests
      ADD CONSTRAINT rental_requests_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_share_links rental_share_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_share_links
      ADD CONSTRAINT rental_share_links_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_share_links rental_share_links_share_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_share_links
      ADD CONSTRAINT rental_share_links_share_token_key UNIQUE (share_token);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_vendors rental_vendors_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_vendors
      ADD CONSTRAINT rental_vendors_company_id_code_key UNIQUE (company_id, code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_vendors rental_vendors_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_vendors
      ADD CONSTRAINT rental_vendors_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_vendors rental_vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_vendors
      ADD CONSTRAINT rental_vendors_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rentals rentals_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rentals
      ADD CONSTRAINT rentals_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rentals rentals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rentals
      ADD CONSTRAINT rentals_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_inspections scaffold_inspections_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_inspections
      ADD CONSTRAINT scaffold_inspections_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_inspections scaffold_inspections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_inspections
      ADD CONSTRAINT scaffold_inspections_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_manufacturers scaffold_manufacturers_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_manufacturers
      ADD CONSTRAINT scaffold_manufacturers_company_id_code_key UNIQUE (company_id, code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_manufacturers scaffold_manufacturers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_manufacturers
      ADD CONSTRAINT scaffold_manufacturers_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_systems scaffold_systems_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_systems
      ADD CONSTRAINT scaffold_systems_company_id_code_key UNIQUE (company_id, code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_systems scaffold_systems_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_systems
      ADD CONSTRAINT scaffold_systems_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_tags scaffold_tags_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_tags
      ADD CONSTRAINT scaffold_tags_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_tags scaffold_tags_company_id_qr_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_tags
      ADD CONSTRAINT scaffold_tags_company_id_qr_token_key UNIQUE (company_id, qr_token);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_tags scaffold_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_tags
      ADD CONSTRAINT scaffold_tags_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_assemblies service_item_assemblies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_assemblies
      ADD CONSTRAINT service_item_assemblies_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_assembly_components service_item_assembly_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_assembly_components
      ADD CONSTRAINT service_item_assembly_components_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_divisions service_item_divisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_divisions
      ADD CONSTRAINT service_item_divisions_pkey PRIMARY KEY (company_id, service_item_code, division_code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_rate_history service_item_rate_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_rate_history
      ADD CONSTRAINT service_item_rate_history_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_items service_items_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_items
      ADD CONSTRAINT service_items_company_id_code_key UNIQUE (company_id, code);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_items service_items_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_items
      ADD CONSTRAINT service_items_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_items service_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_items
      ADD CONSTRAINT service_items_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_events shipment_events_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_events
      ADD CONSTRAINT shipment_events_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_events shipment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_events
      ADD CONSTRAINT shipment_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_lines shipment_lines_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_lines
      ADD CONSTRAINT shipment_lines_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_lines shipment_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_lines
      ADD CONSTRAINT shipment_lines_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipments shipments_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipments
      ADD CONSTRAINT shipments_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipments shipments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipments
      ADD CONSTRAINT shipments_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: support_debug_packets support_debug_packets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.support_debug_packets
      ADD CONSTRAINT support_debug_packets_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: support_packet_access_log support_packet_access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.support_packet_access_log
      ADD CONSTRAINT support_packet_access_log_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: sync_events sync_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.sync_events
      ADD CONSTRAINT sync_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_capture_artifacts takeoff_capture_artifacts_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_capture_artifacts
      ADD CONSTRAINT takeoff_capture_artifacts_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_capture_artifacts takeoff_capture_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_capture_artifacts
      ADD CONSTRAINT takeoff_capture_artifacts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_conditions takeoff_conditions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_conditions
      ADD CONSTRAINT takeoff_conditions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_drafts takeoff_drafts_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_drafts takeoff_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurement_tags takeoff_measurement_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurement_tags
      ADD CONSTRAINT takeoff_measurement_tags_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: tenant_provisions tenant_provisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.tenant_provisions
      ADD CONSTRAINT tenant_provisions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: time_review_runs time_review_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.time_review_runs
      ADD CONSTRAINT time_review_runs_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: worker_issue_attachments worker_issue_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.worker_issue_attachments
      ADD CONSTRAINT worker_issue_attachments_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: worker_issues worker_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.worker_issues
      ADD CONSTRAINT worker_issues_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: workers workers_company_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.workers
      ADD CONSTRAINT workers_company_id_id_key UNIQUE (company_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: workers workers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.workers
      ADD CONSTRAINT workers_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: workflow_event_log workflow_event_log_entity_workflow_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.workflow_event_log
      ADD CONSTRAINT workflow_event_log_entity_workflow_version_key UNIQUE (entity_id, workflow_name, state_version);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: workflow_event_log workflow_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.workflow_event_log
      ADD CONSTRAINT workflow_event_log_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: ai_insights_company_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS ai_insights_company_kind_idx ON public.ai_insights USING btree (company_id, kind, created_at DESC);


--
-- Name: ai_insights_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS ai_insights_entity_idx ON public.ai_insights USING btree (company_id, entity_type, entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: ai_insights_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS ai_insights_open_idx ON public.ai_insights USING btree (company_id, created_at DESC) WHERE ((applied_at IS NULL) AND (dismissed_at IS NULL));


--
-- Name: ai_insights_source_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS ai_insights_source_run_id_idx ON public.ai_insights USING btree (company_id, source_run_id) WHERE (source_run_id IS NOT NULL);


--
-- Name: asset_deployments_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS asset_deployments_item_idx ON public.asset_deployments USING btree (company_id, inventory_item_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: asset_deployments_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS asset_deployments_live_idx ON public.asset_deployments USING btree (company_id, status, estimated_return_on) WHERE ((deleted_at IS NULL) AND (status = ANY (ARRAY['out'::text, 'overdue'::text, 'returning'::text])));


--
-- Name: audit_escrow_entries_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_escrow_entries_action_idx ON public.audit_escrow_entries USING btree (action, window_end DESC);


--
-- Name: audit_escrow_entries_chain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_escrow_entries_chain_idx ON public.audit_escrow_entries USING btree (company_id, action, id DESC);


--
-- Name: audit_escrow_entries_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_escrow_entries_company_idx ON public.audit_escrow_entries USING btree (company_id, created_at DESC) WHERE (company_id IS NOT NULL);


--
-- Name: audit_escrow_entries_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_escrow_entries_created_idx ON public.audit_escrow_entries USING btree (created_at DESC, id DESC);


--
-- Name: audit_escrow_keys_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_escrow_keys_active_idx ON public.audit_escrow_keys USING btree (retired_at, created_at DESC) WHERE (retired_at IS NULL);


--
-- Name: audit_events_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON public.audit_events USING btree (company_id, actor_user_id, created_at DESC);


--
-- Name: audit_events_company_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_events_company_recent_idx ON public.audit_events USING btree (company_id, created_at DESC);


--
-- Name: audit_events_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON public.audit_events USING btree (company_id, entity_type, entity_id, created_at DESC);


--
-- Name: audit_events_escrow_anchor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_events_escrow_anchor_idx ON public.audit_events USING btree (escrow_anchor_id) WHERE (escrow_anchor_id IS NOT NULL);


--
-- Name: audit_events_impersonated_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_events_impersonated_by_idx ON public.audit_events USING btree (impersonated_by) WHERE (impersonated_by IS NOT NULL);


--
-- Name: audit_events_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS audit_events_request_idx ON public.audit_events USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: blueprint_documents_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS blueprint_documents_origin_idx ON public.blueprint_documents USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: blueprint_page_diffs_new_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS blueprint_page_diffs_new_page_idx ON public.blueprint_page_diffs USING btree (company_id, new_page_id);


--
-- Name: blueprint_pages_company_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS blueprint_pages_company_doc_idx ON public.blueprint_pages USING btree (company_id, blueprint_document_id, page_number);


--
-- Name: blueprint_pages_scale_verified_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS blueprint_pages_scale_verified_idx ON public.blueprint_pages USING btree (company_id, blueprint_document_id) WHERE (scale_verified_at IS NOT NULL);


--
-- Name: bom_lines_bom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS bom_lines_bom_idx ON public.bom_lines USING btree (company_id, bom_id);


--
-- Name: boms_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS boms_project_idx ON public.boms USING btree (company_id, project_id, status) WHERE (deleted_at IS NULL);


--
-- Name: branches_one_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS branches_one_default_idx ON public.branches USING btree (company_id) WHERE ((is_default = true) AND (deleted_at IS NULL));


--
-- Name: broadcasts_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS broadcasts_company_idx ON public.broadcasts USING btree (company_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: budget_snapshot_lines_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS budget_snapshot_lines_code_idx ON public.budget_snapshot_lines USING btree (company_id, budget_snapshot_id, service_item_code);


--
-- Name: budget_snapshot_lines_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS budget_snapshot_lines_snapshot_idx ON public.budget_snapshot_lines USING btree (company_id, budget_snapshot_id);


--
-- Name: budget_snapshots_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS budget_snapshots_project_idx ON public.budget_snapshots USING btree (company_id, project_id, version DESC);


--
-- Name: budget_snapshots_project_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS budget_snapshots_project_version_idx ON public.budget_snapshots USING btree (company_id, project_id, version);


--
-- Name: capture_artifacts_session_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS capture_artifacts_session_created_idx ON public.capture_artifacts USING btree (company_id, capture_session_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: capture_session_events_client_event_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS capture_session_events_client_event_uidx ON public.capture_session_events USING btree (company_id, capture_session_id, client_event_id) WHERE (client_event_id IS NOT NULL);


--
-- Name: capture_session_events_session_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS capture_session_events_session_seq_idx ON public.capture_session_events USING btree (company_id, capture_session_id, seq, occurred_at);


--
-- Name: capture_sessions_actor_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS capture_sessions_actor_recent_idx ON public.capture_sessions USING btree (company_id, actor_user_id, started_at DESC) WHERE (actor_user_id IS NOT NULL);


--
-- Name: capture_sessions_company_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS capture_sessions_company_recent_idx ON public.capture_sessions USING btree (company_id, started_at DESC);


--
-- Name: capture_sessions_consent_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS capture_sessions_consent_actor_idx ON public.capture_sessions USING btree (company_id, consent_actor_kind, consent_actor_ref, started_at DESC) WHERE ((consent_actor_kind IS NOT NULL) AND (consent_actor_ref IS NOT NULL));


--
-- Name: catalog_parts_system_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS catalog_parts_system_idx ON public.catalog_parts USING btree (company_id, scaffold_system_id) WHERE (deleted_at IS NULL);


--
-- Name: change_orders_company_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS change_orders_company_status_idx ON public.change_orders USING btree (company_id, status, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: change_orders_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS change_orders_project_idx ON public.change_orders USING btree (project_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: clerk_users_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS clerk_users_email_idx ON public.clerk_users USING btree (lower(email)) WHERE (deleted_at IS NULL);


--
-- Name: clerk_users_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS clerk_users_origin_idx ON public.clerk_users USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: clock_events_active_worker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS clock_events_active_worker_idx ON public.clock_events USING btree (company_id, worker_id, occurred_at DESC) WHERE (voided_at IS NULL);


--
-- Name: clock_events_correctible_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS clock_events_correctible_idx ON public.clock_events USING btree (company_id, correctible_until) WHERE (correctible_until IS NOT NULL);


--
-- Name: clock_events_photo_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS clock_events_photo_pending_idx ON public.clock_events USING btree (company_id, occurred_at DESC) WHERE ((photo_storage_path IS NOT NULL) AND (photo_verification_status = 'pending'::text));


--
-- Name: clock_events_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS clock_events_project_idx ON public.clock_events USING btree (company_id, project_id, occurred_at DESC);


--
-- Name: clock_events_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS clock_events_source_idx ON public.clock_events USING btree (company_id, source, occurred_at DESC) WHERE (source <> 'manual'::text);


--
-- Name: clock_events_worker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS clock_events_worker_idx ON public.clock_events USING btree (company_id, worker_id, occurred_at DESC);


--
-- Name: company_invites_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS company_invites_company_idx ON public.company_invites USING btree (company_id, created_at DESC);


--
-- Name: company_invites_one_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS company_invites_one_pending_idx ON public.company_invites USING btree (company_id, lower(email)) WHERE (status = 'pending'::text);


--
-- Name: company_invites_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS company_invites_token_idx ON public.company_invites USING btree (token);


--
-- Name: company_memberships_custom_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS company_memberships_custom_role_idx ON public.company_memberships USING btree (custom_role_id) WHERE (custom_role_id IS NOT NULL);


--
-- Name: company_pricing_overrides_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS company_pricing_overrides_lookup_idx ON public.company_pricing_overrides USING btree (company_id, service_item_code) WHERE (deleted_at IS NULL);


--
-- Name: company_usage_log_company_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS company_usage_log_company_created_idx ON public.company_usage_log USING btree (company_id, created_at DESC);


--
-- Name: company_usage_log_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS company_usage_log_operation_idx ON public.company_usage_log USING btree (operation, created_at DESC);


--
-- Name: companycam_photo_imports_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS companycam_photo_imports_project_idx ON public.companycam_photo_imports USING btree (company_id, project_id, imported_at DESC);


--
-- Name: context_handoff_events_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_handoff_events_capture_session_idx ON public.context_handoff_events USING btree (company_id, capture_session_id) WHERE (capture_session_id IS NOT NULL);


--
-- Name: context_handoff_events_escrow_anchor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_handoff_events_escrow_anchor_idx ON public.context_handoff_events USING btree (escrow_anchor_id) WHERE (escrow_anchor_id IS NOT NULL);


--
-- Name: context_handoff_events_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_handoff_events_event_type_idx ON public.context_handoff_events USING btree (company_id, event_type, recorded_at DESC);


--
-- Name: context_handoff_events_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS context_handoff_events_idempotency_idx ON public.context_handoff_events USING btree (company_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: context_handoff_events_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_handoff_events_request_idx ON public.context_handoff_events USING btree (company_id, request_id) WHERE (request_id IS NOT NULL);


--
-- Name: context_handoff_events_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_handoff_events_trace_idx ON public.context_handoff_events USING btree (company_id, sentry_trace) WHERE (sentry_trace IS NOT NULL);


--
-- Name: context_handoff_events_work_item_recorded_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_handoff_events_work_item_recorded_idx ON public.context_handoff_events USING btree (company_id, work_item_id, recorded_at);


--
-- Name: context_work_items_callback_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_work_items_callback_token_idx ON public.context_work_items USING btree (company_id, agent_callback_token_issued_at DESC) WHERE (agent_callback_token_hash IS NOT NULL);


--
-- Name: context_work_items_capture_session_finalize_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS context_work_items_capture_session_finalize_uidx ON public.context_work_items USING btree (company_id, capture_session_id) WHERE ((capture_session_id IS NOT NULL) AND ((metadata ->> 'source'::text) = 'capture_session_finalize'::text));


--
-- Name: context_work_items_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_work_items_capture_session_idx ON public.context_work_items USING btree (company_id, capture_session_id) WHERE (capture_session_id IS NOT NULL);


--
-- Name: context_work_items_client_request_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS context_work_items_client_request_id_uidx ON public.context_work_items USING btree (company_id, created_by_user_id, ((metadata ->> 'client_request_id'::text))) WHERE ((metadata ->> 'client_request_id'::text) IS NOT NULL);


--
-- Name: context_work_items_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_work_items_created_by_idx ON public.context_work_items USING btree (company_id, created_by_user_id, created_at DESC) WHERE (created_by_user_id IS NOT NULL);


--
-- Name: context_work_items_entity_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_work_items_entity_status_idx ON public.context_work_items USING btree (company_id, entity_type, entity_id, status) WHERE ((entity_type IS NOT NULL) AND (entity_id IS NOT NULL));


--
-- Name: context_work_items_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_work_items_status_idx ON public.context_work_items USING btree (company_id, status, updated_at DESC);


--
-- Name: context_work_items_support_packet_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS context_work_items_support_packet_idx ON public.context_work_items USING btree (support_packet_id);


--
-- Name: cost_library_items_company_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS cost_library_items_company_code_idx ON public.cost_library_items USING btree (company_id, lower(code)) WHERE (deleted_at IS NULL);


--
-- Name: cost_library_items_dedupe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS cost_library_items_dedupe_idx ON public.cost_library_items USING btree (COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(region, ''::text), lower(code), lower(unit)) WHERE (deleted_at IS NULL);


--
-- Name: cost_library_items_shared_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS cost_library_items_shared_code_idx ON public.cost_library_items USING btree (lower(code)) WHERE ((deleted_at IS NULL) AND (company_id IS NULL));


--
-- Name: cost_library_items_trade_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS cost_library_items_trade_idx ON public.cost_library_items USING btree (company_id, lower(trade)) WHERE (deleted_at IS NULL);


--
-- Name: crew_schedules_company_scheduled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS crew_schedules_company_scheduled_idx ON public.crew_schedules USING btree (company_id, scheduled_for DESC);


--
-- Name: crew_schedules_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS crew_schedules_origin_idx ON public.crew_schedules USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: custom_role_grants_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS custom_role_grants_role_idx ON public.custom_role_grants USING btree (custom_role_id);


--
-- Name: custom_roles_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS custom_roles_company_idx ON public.custom_roles USING btree (company_id);


--
-- Name: custom_roles_company_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_company_name_idx ON public.custom_roles USING btree (company_id, lower(name)) WHERE (deleted_at IS NULL);


--
-- Name: customer_portal_links_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS customer_portal_links_active_idx ON public.customer_portal_links USING btree (company_id, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: customer_portal_links_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS customer_portal_links_company_idx ON public.customer_portal_links USING btree (company_id, customer_id, created_at DESC);


--
-- Name: customer_portal_links_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS customer_portal_links_token_idx ON public.customer_portal_links USING btree (portal_token);


--
-- Name: customer_pricing_overrides_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS customer_pricing_overrides_lookup_idx ON public.customer_pricing_overrides USING btree (company_id, customer_id, service_item_code) WHERE (deleted_at IS NULL);


--
-- Name: daily_log_photos_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS daily_log_photos_company_idx ON public.daily_log_photos USING btree (company_id);


--
-- Name: daily_log_photos_log_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS daily_log_photos_log_idx ON public.daily_log_photos USING btree (daily_log_id, captured_at DESC);


--
-- Name: daily_log_photos_step_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS daily_log_photos_step_idx ON public.daily_log_photos USING btree (daily_log_id, scope_step_id) WHERE (scope_step_id IS NOT NULL);


--
-- Name: daily_logs_company_project_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS daily_logs_company_project_day_idx ON public.daily_logs USING btree (company_id, project_id, occurred_on DESC);


--
-- Name: daily_logs_company_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS daily_logs_company_status_idx ON public.daily_logs USING btree (company_id, status, occurred_on DESC) WHERE (status = 'draft'::text);


--
-- Name: daily_logs_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS daily_logs_origin_idx ON public.daily_logs USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: damage_charges_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS damage_charges_open_idx ON public.damage_charges USING btree (company_id, created_at DESC) WHERE ((deleted_at IS NULL) AND (status = 'open'::text));


--
-- Name: damage_charges_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS damage_charges_project_idx ON public.damage_charges USING btree (company_id, project_id, status) WHERE (deleted_at IS NULL);


--
-- Name: estimate_lines_assembly_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_lines_assembly_idx ON public.estimate_lines USING btree (company_id, project_id, assembly_id) WHERE (assembly_id IS NOT NULL);


--
-- Name: estimate_lines_company_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_lines_company_project_idx ON public.estimate_lines USING btree (company_id, project_id);


--
-- Name: estimate_lines_division_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_lines_division_idx ON public.estimate_lines USING btree (company_id, division_code) WHERE (division_code IS NOT NULL);


--
-- Name: estimate_lines_draft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_lines_draft_idx ON public.estimate_lines USING btree (company_id, draft_id);


--
-- Name: estimate_lines_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_lines_origin_idx ON public.estimate_lines USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: estimate_push_lines_push_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_push_lines_push_idx ON public.estimate_push_lines USING btree (company_id, estimate_push_id, sort_order);


--
-- Name: estimate_pushes_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_pushes_project_idx ON public.estimate_pushes USING btree (company_id, project_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: estimate_pushes_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_pushes_status_idx ON public.estimate_pushes USING btree (company_id, status) WHERE (deleted_at IS NULL);


--
-- Name: estimate_share_links_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_share_links_pending_idx ON public.estimate_share_links USING btree (company_id, expires_at) WHERE ((accepted_at IS NULL) AND (declined_at IS NULL));


--
-- Name: estimate_share_links_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_share_links_project_idx ON public.estimate_share_links USING btree (company_id, project_id, sent_at DESC);


--
-- Name: estimate_share_links_share_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_share_links_share_token_idx ON public.estimate_share_links USING btree (share_token);


--
-- Name: estimate_share_links_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS estimate_share_links_status_idx ON public.estimate_share_links USING btree (company_id, status);


--
-- Name: external_rentals_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS external_rentals_active_idx ON public.external_rentals USING btree (company_id, inventory_item_id, status) WHERE ((deleted_at IS NULL) AND (off_rent_date IS NULL));


--
-- Name: external_rentals_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS external_rentals_project_idx ON public.external_rentals USING btree (company_id, project_id) WHERE (deleted_at IS NULL);


--
-- Name: guardrails_company_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS guardrails_company_active_idx ON public.guardrails USING btree (company_id, status, triggered_at DESC) WHERE ((deleted_at IS NULL) AND (status = ANY (ARRAY['triggered'::text, 'snoozed'::text])));


--
-- Name: guardrails_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS guardrails_project_idx ON public.guardrails USING btree (project_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_context_work_items_reversibility_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_context_work_items_reversibility_active ON public.context_work_items USING btree (company_id, created_at, reversibility_window_seconds) WHERE (status <> ALL (ARRAY['resolved'::text, 'wont_do'::text, 'reversed'::text]));


--
-- Name: idx_dispatch_lane_decisions_lane_decided; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_dispatch_lane_decisions_lane_decided ON public.dispatch_lane_decisions USING btree (lane_name, decided_at DESC);


--
-- Name: idx_dispatch_lanes_active_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_dispatch_lanes_active_state ON public.dispatch_lanes USING btree (state) WHERE (state <> 'active'::text);


--
-- Name: impersonation_sessions_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS impersonation_sessions_actor_idx ON public.impersonation_sessions USING btree (actor_user_id, created_at DESC);


--
-- Name: impersonation_sessions_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS impersonation_sessions_subject_idx ON public.impersonation_sessions USING btree (subject_user_id, created_at DESC);


--
-- Name: inventory_locations_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_locations_branch_idx ON public.inventory_locations USING btree (company_id, branch_id) WHERE (deleted_at IS NULL);


--
-- Name: inventory_locations_one_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_one_default_idx ON public.inventory_locations USING btree (company_id) WHERE ((is_default = true) AND (deleted_at IS NULL));


--
-- Name: inventory_movement_photos_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_movement_photos_company_idx ON public.inventory_movement_photos USING btree (company_id, created_at DESC);


--
-- Name: inventory_movement_photos_movement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_movement_photos_movement_idx ON public.inventory_movement_photos USING btree (inventory_movement_id, created_at);


--
-- Name: inventory_movement_photos_storage_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movement_photos_storage_key_uidx ON public.inventory_movement_photos USING btree (storage_key);


--
-- Name: inventory_movements_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON public.inventory_movements USING btree (company_id, inventory_item_id, occurred_on DESC);


--
-- Name: inventory_movements_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_movements_project_idx ON public.inventory_movements USING btree (company_id, project_id, occurred_on DESC);


--
-- Name: inventory_movements_scanned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_movements_scanned_idx ON public.inventory_movements USING btree (company_id, scanned_at DESC) WHERE (scanned_at IS NOT NULL);


--
-- Name: inventory_movements_worker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_movements_worker_idx ON public.inventory_movements USING btree (company_id, worker_id, occurred_on DESC) WHERE (worker_id IS NOT NULL);


--
-- Name: inventory_service_tickets_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_service_tickets_item_idx ON public.inventory_service_tickets USING btree (company_id, inventory_item_id);


--
-- Name: inventory_service_tickets_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS inventory_service_tickets_status_idx ON public.inventory_service_tickets USING btree (company_id, status);


--
-- Name: job_rental_contracts_project_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS job_rental_contracts_project_active_idx ON public.job_rental_contracts USING btree (company_id, project_id) WHERE ((deleted_at IS NULL) AND (status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text])));


--
-- Name: job_rental_lines_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS job_rental_lines_contract_idx ON public.job_rental_lines USING btree (company_id, contract_id, status) WHERE (deleted_at IS NULL);


--
-- Name: labor_entries_company_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_entries_company_occurred_idx ON public.labor_entries USING btree (company_id, occurred_on DESC, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: labor_entries_company_project_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_entries_company_project_occurred_idx ON public.labor_entries USING btree (company_id, project_id, occurred_on DESC);


--
-- Name: labor_entries_division_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_entries_division_idx ON public.labor_entries USING btree (company_id, division_code) WHERE (division_code IS NOT NULL);


--
-- Name: labor_entries_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_entries_origin_idx ON public.labor_entries USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: labor_entries_payroll_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_entries_payroll_run_idx ON public.labor_entries USING btree (payroll_run_id) WHERE (payroll_run_id IS NOT NULL);


--
-- Name: labor_entries_review_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_entries_review_run_idx ON public.labor_entries USING btree (review_run_id) WHERE (review_run_id IS NOT NULL);


--
-- Name: labor_payroll_runs_company_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_payroll_runs_company_period_idx ON public.labor_payroll_runs USING btree (company_id, period_start DESC) WHERE (deleted_at IS NULL);


--
-- Name: labor_payroll_runs_company_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_payroll_runs_company_state_idx ON public.labor_payroll_runs USING btree (company_id, state, period_start DESC) WHERE (deleted_at IS NULL);


--
-- Name: labor_payroll_runs_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_payroll_runs_origin_idx ON public.labor_payroll_runs USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: labor_payroll_runs_time_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS labor_payroll_runs_time_review_idx ON public.labor_payroll_runs USING btree (company_id, time_review_run_id) WHERE ((time_review_run_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: material_bills_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS material_bills_origin_idx ON public.material_bills USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: mesh_trace_forward_state_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS mesh_trace_forward_state_capture_session_idx ON public.mesh_trace_forward_state USING btree (company_id, capture_session_id, first_seen_at DESC) WHERE (capture_session_id IS NOT NULL);


--
-- Name: mesh_trace_forward_state_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS mesh_trace_forward_state_pending_idx ON public.mesh_trace_forward_state USING btree (status, last_attempt_at NULLS FIRST, first_seen_at) WHERE (status <> 'forwarded'::text);


--
-- Name: message_reads_company_project_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS message_reads_company_project_user_idx ON public.message_reads USING btree (company_id, project_id, user_id);


--
-- Name: mutation_outbox_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS mutation_outbox_capture_session_idx ON public.mutation_outbox USING btree (company_id, capture_session_id) WHERE (capture_session_id IS NOT NULL);


--
-- Name: mutation_outbox_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS mutation_outbox_ready_idx ON public.mutation_outbox USING btree (company_id, status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));


--
-- Name: mutation_outbox_request_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS mutation_outbox_request_id_idx ON public.mutation_outbox USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: notifications_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS notifications_company_idx ON public.notifications USING btree (company_id, created_at DESC);


--
-- Name: notifications_next_delivery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS notifications_next_delivery_idx ON public.notifications USING btree (next_delivery_at) WHERE ((status = 'pending'::text) AND (next_delivery_at IS NOT NULL));


--
-- Name: notifications_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS notifications_pending_idx ON public.notifications USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: payroll_exports_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS payroll_exports_pending_idx ON public.payroll_exports USING btree (company_id, requested_at) WHERE (status = 'pending'::text);


--
-- Name: payroll_exports_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS payroll_exports_run_idx ON public.payroll_exports USING btree (company_id, payroll_run_id, requested_at DESC);


--
-- Name: project_assignments_project_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_assignments_project_active_idx ON public.project_assignments USING btree (project_id) WHERE (deleted_at IS NULL);


--
-- Name: project_assignments_unique_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS project_assignments_unique_active ON public.project_assignments USING btree (project_id, clerk_user_id, role) WHERE (deleted_at IS NULL);


--
-- Name: project_assignments_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_assignments_user_active_idx ON public.project_assignments USING btree (clerk_user_id, company_id) WHERE (deleted_at IS NULL);


--
-- Name: project_billing_milestones_company_project_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_billing_milestones_company_project_sort_idx ON public.project_billing_milestones USING btree (company_id, project_id, sort_order);


--
-- Name: project_briefs_company_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_briefs_company_recent_idx ON public.project_briefs USING btree (company_id, effective_date DESC);


--
-- Name: project_briefs_project_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_briefs_project_date_idx ON public.project_briefs USING btree (project_id, effective_date DESC);


--
-- Name: project_briefs_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS project_briefs_uniq ON public.project_briefs USING btree (company_id, project_id, effective_date, foreman_user_id);


--
-- Name: project_lost_reasons_company_reason_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_lost_reasons_company_reason_idx ON public.project_lost_reasons USING btree (company_id, reason, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: project_messages_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_messages_company_idx ON public.project_messages USING btree (company_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: project_messages_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_messages_project_idx ON public.project_messages USING btree (project_id, created_at) WHERE (deleted_at IS NULL);


--
-- Name: project_pricing_overrides_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS project_pricing_overrides_lookup_idx ON public.project_pricing_overrides USING btree (company_id, project_id, service_item_code) WHERE (deleted_at IS NULL);


--
-- Name: projects_company_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS projects_company_updated_idx ON public.projects USING btree (company_id, updated_at DESC);


--
-- Name: projects_lifecycle_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS projects_lifecycle_state_idx ON public.projects USING btree (company_id, lifecycle_state) WHERE (deleted_at IS NULL);


--
-- Name: projects_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS projects_origin_idx ON public.projects USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: push_subscriptions_company_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS push_subscriptions_company_user_idx ON public.push_subscriptions USING btree (company_id, clerk_user_id);


--
-- Name: qbo_custom_field_mappings_company_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS qbo_custom_field_mappings_company_entity_idx ON public.qbo_custom_field_mappings USING btree (company_id, entity_type);


--
-- Name: qbo_sync_runs_company_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS qbo_sync_runs_company_status_idx ON public.qbo_sync_runs USING btree (company_id, status, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: qbo_sync_runs_connection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS qbo_sync_runs_connection_idx ON public.qbo_sync_runs USING btree (integration_connection_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: rental_billing_run_lines_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS rental_billing_run_lines_run_idx ON public.rental_billing_run_lines USING btree (company_id, billing_run_id);


--
-- Name: rental_rate_tiers_line_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS rental_rate_tiers_line_idx ON public.rental_rate_tiers USING btree (company_id, job_rental_line_id, sort_order);


--
-- Name: rental_requests_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS rental_requests_pending_idx ON public.rental_requests USING btree (company_id, status, created_at DESC) WHERE (status = 'pending'::text);


--
-- Name: rental_share_links_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS rental_share_links_company_idx ON public.rental_share_links USING btree (company_id);


--
-- Name: rentals_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS rentals_active_idx ON public.rentals USING btree (company_id, status, next_invoice_at) WHERE (deleted_at IS NULL);


--
-- Name: rentals_transferred_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS rentals_transferred_from_idx ON public.rentals USING btree (transferred_from_rental_id) WHERE (transferred_from_rental_id IS NOT NULL);


--
-- Name: scaffold_inspections_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS scaffold_inspections_due_idx ON public.scaffold_inspections USING btree (company_id, next_due_on) WHERE (next_due_on IS NOT NULL);


--
-- Name: scaffold_inspections_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS scaffold_inspections_tag_idx ON public.scaffold_inspections USING btree (company_id, tag_id, signed_at DESC);


--
-- Name: scaffold_tags_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS scaffold_tags_project_idx ON public.scaffold_tags USING btree (company_id, project_id, status) WHERE (deleted_at IS NULL);


--
-- Name: service_item_assemblies_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS service_item_assemblies_active_idx ON public.service_item_assemblies USING btree (company_id, service_item_code) WHERE (deleted_at IS NULL);


--
-- Name: service_item_assembly_components_assembly_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS service_item_assembly_components_assembly_idx ON public.service_item_assembly_components USING btree (company_id, assembly_id, sort_order);


--
-- Name: service_item_divisions_by_division_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS service_item_divisions_by_division_idx ON public.service_item_divisions USING btree (company_id, division_code);


--
-- Name: service_item_rate_history_code_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS service_item_rate_history_code_recent_idx ON public.service_item_rate_history USING btree (company_id, service_item_code, recorded_at DESC);


--
-- Name: shipment_events_shipment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS shipment_events_shipment_idx ON public.shipment_events USING btree (company_id, shipment_id, created_at DESC);


--
-- Name: shipment_lines_shipment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS shipment_lines_shipment_idx ON public.shipment_lines USING btree (company_id, shipment_id);


--
-- Name: shipments_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS shipments_project_idx ON public.shipments USING btree (company_id, project_id, status) WHERE (deleted_at IS NULL);


--
-- Name: shipments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS shipments_status_idx ON public.shipments USING btree (company_id, status, scheduled_for) WHERE (deleted_at IS NULL);


--
-- Name: support_debug_packets_actor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS support_debug_packets_actor_created_idx ON public.support_debug_packets USING btree (company_id, actor_user_id, created_at DESC);


--
-- Name: support_debug_packets_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS support_debug_packets_capture_session_idx ON public.support_debug_packets USING btree (company_id, capture_session_id) WHERE (capture_session_id IS NOT NULL);


--
-- Name: support_debug_packets_company_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS support_debug_packets_company_created_idx ON public.support_debug_packets USING btree (company_id, created_at DESC);


--
-- Name: support_debug_packets_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS support_debug_packets_expires_idx ON public.support_debug_packets USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: support_debug_packets_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS support_debug_packets_request_idx ON public.support_debug_packets USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: support_packet_access_actor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS support_packet_access_actor_created_idx ON public.support_packet_access_log USING btree (company_id, actor_user_id, created_at DESC);


--
-- Name: support_packet_access_packet_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS support_packet_access_packet_created_idx ON public.support_packet_access_log USING btree (company_id, support_packet_id, created_at DESC);


--
-- Name: sync_events_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS sync_events_capture_session_idx ON public.sync_events USING btree (company_id, capture_session_id) WHERE (capture_session_id IS NOT NULL);


--
-- Name: sync_events_company_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS sync_events_company_created_idx ON public.sync_events USING btree (company_id, created_at DESC);


--
-- Name: sync_events_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS sync_events_ready_idx ON public.sync_events USING btree (company_id, status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));


--
-- Name: sync_events_request_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS sync_events_request_id_idx ON public.sync_events USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: takeoff_capture_artifacts_draft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_capture_artifacts_draft_idx ON public.takeoff_capture_artifacts USING btree (company_id, draft_id, created_at DESC);


--
-- Name: takeoff_capture_artifacts_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_capture_artifacts_kind_idx ON public.takeoff_capture_artifacts USING btree (company_id, kind, created_at DESC);


--
-- Name: takeoff_conditions_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_conditions_company_idx ON public.takeoff_conditions USING btree (company_id) WHERE (deleted_at IS NULL);


--
-- Name: takeoff_conditions_company_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS takeoff_conditions_company_name_idx ON public.takeoff_conditions USING btree (company_id, lower(name)) WHERE (deleted_at IS NULL);


--
-- Name: takeoff_drafts_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_drafts_kind_idx ON public.takeoff_drafts USING btree (company_id, kind) WHERE ((kind <> 'takeoff'::text) AND (deleted_at IS NULL));


--
-- Name: takeoff_drafts_project_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_drafts_project_active_idx ON public.takeoff_drafts USING btree (company_id, project_id) WHERE ((deleted_at IS NULL) AND (status = 'active'::text));


--
-- Name: takeoff_drafts_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_drafts_project_idx ON public.takeoff_drafts USING btree (company_id, project_id) WHERE (deleted_at IS NULL);


--
-- Name: takeoff_drafts_result_json_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_drafts_result_json_idx ON public.takeoff_drafts USING btree (company_id, created_at DESC) WHERE ((source <> 'manual'::text) AND (deleted_at IS NULL) AND (takeoff_result_json IS NOT NULL));


--
-- Name: takeoff_drafts_review_required_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_drafts_review_required_idx ON public.takeoff_drafts USING btree (company_id, review_required) WHERE ((review_required = true) AND (deleted_at IS NULL));


--
-- Name: takeoff_drafts_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_drafts_source_idx ON public.takeoff_drafts USING btree (company_id, source) WHERE (source <> 'manual'::text);


--
-- Name: takeoff_measurement_tags_measurement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurement_tags_measurement_idx ON public.takeoff_measurement_tags USING btree (company_id, measurement_id, sort_order);


--
-- Name: takeoff_measurement_tags_service_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurement_tags_service_item_idx ON public.takeoff_measurement_tags USING btree (company_id, service_item_code);


--
-- Name: takeoff_measurements_assembly_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_assembly_idx ON public.takeoff_measurements USING btree (company_id, assembly_id) WHERE ((assembly_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: takeoff_measurements_condition_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_condition_idx ON public.takeoff_measurements USING btree (company_id, condition_id) WHERE ((condition_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: takeoff_measurements_division_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_division_idx ON public.takeoff_measurements USING btree (company_id, division_code) WHERE (division_code IS NOT NULL);


--
-- Name: takeoff_measurements_draft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_draft_idx ON public.takeoff_measurements USING btree (company_id, draft_id);


--
-- Name: takeoff_measurements_elevation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_elevation_idx ON public.takeoff_measurements USING btree (company_id, project_id, elevation) WHERE (elevation IS NOT NULL);


--
-- Name: takeoff_measurements_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_kind_idx ON public.takeoff_measurements USING btree (company_id, geometry_kind) WHERE (geometry_kind <> 'polygon'::text);


--
-- Name: takeoff_measurements_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_origin_idx ON public.takeoff_measurements USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: takeoff_measurements_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_page_idx ON public.takeoff_measurements USING btree (company_id, page_id) WHERE (page_id IS NOT NULL);


--
-- Name: takeoff_measurements_project_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_project_created_idx ON public.takeoff_measurements USING btree (company_id, project_id, created_at);


--
-- Name: takeoff_measurements_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS takeoff_measurements_updated_at_idx ON public.takeoff_measurements USING btree (company_id, updated_at DESC);


--
-- Name: tenant_provisions_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS tenant_provisions_company_idx ON public.tenant_provisions USING btree (company_id) WHERE ((company_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: tenant_provisions_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS tenant_provisions_created_by_idx ON public.tenant_provisions USING btree (created_by, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: tenant_provisions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS tenant_provisions_status_idx ON public.tenant_provisions USING btree (status, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: time_review_runs_company_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS time_review_runs_company_period_idx ON public.time_review_runs USING btree (company_id, period_start DESC);


--
-- Name: time_review_runs_company_project_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS time_review_runs_company_project_period_idx ON public.time_review_runs USING btree (company_id, project_id, period_start DESC) WHERE (project_id IS NOT NULL);


--
-- Name: time_review_runs_company_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS time_review_runs_company_state_idx ON public.time_review_runs USING btree (company_id, state, period_start DESC);


--
-- Name: time_review_runs_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS time_review_runs_origin_idx ON public.time_review_runs USING btree (origin) WHERE (origin IS NOT NULL);


--
-- Name: worker_issue_attachments_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issue_attachments_capture_session_idx ON public.worker_issue_attachments USING btree (company_id, capture_session_id) WHERE (capture_session_id IS NOT NULL);


--
-- Name: worker_issue_attachments_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issue_attachments_company_idx ON public.worker_issue_attachments USING btree (company_id, created_at DESC);


--
-- Name: worker_issue_attachments_issue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issue_attachments_issue_idx ON public.worker_issue_attachments USING btree (worker_issue_id, created_at DESC);


--
-- Name: worker_issue_attachments_one_voice_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS worker_issue_attachments_one_voice_uidx ON public.worker_issue_attachments USING btree (worker_issue_id) WHERE (kind = 'voice'::text);


--
-- Name: worker_issue_attachments_storage_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS worker_issue_attachments_storage_key_uidx ON public.worker_issue_attachments USING btree (storage_key);


--
-- Name: worker_issues_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issues_capture_session_idx ON public.worker_issues USING btree (company_id, capture_session_id) WHERE (capture_session_id IS NOT NULL);


--
-- Name: worker_issues_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issues_company_idx ON public.worker_issues USING btree (company_id, created_at DESC);


--
-- Name: worker_issues_estimator_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issues_estimator_queue_idx ON public.worker_issues USING btree (company_id, escalated_to_estimator_at);


--
-- Name: worker_issues_inbox_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issues_inbox_idx ON public.worker_issues USING btree (company_id, resolved_at, severity);


--
-- Name: worker_issues_open_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issues_open_company_idx ON public.worker_issues USING btree (company_id, created_at DESC) WHERE (resolved_at IS NULL);


--
-- Name: worker_issues_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS worker_issues_project_idx ON public.worker_issues USING btree (company_id, project_id, created_at DESC);


--
-- Name: workflow_event_log_capture_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS workflow_event_log_capture_session_idx ON public.workflow_event_log USING btree (company_id, capture_session_id, applied_at DESC) WHERE (capture_session_id IS NOT NULL);


--
-- Name: workflow_event_log_company_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS workflow_event_log_company_workflow_idx ON public.workflow_event_log USING btree (company_id, workflow_name, applied_at DESC);


--
-- Name: workflow_event_log_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS workflow_event_log_entity_idx ON public.workflow_event_log USING btree (entity_id, state_version);


--
-- Name: workflow_event_log_entity_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS workflow_event_log_entity_state_idx ON public.workflow_event_log USING btree (entity_id, state_version);


--
-- Name: workflow_event_log_workflow_applied_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS workflow_event_log_workflow_applied_idx ON public.workflow_event_log USING btree (workflow_name, applied_at DESC);


--
-- Name: bonus_rules bonus_rules_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER bonus_rules_bootstrap_bump_del AFTER DELETE ON public.bonus_rules REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: bonus_rules bonus_rules_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER bonus_rules_bootstrap_bump_ins AFTER INSERT ON public.bonus_rules REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: bonus_rules bonus_rules_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER bonus_rules_bootstrap_bump_upd AFTER UPDATE ON public.bonus_rules REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: budget_snapshot_lines budget_snapshot_lines_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER budget_snapshot_lines_no_update BEFORE UPDATE ON public.budget_snapshot_lines FOR EACH ROW EXECUTE FUNCTION public.budget_snapshot_no_update();


--
-- Name: budget_snapshots budget_snapshots_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER budget_snapshots_no_update BEFORE UPDATE ON public.budget_snapshots FOR EACH ROW EXECUTE FUNCTION public.budget_snapshot_no_update();


--
-- Name: crew_schedules crew_schedules_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER crew_schedules_bootstrap_bump_del AFTER DELETE ON public.crew_schedules REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: crew_schedules crew_schedules_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER crew_schedules_bootstrap_bump_ins AFTER INSERT ON public.crew_schedules REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: crew_schedules crew_schedules_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER crew_schedules_bootstrap_bump_upd AFTER UPDATE ON public.crew_schedules REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: customers customers_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER customers_bootstrap_bump_del AFTER DELETE ON public.customers REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: customers customers_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER customers_bootstrap_bump_ins AFTER INSERT ON public.customers REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: customers customers_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER customers_bootstrap_bump_upd AFTER UPDATE ON public.customers REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: divisions divisions_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER divisions_bootstrap_bump_del AFTER DELETE ON public.divisions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: divisions divisions_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER divisions_bootstrap_bump_ins AFTER INSERT ON public.divisions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: divisions divisions_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER divisions_bootstrap_bump_upd AFTER UPDATE ON public.divisions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: integration_connections integration_connections_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER integration_connections_bootstrap_bump_del AFTER DELETE ON public.integration_connections REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: integration_connections integration_connections_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER integration_connections_bootstrap_bump_ins AFTER INSERT ON public.integration_connections REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: integration_connections integration_connections_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER integration_connections_bootstrap_bump_upd AFTER UPDATE ON public.integration_connections REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: integration_mappings integration_mappings_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER integration_mappings_bootstrap_bump_del AFTER DELETE ON public.integration_mappings REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: integration_mappings integration_mappings_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER integration_mappings_bootstrap_bump_ins AFTER INSERT ON public.integration_mappings REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: integration_mappings integration_mappings_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER integration_mappings_bootstrap_bump_upd AFTER UPDATE ON public.integration_mappings REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: labor_entries labor_entries_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER labor_entries_bootstrap_bump_del AFTER DELETE ON public.labor_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: labor_entries labor_entries_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER labor_entries_bootstrap_bump_ins AFTER INSERT ON public.labor_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: labor_entries labor_entries_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER labor_entries_bootstrap_bump_upd AFTER UPDATE ON public.labor_entries REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: pricing_profiles pricing_profiles_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER pricing_profiles_bootstrap_bump_del AFTER DELETE ON public.pricing_profiles REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: pricing_profiles pricing_profiles_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER pricing_profiles_bootstrap_bump_ins AFTER INSERT ON public.pricing_profiles REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: pricing_profiles pricing_profiles_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER pricing_profiles_bootstrap_bump_upd AFTER UPDATE ON public.pricing_profiles REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: project_assignments project_assignments_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER project_assignments_bootstrap_bump_del AFTER DELETE ON public.project_assignments REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: project_assignments project_assignments_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER project_assignments_bootstrap_bump_ins AFTER INSERT ON public.project_assignments REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: project_assignments project_assignments_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER project_assignments_bootstrap_bump_upd AFTER UPDATE ON public.project_assignments REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: projects projects_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER projects_bootstrap_bump_del AFTER DELETE ON public.projects REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: projects projects_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER projects_bootstrap_bump_ins AFTER INSERT ON public.projects REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: projects projects_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER projects_bootstrap_bump_upd AFTER UPDATE ON public.projects REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: service_items service_items_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER service_items_bootstrap_bump_del AFTER DELETE ON public.service_items REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: service_items service_items_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER service_items_bootstrap_bump_ins AFTER INSERT ON public.service_items REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: service_items service_items_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER service_items_bootstrap_bump_upd AFTER UPDATE ON public.service_items REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: workers workers_bootstrap_bump_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER workers_bootstrap_bump_del AFTER DELETE ON public.workers REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: workers workers_bootstrap_bump_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER workers_bootstrap_bump_ins AFTER INSERT ON public.workers REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: workers workers_bootstrap_bump_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER workers_bootstrap_bump_upd AFTER UPDATE ON public.workers REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_company_bootstrap_state();


--
-- Name: ai_insights ai_insights_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.ai_insights
      ADD CONSTRAINT ai_insights_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_company_id_from_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_company_id_from_location_id_fkey FOREIGN KEY (company_id, from_location_id) REFERENCES public.inventory_locations(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_company_id_handoff_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_company_id_handoff_worker_id_fkey FOREIGN KEY (company_id, handoff_worker_id) REFERENCES public.workers(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_company_id_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_company_id_inventory_item_id_fkey FOREIGN KEY (company_id, inventory_item_id) REFERENCES public.inventory_items(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_company_id_inventory_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_company_id_inventory_movement_id_fkey FOREIGN KEY (company_id, inventory_movement_id) REFERENCES public.inventory_movements(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: asset_deployments asset_deployments_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.asset_deployments
      ADD CONSTRAINT asset_deployments_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: audit_escrow_entries audit_escrow_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.audit_escrow_entries
      ADD CONSTRAINT audit_escrow_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: audit_escrow_entries audit_escrow_entries_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.audit_escrow_entries
      ADD CONSTRAINT audit_escrow_entries_key_id_fkey FOREIGN KEY (key_id) REFERENCES public.audit_escrow_keys(key_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: audit_events audit_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.audit_events
      ADD CONSTRAINT audit_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: audit_events audit_events_escrow_anchor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.audit_events
      ADD CONSTRAINT audit_events_escrow_anchor_id_fkey FOREIGN KEY (escrow_anchor_id) REFERENCES public.audit_escrow_entries(id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_documents blueprint_documents_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_documents
      ADD CONSTRAINT blueprint_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_documents blueprint_documents_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_documents
      ADD CONSTRAINT blueprint_documents_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_documents blueprint_documents_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_documents
      ADD CONSTRAINT blueprint_documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_documents blueprint_documents_replaces_blueprint_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_documents
      ADD CONSTRAINT blueprint_documents_replaces_blueprint_document_id_fkey FOREIGN KEY (replaces_blueprint_document_id) REFERENCES public.blueprint_documents(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_page_diffs blueprint_page_diffs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_page_diffs
      ADD CONSTRAINT blueprint_page_diffs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_page_diffs blueprint_page_diffs_new_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_page_diffs
      ADD CONSTRAINT blueprint_page_diffs_new_page_id_fkey FOREIGN KEY (new_page_id) REFERENCES public.blueprint_pages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_page_diffs blueprint_page_diffs_prior_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_page_diffs
      ADD CONSTRAINT blueprint_page_diffs_prior_page_id_fkey FOREIGN KEY (prior_page_id) REFERENCES public.blueprint_pages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_pages blueprint_pages_blueprint_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_pages
      ADD CONSTRAINT blueprint_pages_blueprint_document_id_fkey FOREIGN KEY (blueprint_document_id) REFERENCES public.blueprint_documents(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: blueprint_pages blueprint_pages_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.blueprint_pages
      ADD CONSTRAINT blueprint_pages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: bom_lines bom_lines_company_id_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.bom_lines
      ADD CONSTRAINT bom_lines_company_id_bom_id_fkey FOREIGN KEY (company_id, bom_id) REFERENCES public.boms(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: bom_lines bom_lines_company_id_catalog_part_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.bom_lines
      ADD CONSTRAINT bom_lines_company_id_catalog_part_id_fkey FOREIGN KEY (company_id, catalog_part_id) REFERENCES public.catalog_parts(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: bom_lines bom_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.bom_lines
      ADD CONSTRAINT bom_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: boms boms_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.boms
      ADD CONSTRAINT boms_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: boms boms_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.boms
      ADD CONSTRAINT boms_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: boms boms_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.boms
      ADD CONSTRAINT boms_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.boms(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: bonus_rules bonus_rules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.bonus_rules
      ADD CONSTRAINT bonus_rules_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: branches branches_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.branches
      ADD CONSTRAINT branches_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: broadcasts broadcasts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.broadcasts
      ADD CONSTRAINT broadcasts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: broadcasts broadcasts_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.broadcasts
      ADD CONSTRAINT broadcasts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshot_lines budget_snapshot_lines_budget_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshot_lines
      ADD CONSTRAINT budget_snapshot_lines_budget_snapshot_id_fkey FOREIGN KEY (budget_snapshot_id) REFERENCES public.budget_snapshots(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshot_lines budget_snapshot_lines_company_id_budget_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshot_lines
      ADD CONSTRAINT budget_snapshot_lines_company_id_budget_snapshot_id_fkey FOREIGN KEY (company_id, budget_snapshot_id) REFERENCES public.budget_snapshots(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshot_lines budget_snapshot_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshot_lines
      ADD CONSTRAINT budget_snapshot_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshots budget_snapshots_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshots
      ADD CONSTRAINT budget_snapshots_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshots budget_snapshots_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshots
      ADD CONSTRAINT budget_snapshots_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: budget_snapshots budget_snapshots_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.budget_snapshots
      ADD CONSTRAINT budget_snapshots_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: capture_artifacts capture_artifacts_capture_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.capture_artifacts
      ADD CONSTRAINT capture_artifacts_capture_session_id_fkey FOREIGN KEY (capture_session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: capture_artifacts capture_artifacts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.capture_artifacts
      ADD CONSTRAINT capture_artifacts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: capture_session_events capture_session_events_capture_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.capture_session_events
      ADD CONSTRAINT capture_session_events_capture_session_id_fkey FOREIGN KEY (capture_session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: capture_session_events capture_session_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.capture_session_events
      ADD CONSTRAINT capture_session_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: capture_sessions capture_sessions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.capture_sessions
      ADD CONSTRAINT capture_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: catalog_parts catalog_parts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.catalog_parts
      ADD CONSTRAINT catalog_parts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: catalog_parts catalog_parts_company_id_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.catalog_parts
      ADD CONSTRAINT catalog_parts_company_id_inventory_item_id_fkey FOREIGN KEY (company_id, inventory_item_id) REFERENCES public.inventory_items(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: catalog_parts catalog_parts_manufacturer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.catalog_parts
      ADD CONSTRAINT catalog_parts_manufacturer_id_fkey FOREIGN KEY (manufacturer_id) REFERENCES public.scaffold_manufacturers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: catalog_parts catalog_parts_scaffold_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.catalog_parts
      ADD CONSTRAINT catalog_parts_scaffold_system_id_fkey FOREIGN KEY (scaffold_system_id) REFERENCES public.scaffold_systems(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: change_orders change_orders_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.change_orders
      ADD CONSTRAINT change_orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: change_orders change_orders_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.change_orders
      ADD CONSTRAINT change_orders_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: clock_events clock_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.clock_events
      ADD CONSTRAINT clock_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: clock_events clock_events_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.clock_events
      ADD CONSTRAINT clock_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: clock_events clock_events_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.clock_events
      ADD CONSTRAINT clock_events_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_bootstrap_state company_bootstrap_state_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_bootstrap_state
      ADD CONSTRAINT company_bootstrap_state_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_invites company_invites_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_invites
      ADD CONSTRAINT company_invites_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_memberships company_memberships_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_memberships
      ADD CONSTRAINT company_memberships_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_memberships company_memberships_custom_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_memberships
      ADD CONSTRAINT company_memberships_custom_role_id_fkey FOREIGN KEY (custom_role_id) REFERENCES public.custom_roles(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_pricing_overrides company_pricing_overrides_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_pricing_overrides
      ADD CONSTRAINT company_pricing_overrides_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: company_usage_log company_usage_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.company_usage_log
      ADD CONSTRAINT company_usage_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: companycam_photo_imports companycam_photo_imports_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.companycam_photo_imports
      ADD CONSTRAINT companycam_photo_imports_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: companycam_photo_imports companycam_photo_imports_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.companycam_photo_imports
      ADD CONSTRAINT companycam_photo_imports_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: context_handoff_events context_handoff_events_causation_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.context_handoff_events
      ADD CONSTRAINT context_handoff_events_causation_event_id_fkey FOREIGN KEY (causation_event_id) REFERENCES public.context_handoff_events(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: context_handoff_events context_handoff_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.context_handoff_events
      ADD CONSTRAINT context_handoff_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: context_handoff_events context_handoff_events_escrow_anchor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.context_handoff_events
      ADD CONSTRAINT context_handoff_events_escrow_anchor_id_fkey FOREIGN KEY (escrow_anchor_id) REFERENCES public.audit_escrow_entries(id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: context_handoff_events context_handoff_events_work_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.context_handoff_events
      ADD CONSTRAINT context_handoff_events_work_item_id_fkey FOREIGN KEY (work_item_id) REFERENCES public.context_work_items(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: context_work_items context_work_items_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.context_work_items
      ADD CONSTRAINT context_work_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: context_work_items context_work_items_support_packet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.context_work_items
      ADD CONSTRAINT context_work_items_support_packet_id_fkey FOREIGN KEY (support_packet_id) REFERENCES public.support_debug_packets(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: cost_library_items cost_library_items_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.cost_library_items
      ADD CONSTRAINT cost_library_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: crew_schedules crew_schedules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.crew_schedules
      ADD CONSTRAINT crew_schedules_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: crew_schedules crew_schedules_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.crew_schedules
      ADD CONSTRAINT crew_schedules_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: crew_schedules crew_schedules_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.crew_schedules
      ADD CONSTRAINT crew_schedules_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: crew_schedules crew_schedules_takeoff_measurement_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.crew_schedules
      ADD CONSTRAINT crew_schedules_takeoff_measurement_fkey FOREIGN KEY (company_id, takeoff_measurement_id) REFERENCES public.takeoff_measurements(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: custom_role_grants custom_role_grants_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.custom_role_grants
      ADD CONSTRAINT custom_role_grants_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: custom_role_grants custom_role_grants_custom_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.custom_role_grants
      ADD CONSTRAINT custom_role_grants_custom_role_id_fkey FOREIGN KEY (custom_role_id) REFERENCES public.custom_roles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: custom_roles custom_roles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.custom_roles
      ADD CONSTRAINT custom_roles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_portal_links customer_portal_links_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_portal_links
      ADD CONSTRAINT customer_portal_links_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_portal_links customer_portal_links_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_portal_links
      ADD CONSTRAINT customer_portal_links_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_portal_links customer_portal_links_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_portal_links
      ADD CONSTRAINT customer_portal_links_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_pricing_overrides customer_pricing_overrides_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_pricing_overrides
      ADD CONSTRAINT customer_pricing_overrides_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customer_pricing_overrides customer_pricing_overrides_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customer_pricing_overrides
      ADD CONSTRAINT customer_pricing_overrides_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: customers customers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.customers
      ADD CONSTRAINT customers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: daily_log_photos daily_log_photos_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.daily_log_photos
      ADD CONSTRAINT daily_log_photos_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: daily_log_photos daily_log_photos_daily_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.daily_log_photos
      ADD CONSTRAINT daily_log_photos_daily_log_id_fkey FOREIGN KEY (daily_log_id) REFERENCES public.daily_logs(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: daily_logs daily_logs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.daily_logs
      ADD CONSTRAINT daily_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: daily_logs daily_logs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.daily_logs
      ADD CONSTRAINT daily_logs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_company_id_catalog_part_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_company_id_catalog_part_id_fkey FOREIGN KEY (company_id, catalog_part_id) REFERENCES public.catalog_parts(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_company_id_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_company_id_inventory_item_id_fkey FOREIGN KEY (company_id, inventory_item_id) REFERENCES public.inventory_items(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_company_id_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_company_id_shipment_id_fkey FOREIGN KEY (company_id, shipment_id) REFERENCES public.shipments(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_company_id_shipment_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_company_id_shipment_line_id_fkey FOREIGN KEY (company_id, shipment_line_id) REFERENCES public.shipment_lines(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: damage_charges damage_charges_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.damage_charges
      ADD CONSTRAINT damage_charges_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: dispatch_lane_decisions dispatch_lane_decisions_lane_name_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.dispatch_lane_decisions
      ADD CONSTRAINT dispatch_lane_decisions_lane_name_fkey FOREIGN KEY (lane_name) REFERENCES public.dispatch_lanes(name);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: divisions divisions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.divisions
      ADD CONSTRAINT divisions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_lines estimate_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_lines
      ADD CONSTRAINT estimate_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_lines estimate_lines_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_lines
      ADD CONSTRAINT estimate_lines_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_lines estimate_lines_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_lines
      ADD CONSTRAINT estimate_lines_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.takeoff_drafts(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_lines estimate_lines_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_lines
      ADD CONSTRAINT estimate_lines_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_push_lines estimate_push_lines_company_id_estimate_push_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_push_lines
      ADD CONSTRAINT estimate_push_lines_company_id_estimate_push_id_fkey FOREIGN KEY (company_id, estimate_push_id) REFERENCES public.estimate_pushes(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_push_lines estimate_push_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_push_lines
      ADD CONSTRAINT estimate_push_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_pushes estimate_pushes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_pushes
      ADD CONSTRAINT estimate_pushes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_pushes estimate_pushes_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_pushes
      ADD CONSTRAINT estimate_pushes_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_pushes estimate_pushes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_pushes
      ADD CONSTRAINT estimate_pushes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_share_links estimate_share_links_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_share_links
      ADD CONSTRAINT estimate_share_links_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_share_links estimate_share_links_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_share_links
      ADD CONSTRAINT estimate_share_links_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: external_rentals external_rentals_company_id_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.external_rentals
      ADD CONSTRAINT external_rentals_company_id_branch_id_fkey FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: external_rentals external_rentals_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.external_rentals
      ADD CONSTRAINT external_rentals_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: external_rentals external_rentals_company_id_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.external_rentals
      ADD CONSTRAINT external_rentals_company_id_inventory_item_id_fkey FOREIGN KEY (company_id, inventory_item_id) REFERENCES public.inventory_items(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: external_rentals external_rentals_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.external_rentals
      ADD CONSTRAINT external_rentals_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: external_rentals external_rentals_company_id_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.external_rentals
      ADD CONSTRAINT external_rentals_company_id_vendor_id_fkey FOREIGN KEY (company_id, vendor_id) REFERENCES public.rental_vendors(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: companycam_photo_imports fk_companycam_photo_imports_daily_log_photo_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.companycam_photo_imports
      ADD CONSTRAINT fk_companycam_photo_imports_daily_log_photo_id FOREIGN KEY (daily_log_photo_id) REFERENCES public.daily_log_photos(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: estimate_push_lines fk_estimate_push_lines_source_estimate_line_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.estimate_push_lines
      ADD CONSTRAINT fk_estimate_push_lines_source_estimate_line_id FOREIGN KEY (source_estimate_line_id) REFERENCES public.estimate_lines(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_tags fk_scaffold_tags_last_inspection_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_tags
      ADD CONSTRAINT fk_scaffold_tags_last_inspection_id FOREIGN KEY (company_id, last_inspection_id) REFERENCES public.scaffold_inspections(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: guardrails guardrails_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.guardrails
      ADD CONSTRAINT guardrails_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: guardrails guardrails_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.guardrails
      ADD CONSTRAINT guardrails_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: integration_connections integration_connections_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.integration_connections
      ADD CONSTRAINT integration_connections_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: integration_mappings integration_mappings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.integration_mappings
      ADD CONSTRAINT integration_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_items inventory_items_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_items
      ADD CONSTRAINT inventory_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_locations inventory_locations_branch_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_locations
      ADD CONSTRAINT inventory_locations_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES public.branches(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_locations inventory_locations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_locations
      ADD CONSTRAINT inventory_locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_locations inventory_locations_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_locations
      ADD CONSTRAINT inventory_locations_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_locations inventory_locations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_locations
      ADD CONSTRAINT inventory_locations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movement_photos inventory_movement_photos_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movement_photos
      ADD CONSTRAINT inventory_movement_photos_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movement_photos inventory_movement_photos_inventory_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movement_photos
      ADD CONSTRAINT inventory_movement_photos_inventory_movement_id_fkey FOREIGN KEY (inventory_movement_id) REFERENCES public.inventory_movements(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_company_id_from_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_company_id_from_location_id_fkey FOREIGN KEY (company_id, from_location_id) REFERENCES public.inventory_locations(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_company_id_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_company_id_inventory_item_id_fkey FOREIGN KEY (company_id, inventory_item_id) REFERENCES public.inventory_items(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_company_id_to_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_company_id_to_location_id_fkey FOREIGN KEY (company_id, to_location_id) REFERENCES public.inventory_locations(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_movements inventory_movements_worker_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_movements
      ADD CONSTRAINT inventory_movements_worker_fk FOREIGN KEY (company_id, worker_id) REFERENCES public.workers(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_service_tickets inventory_service_tickets_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_service_tickets
      ADD CONSTRAINT inventory_service_tickets_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: inventory_service_tickets inventory_service_tickets_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.inventory_service_tickets
      ADD CONSTRAINT inventory_service_tickets_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES public.inventory_items(id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_contracts job_rental_contracts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_contracts
      ADD CONSTRAINT job_rental_contracts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_contracts job_rental_contracts_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_contracts
      ADD CONSTRAINT job_rental_contracts_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_contracts job_rental_contracts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_contracts
      ADD CONSTRAINT job_rental_contracts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_lines job_rental_lines_company_id_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_lines
      ADD CONSTRAINT job_rental_lines_company_id_contract_id_fkey FOREIGN KEY (company_id, contract_id) REFERENCES public.job_rental_contracts(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_lines job_rental_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_lines
      ADD CONSTRAINT job_rental_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: job_rental_lines job_rental_lines_company_id_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.job_rental_lines
      ADD CONSTRAINT job_rental_lines_company_id_inventory_item_id_fkey FOREIGN KEY (company_id, inventory_item_id) REFERENCES public.inventory_items(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_entries labor_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_entries
      ADD CONSTRAINT labor_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_entries labor_entries_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_entries
      ADD CONSTRAINT labor_entries_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_entries labor_entries_payroll_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_entries
      ADD CONSTRAINT labor_entries_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES public.labor_payroll_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_entries labor_entries_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_entries
      ADD CONSTRAINT labor_entries_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_entries labor_entries_review_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_entries
      ADD CONSTRAINT labor_entries_review_run_id_fkey FOREIGN KEY (review_run_id) REFERENCES public.time_review_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_entries labor_entries_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_entries
      ADD CONSTRAINT labor_entries_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_payroll_runs labor_payroll_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_payroll_runs
      ADD CONSTRAINT labor_payroll_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: labor_payroll_runs labor_payroll_runs_time_review_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.labor_payroll_runs
      ADD CONSTRAINT labor_payroll_runs_time_review_run_id_fkey FOREIGN KEY (time_review_run_id) REFERENCES public.time_review_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: material_bills material_bills_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.material_bills
      ADD CONSTRAINT material_bills_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: material_bills material_bills_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.material_bills
      ADD CONSTRAINT material_bills_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: material_bills material_bills_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.material_bills
      ADD CONSTRAINT material_bills_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: mesh_trace_forward_state mesh_trace_forward_state_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.mesh_trace_forward_state
      ADD CONSTRAINT mesh_trace_forward_state_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: message_reads message_reads_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.message_reads
      ADD CONSTRAINT message_reads_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: message_reads message_reads_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.message_reads
      ADD CONSTRAINT message_reads_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: mutation_outbox mutation_outbox_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.mutation_outbox
      ADD CONSTRAINT mutation_outbox_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: notification_preferences notification_preferences_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.notification_preferences
      ADD CONSTRAINT notification_preferences_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: notifications notifications_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.notifications
      ADD CONSTRAINT notifications_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: payroll_exports payroll_exports_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.payroll_exports
      ADD CONSTRAINT payroll_exports_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: payroll_exports payroll_exports_company_id_payroll_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.payroll_exports
      ADD CONSTRAINT payroll_exports_company_id_payroll_run_id_fkey FOREIGN KEY (company_id, payroll_run_id) REFERENCES public.labor_payroll_runs(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: pricing_profiles pricing_profiles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.pricing_profiles
      ADD CONSTRAINT pricing_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_assignments project_assignments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_assignments
      ADD CONSTRAINT project_assignments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_assignments project_assignments_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_assignments
      ADD CONSTRAINT project_assignments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_billing_milestones project_billing_milestones_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_billing_milestones
      ADD CONSTRAINT project_billing_milestones_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_billing_milestones project_billing_milestones_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_billing_milestones
      ADD CONSTRAINT project_billing_milestones_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_briefs project_briefs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_briefs
      ADD CONSTRAINT project_briefs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_briefs project_briefs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_briefs
      ADD CONSTRAINT project_briefs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_lost_reasons project_lost_reasons_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_lost_reasons
      ADD CONSTRAINT project_lost_reasons_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_lost_reasons project_lost_reasons_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_lost_reasons
      ADD CONSTRAINT project_lost_reasons_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_messages project_messages_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_messages
      ADD CONSTRAINT project_messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_messages project_messages_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_messages
      ADD CONSTRAINT project_messages_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_pricing_overrides project_pricing_overrides_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_pricing_overrides
      ADD CONSTRAINT project_pricing_overrides_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: project_pricing_overrides project_pricing_overrides_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.project_pricing_overrides
      ADD CONSTRAINT project_pricing_overrides_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: projects projects_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.projects
      ADD CONSTRAINT projects_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: projects projects_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.projects
      ADD CONSTRAINT projects_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: push_subscriptions push_subscriptions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.push_subscriptions
      ADD CONSTRAINT push_subscriptions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: qbo_custom_field_mappings qbo_custom_field_mappings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.qbo_custom_field_mappings
      ADD CONSTRAINT qbo_custom_field_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: qbo_sync_runs qbo_sync_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.qbo_sync_runs
      ADD CONSTRAINT qbo_sync_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: qbo_sync_runs qbo_sync_runs_integration_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.qbo_sync_runs
      ADD CONSTRAINT qbo_sync_runs_integration_connection_id_fkey FOREIGN KEY (integration_connection_id) REFERENCES public.integration_connections(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_run_lines rental_billing_run_lines_company_id_billing_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_run_lines
      ADD CONSTRAINT rental_billing_run_lines_company_id_billing_run_id_fkey FOREIGN KEY (company_id, billing_run_id) REFERENCES public.rental_billing_runs(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_run_lines rental_billing_run_lines_company_id_contract_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_run_lines
      ADD CONSTRAINT rental_billing_run_lines_company_id_contract_line_id_fkey FOREIGN KEY (company_id, contract_line_id) REFERENCES public.job_rental_lines(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_run_lines rental_billing_run_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_run_lines
      ADD CONSTRAINT rental_billing_run_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_run_lines rental_billing_run_lines_company_id_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_run_lines
      ADD CONSTRAINT rental_billing_run_lines_company_id_inventory_item_id_fkey FOREIGN KEY (company_id, inventory_item_id) REFERENCES public.inventory_items(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_runs rental_billing_runs_company_id_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_runs
      ADD CONSTRAINT rental_billing_runs_company_id_contract_id_fkey FOREIGN KEY (company_id, contract_id) REFERENCES public.job_rental_contracts(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_runs rental_billing_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_runs
      ADD CONSTRAINT rental_billing_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_runs rental_billing_runs_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_runs
      ADD CONSTRAINT rental_billing_runs_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_billing_runs rental_billing_runs_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_billing_runs
      ADD CONSTRAINT rental_billing_runs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_rate_tiers rental_rate_tiers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_rate_tiers
      ADD CONSTRAINT rental_rate_tiers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_rate_tiers rental_rate_tiers_job_rental_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_rate_tiers
      ADD CONSTRAINT rental_rate_tiers_job_rental_line_id_fkey FOREIGN KEY (job_rental_line_id) REFERENCES public.job_rental_lines(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_requests rental_requests_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_requests
      ADD CONSTRAINT rental_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_requests rental_requests_converted_rental_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_requests
      ADD CONSTRAINT rental_requests_converted_rental_id_fkey FOREIGN KEY (converted_rental_id) REFERENCES public.rentals(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_requests rental_requests_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_requests
      ADD CONSTRAINT rental_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_requests rental_requests_share_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_requests
      ADD CONSTRAINT rental_requests_share_link_id_fkey FOREIGN KEY (share_link_id) REFERENCES public.rental_share_links(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_share_links rental_share_links_company_id_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_share_links
      ADD CONSTRAINT rental_share_links_company_id_customer_id_fkey FOREIGN KEY (company_id, customer_id) REFERENCES public.customers(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_share_links rental_share_links_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_share_links
      ADD CONSTRAINT rental_share_links_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_share_links rental_share_links_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_share_links
      ADD CONSTRAINT rental_share_links_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rental_vendors rental_vendors_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rental_vendors
      ADD CONSTRAINT rental_vendors_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rentals rentals_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rentals
      ADD CONSTRAINT rentals_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rentals rentals_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rentals
      ADD CONSTRAINT rentals_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rentals rentals_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rentals
      ADD CONSTRAINT rentals_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rentals rentals_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rentals
      ADD CONSTRAINT rentals_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: rentals rentals_transferred_from_rental_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.rentals
      ADD CONSTRAINT rentals_transferred_from_rental_id_fkey FOREIGN KEY (transferred_from_rental_id) REFERENCES public.rentals(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_inspections scaffold_inspections_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_inspections
      ADD CONSTRAINT scaffold_inspections_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_inspections scaffold_inspections_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_inspections
      ADD CONSTRAINT scaffold_inspections_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_inspections scaffold_inspections_company_id_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_inspections
      ADD CONSTRAINT scaffold_inspections_company_id_tag_id_fkey FOREIGN KEY (company_id, tag_id) REFERENCES public.scaffold_tags(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_manufacturers scaffold_manufacturers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_manufacturers
      ADD CONSTRAINT scaffold_manufacturers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_systems scaffold_systems_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_systems
      ADD CONSTRAINT scaffold_systems_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_systems scaffold_systems_manufacturer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_systems
      ADD CONSTRAINT scaffold_systems_manufacturer_id_fkey FOREIGN KEY (manufacturer_id) REFERENCES public.scaffold_manufacturers(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_tags scaffold_tags_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_tags
      ADD CONSTRAINT scaffold_tags_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: scaffold_tags scaffold_tags_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.scaffold_tags
      ADD CONSTRAINT scaffold_tags_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_assemblies service_item_assemblies_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_assemblies
      ADD CONSTRAINT service_item_assemblies_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_assembly_components service_item_assembly_components_assembly_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_assembly_components
      ADD CONSTRAINT service_item_assembly_components_assembly_id_fkey FOREIGN KEY (assembly_id) REFERENCES public.service_item_assemblies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_assembly_components service_item_assembly_components_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_assembly_components
      ADD CONSTRAINT service_item_assembly_components_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_divisions service_item_divisions_company_id_division_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_divisions
      ADD CONSTRAINT service_item_divisions_company_id_division_code_fkey FOREIGN KEY (company_id, division_code) REFERENCES public.divisions(company_id, code) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_divisions service_item_divisions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_divisions
      ADD CONSTRAINT service_item_divisions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_divisions service_item_divisions_company_id_service_item_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_divisions
      ADD CONSTRAINT service_item_divisions_company_id_service_item_code_fkey FOREIGN KEY (company_id, service_item_code) REFERENCES public.service_items(company_id, code) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_item_rate_history service_item_rate_history_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_item_rate_history
      ADD CONSTRAINT service_item_rate_history_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: service_items service_items_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.service_items
      ADD CONSTRAINT service_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_events shipment_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_events
      ADD CONSTRAINT shipment_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_events shipment_events_company_id_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_events
      ADD CONSTRAINT shipment_events_company_id_shipment_id_fkey FOREIGN KEY (company_id, shipment_id) REFERENCES public.shipments(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_lines shipment_lines_company_id_bom_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_lines
      ADD CONSTRAINT shipment_lines_company_id_bom_line_id_fkey FOREIGN KEY (company_id, bom_line_id) REFERENCES public.bom_lines(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_lines shipment_lines_company_id_catalog_part_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_lines
      ADD CONSTRAINT shipment_lines_company_id_catalog_part_id_fkey FOREIGN KEY (company_id, catalog_part_id) REFERENCES public.catalog_parts(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_lines shipment_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_lines
      ADD CONSTRAINT shipment_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_lines shipment_lines_company_id_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_lines
      ADD CONSTRAINT shipment_lines_company_id_inventory_item_id_fkey FOREIGN KEY (company_id, inventory_item_id) REFERENCES public.inventory_items(company_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipment_lines shipment_lines_company_id_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipment_lines
      ADD CONSTRAINT shipment_lines_company_id_shipment_id_fkey FOREIGN KEY (company_id, shipment_id) REFERENCES public.shipments(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipments shipments_company_id_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipments
      ADD CONSTRAINT shipments_company_id_bom_id_fkey FOREIGN KEY (company_id, bom_id) REFERENCES public.boms(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipments shipments_company_id_destination_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipments
      ADD CONSTRAINT shipments_company_id_destination_location_id_fkey FOREIGN KEY (company_id, destination_location_id) REFERENCES public.inventory_locations(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipments shipments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipments
      ADD CONSTRAINT shipments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipments shipments_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipments
      ADD CONSTRAINT shipments_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: shipments shipments_company_id_source_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.shipments
      ADD CONSTRAINT shipments_company_id_source_branch_id_fkey FOREIGN KEY (company_id, source_branch_id) REFERENCES public.branches(company_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: support_debug_packets support_debug_packets_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.support_debug_packets
      ADD CONSTRAINT support_debug_packets_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: support_packet_access_log support_packet_access_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.support_packet_access_log
      ADD CONSTRAINT support_packet_access_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: support_packet_access_log support_packet_access_log_support_packet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.support_packet_access_log
      ADD CONSTRAINT support_packet_access_log_support_packet_id_fkey FOREIGN KEY (support_packet_id) REFERENCES public.support_debug_packets(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: sync_events sync_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.sync_events
      ADD CONSTRAINT sync_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: sync_events sync_events_integration_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.sync_events
      ADD CONSTRAINT sync_events_integration_connection_id_fkey FOREIGN KEY (integration_connection_id) REFERENCES public.integration_connections(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_capture_artifacts takeoff_capture_artifacts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_capture_artifacts
      ADD CONSTRAINT takeoff_capture_artifacts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_capture_artifacts takeoff_capture_artifacts_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_capture_artifacts
      ADD CONSTRAINT takeoff_capture_artifacts_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.takeoff_drafts(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_conditions takeoff_conditions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_conditions
      ADD CONSTRAINT takeoff_conditions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_conditions takeoff_conditions_default_assembly_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_conditions
      ADD CONSTRAINT takeoff_conditions_default_assembly_fk FOREIGN KEY (default_assembly_id) REFERENCES public.service_item_assemblies(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_drafts takeoff_drafts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_drafts takeoff_drafts_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_drafts takeoff_drafts_measured_blueprint_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_measured_blueprint_document_id_fkey FOREIGN KEY (measured_blueprint_document_id) REFERENCES public.blueprint_documents(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurement_tags takeoff_measurement_tags_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurement_tags
      ADD CONSTRAINT takeoff_measurement_tags_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurement_tags takeoff_measurement_tags_measurement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurement_tags
      ADD CONSTRAINT takeoff_measurement_tags_measurement_id_fkey FOREIGN KEY (measurement_id) REFERENCES public.takeoff_measurements(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_assembly_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_assembly_fk FOREIGN KEY (assembly_id) REFERENCES public.service_item_assemblies(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_blueprint_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_blueprint_document_id_fkey FOREIGN KEY (blueprint_document_id) REFERENCES public.blueprint_documents(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_company_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_company_id_project_id_fkey FOREIGN KEY (company_id, project_id) REFERENCES public.projects(company_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_condition_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_condition_fk FOREIGN KEY (condition_id) REFERENCES public.takeoff_conditions(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.takeoff_drafts(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.blueprint_pages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: takeoff_measurements takeoff_measurements_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: time_review_runs time_review_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.time_review_runs
      ADD CONSTRAINT time_review_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: time_review_runs time_review_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.time_review_runs
      ADD CONSTRAINT time_review_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: worker_issue_attachments worker_issue_attachments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.worker_issue_attachments
      ADD CONSTRAINT worker_issue_attachments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: worker_issue_attachments worker_issue_attachments_worker_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.worker_issue_attachments
      ADD CONSTRAINT worker_issue_attachments_worker_issue_id_fkey FOREIGN KEY (worker_issue_id) REFERENCES public.worker_issues(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: worker_issues worker_issues_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.worker_issues
      ADD CONSTRAINT worker_issues_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: worker_issues worker_issues_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.worker_issues
      ADD CONSTRAINT worker_issues_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: worker_issues worker_issues_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.worker_issues
      ADD CONSTRAINT worker_issues_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: workers workers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.workers
      ADD CONSTRAINT workers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: workflow_event_log workflow_event_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.workflow_event_log
      ADD CONSTRAINT workflow_event_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;


--
-- Name: ai_insights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;

--
-- Name: asset_deployments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset_deployments ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: blueprint_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blueprint_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: blueprint_page_diffs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blueprint_page_diffs ENABLE ROW LEVEL SECURITY;

--
-- Name: blueprint_pages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blueprint_pages ENABLE ROW LEVEL SECURITY;

--
-- Name: bom_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bom_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: boms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.boms ENABLE ROW LEVEL SECURITY;

--
-- Name: bonus_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bonus_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: branches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

--
-- Name: broadcasts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_snapshot_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_snapshot_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: capture_artifacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capture_artifacts ENABLE ROW LEVEL SECURITY;

--
-- Name: capture_session_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capture_session_events ENABLE ROW LEVEL SECURITY;

--
-- Name: capture_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capture_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: catalog_parts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.catalog_parts ENABLE ROW LEVEL SECURITY;

--
-- Name: change_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.change_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: clerk_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clerk_users ENABLE ROW LEVEL SECURITY;

--
-- Name: clerk_users clerk_users_global; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS clerk_users_global ON public.clerk_users;
CREATE POLICY clerk_users_global ON public.clerk_users USING (true) WITH CHECK (true);


--
-- Name: clock_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clock_events ENABLE ROW LEVEL SECURITY;

--
-- Name: company_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: company_invites company_invites_company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_invites_company_isolation ON public.company_invites;
CREATE POLICY company_invites_company_isolation ON public.company_invites USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: ai_insights company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.ai_insights;
CREATE POLICY company_isolation ON public.ai_insights USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: asset_deployments company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.asset_deployments;
CREATE POLICY company_isolation ON public.asset_deployments USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: audit_events company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.audit_events;
CREATE POLICY company_isolation ON public.audit_events USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: blueprint_documents company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.blueprint_documents;
CREATE POLICY company_isolation ON public.blueprint_documents USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: blueprint_page_diffs company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.blueprint_page_diffs;
CREATE POLICY company_isolation ON public.blueprint_page_diffs USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: blueprint_pages company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.blueprint_pages;
CREATE POLICY company_isolation ON public.blueprint_pages USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: bom_lines company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.bom_lines;
CREATE POLICY company_isolation ON public.bom_lines USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: boms company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.boms;
CREATE POLICY company_isolation ON public.boms USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: bonus_rules company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.bonus_rules;
CREATE POLICY company_isolation ON public.bonus_rules USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: branches company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.branches;
CREATE POLICY company_isolation ON public.branches USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: broadcasts company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.broadcasts;
CREATE POLICY company_isolation ON public.broadcasts USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: budget_snapshot_lines company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.budget_snapshot_lines;
CREATE POLICY company_isolation ON public.budget_snapshot_lines USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: budget_snapshots company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.budget_snapshots;
CREATE POLICY company_isolation ON public.budget_snapshots USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: capture_artifacts company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.capture_artifacts;
CREATE POLICY company_isolation ON public.capture_artifacts USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: capture_session_events company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.capture_session_events;
CREATE POLICY company_isolation ON public.capture_session_events USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: capture_sessions company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.capture_sessions;
CREATE POLICY company_isolation ON public.capture_sessions USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: catalog_parts company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.catalog_parts;
CREATE POLICY company_isolation ON public.catalog_parts USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: change_orders company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.change_orders;
CREATE POLICY company_isolation ON public.change_orders USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: clock_events company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.clock_events;
CREATE POLICY company_isolation ON public.clock_events USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: company_memberships company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.company_memberships;
CREATE POLICY company_isolation ON public.company_memberships USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: company_pricing_overrides company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.company_pricing_overrides;
CREATE POLICY company_isolation ON public.company_pricing_overrides USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: companycam_photo_imports company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.companycam_photo_imports;
CREATE POLICY company_isolation ON public.companycam_photo_imports USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: context_handoff_events company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.context_handoff_events;
CREATE POLICY company_isolation ON public.context_handoff_events USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: context_work_items company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.context_work_items;
CREATE POLICY company_isolation ON public.context_work_items USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: cost_library_items company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.cost_library_items;
CREATE POLICY company_isolation ON public.cost_library_items USING (((public.app_current_company_id() IS NULL) OR (company_id IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: crew_schedules company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.crew_schedules;
CREATE POLICY company_isolation ON public.crew_schedules USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: customer_portal_links company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.customer_portal_links;
CREATE POLICY company_isolation ON public.customer_portal_links USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: customer_pricing_overrides company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.customer_pricing_overrides;
CREATE POLICY company_isolation ON public.customer_pricing_overrides USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: customers company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.customers;
CREATE POLICY company_isolation ON public.customers USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: daily_log_photos company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.daily_log_photos;
CREATE POLICY company_isolation ON public.daily_log_photos USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: daily_logs company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.daily_logs;
CREATE POLICY company_isolation ON public.daily_logs USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: damage_charges company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.damage_charges;
CREATE POLICY company_isolation ON public.damage_charges USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: divisions company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.divisions;
CREATE POLICY company_isolation ON public.divisions USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: estimate_lines company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.estimate_lines;
CREATE POLICY company_isolation ON public.estimate_lines USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: estimate_push_lines company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.estimate_push_lines;
CREATE POLICY company_isolation ON public.estimate_push_lines USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: estimate_pushes company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.estimate_pushes;
CREATE POLICY company_isolation ON public.estimate_pushes USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: estimate_share_links company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.estimate_share_links;
CREATE POLICY company_isolation ON public.estimate_share_links USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: external_rentals company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.external_rentals;
CREATE POLICY company_isolation ON public.external_rentals USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: guardrails company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.guardrails;
CREATE POLICY company_isolation ON public.guardrails USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: integration_connections company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.integration_connections;
CREATE POLICY company_isolation ON public.integration_connections USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: integration_mappings company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.integration_mappings;
CREATE POLICY company_isolation ON public.integration_mappings USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: inventory_items company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.inventory_items;
CREATE POLICY company_isolation ON public.inventory_items USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: inventory_locations company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.inventory_locations;
CREATE POLICY company_isolation ON public.inventory_locations USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: inventory_movement_photos company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.inventory_movement_photos;
CREATE POLICY company_isolation ON public.inventory_movement_photos USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: inventory_movements company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.inventory_movements;
CREATE POLICY company_isolation ON public.inventory_movements USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: inventory_service_tickets company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.inventory_service_tickets;
CREATE POLICY company_isolation ON public.inventory_service_tickets USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: job_rental_contracts company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.job_rental_contracts;
CREATE POLICY company_isolation ON public.job_rental_contracts USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: job_rental_lines company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.job_rental_lines;
CREATE POLICY company_isolation ON public.job_rental_lines USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: labor_entries company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.labor_entries;
CREATE POLICY company_isolation ON public.labor_entries USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: labor_payroll_runs company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.labor_payroll_runs;
CREATE POLICY company_isolation ON public.labor_payroll_runs USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: material_bills company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.material_bills;
CREATE POLICY company_isolation ON public.material_bills USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: mesh_trace_forward_state company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.mesh_trace_forward_state;
CREATE POLICY company_isolation ON public.mesh_trace_forward_state USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: message_reads company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.message_reads;
CREATE POLICY company_isolation ON public.message_reads USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: mutation_outbox company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.mutation_outbox;
CREATE POLICY company_isolation ON public.mutation_outbox USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: notification_preferences company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.notification_preferences;
CREATE POLICY company_isolation ON public.notification_preferences USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: notifications company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.notifications;
CREATE POLICY company_isolation ON public.notifications USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: payroll_exports company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.payroll_exports;
CREATE POLICY company_isolation ON public.payroll_exports USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: pricing_profiles company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.pricing_profiles;
CREATE POLICY company_isolation ON public.pricing_profiles USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: project_assignments company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.project_assignments;
CREATE POLICY company_isolation ON public.project_assignments USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: project_billing_milestones company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.project_billing_milestones;
CREATE POLICY company_isolation ON public.project_billing_milestones USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: project_briefs company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.project_briefs;
CREATE POLICY company_isolation ON public.project_briefs USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: project_lost_reasons company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.project_lost_reasons;
CREATE POLICY company_isolation ON public.project_lost_reasons USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: project_messages company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.project_messages;
CREATE POLICY company_isolation ON public.project_messages USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: project_pricing_overrides company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.project_pricing_overrides;
CREATE POLICY company_isolation ON public.project_pricing_overrides USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: projects company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.projects;
CREATE POLICY company_isolation ON public.projects USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: push_subscriptions company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.push_subscriptions;
CREATE POLICY company_isolation ON public.push_subscriptions USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: qbo_custom_field_mappings company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.qbo_custom_field_mappings;
CREATE POLICY company_isolation ON public.qbo_custom_field_mappings USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: qbo_sync_runs company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.qbo_sync_runs;
CREATE POLICY company_isolation ON public.qbo_sync_runs USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: rental_billing_run_lines company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.rental_billing_run_lines;
CREATE POLICY company_isolation ON public.rental_billing_run_lines USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: rental_billing_runs company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.rental_billing_runs;
CREATE POLICY company_isolation ON public.rental_billing_runs USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: rental_rate_tiers company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.rental_rate_tiers;
CREATE POLICY company_isolation ON public.rental_rate_tiers USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: rental_requests company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.rental_requests;
CREATE POLICY company_isolation ON public.rental_requests USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: rental_share_links company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.rental_share_links;
CREATE POLICY company_isolation ON public.rental_share_links USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: rental_vendors company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.rental_vendors;
CREATE POLICY company_isolation ON public.rental_vendors USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: rentals company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.rentals;
CREATE POLICY company_isolation ON public.rentals USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: scaffold_inspections company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.scaffold_inspections;
CREATE POLICY company_isolation ON public.scaffold_inspections USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: scaffold_tags company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.scaffold_tags;
CREATE POLICY company_isolation ON public.scaffold_tags USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: service_item_assemblies company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.service_item_assemblies;
CREATE POLICY company_isolation ON public.service_item_assemblies USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: service_item_assembly_components company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.service_item_assembly_components;
CREATE POLICY company_isolation ON public.service_item_assembly_components USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: service_item_divisions company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.service_item_divisions;
CREATE POLICY company_isolation ON public.service_item_divisions USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: service_item_rate_history company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.service_item_rate_history;
CREATE POLICY company_isolation ON public.service_item_rate_history USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: service_items company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.service_items;
CREATE POLICY company_isolation ON public.service_items USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: shipment_events company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.shipment_events;
CREATE POLICY company_isolation ON public.shipment_events USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: shipment_lines company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.shipment_lines;
CREATE POLICY company_isolation ON public.shipment_lines USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: shipments company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.shipments;
CREATE POLICY company_isolation ON public.shipments USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: support_debug_packets company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.support_debug_packets;
CREATE POLICY company_isolation ON public.support_debug_packets USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: support_packet_access_log company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.support_packet_access_log;
CREATE POLICY company_isolation ON public.support_packet_access_log USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: sync_events company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.sync_events;
CREATE POLICY company_isolation ON public.sync_events USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: takeoff_capture_artifacts company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.takeoff_capture_artifacts;
CREATE POLICY company_isolation ON public.takeoff_capture_artifacts USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: takeoff_conditions company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.takeoff_conditions;
CREATE POLICY company_isolation ON public.takeoff_conditions USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: takeoff_drafts company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.takeoff_drafts;
CREATE POLICY company_isolation ON public.takeoff_drafts USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: takeoff_measurement_tags company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.takeoff_measurement_tags;
CREATE POLICY company_isolation ON public.takeoff_measurement_tags USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: takeoff_measurements company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.takeoff_measurements;
CREATE POLICY company_isolation ON public.takeoff_measurements USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: time_review_runs company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.time_review_runs;
CREATE POLICY company_isolation ON public.time_review_runs USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: worker_issue_attachments company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.worker_issue_attachments;
CREATE POLICY company_isolation ON public.worker_issue_attachments USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: worker_issues company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.worker_issues;
CREATE POLICY company_isolation ON public.worker_issues USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: workers company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.workers;
CREATE POLICY company_isolation ON public.workers USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: workflow_event_log company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_isolation ON public.workflow_event_log;
CREATE POLICY company_isolation ON public.workflow_event_log USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: company_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: company_pricing_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_pricing_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: company_usage_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_usage_log ENABLE ROW LEVEL SECURITY;

--
-- Name: company_usage_log company_usage_log_company_scope; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS company_usage_log_company_scope ON public.company_usage_log;
CREATE POLICY company_usage_log_company_scope ON public.company_usage_log USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: companycam_photo_imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companycam_photo_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: context_handoff_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.context_handoff_events ENABLE ROW LEVEL SECURITY;

--
-- Name: context_work_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.context_work_items ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_library_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cost_library_items ENABLE ROW LEVEL SECURITY;

--
-- Name: crew_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crew_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_role_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custom_role_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_role_grants custom_role_grants_company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS custom_role_grants_company_isolation ON public.custom_role_grants;
CREATE POLICY custom_role_grants_company_isolation ON public.custom_role_grants USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: custom_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custom_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_roles custom_roles_company_isolation; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS custom_roles_company_isolation ON public.custom_roles;
CREATE POLICY custom_roles_company_isolation ON public.custom_roles USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));


--
-- Name: customer_portal_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_portal_links ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_pricing_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_pricing_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_log_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_log_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: damage_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.damage_charges ENABLE ROW LEVEL SECURITY;

--
-- Name: divisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.divisions ENABLE ROW LEVEL SECURITY;

--
-- Name: estimate_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimate_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: estimate_push_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimate_push_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: estimate_pushes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimate_pushes ENABLE ROW LEVEL SECURITY;

--
-- Name: estimate_share_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimate_share_links ENABLE ROW LEVEL SECURITY;

--
-- Name: external_rentals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.external_rentals ENABLE ROW LEVEL SECURITY;

--
-- Name: guardrails; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guardrails ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_movement_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_movement_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_service_tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_service_tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: job_rental_contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_rental_contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: job_rental_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_rental_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: labor_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.labor_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: labor_payroll_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.labor_payroll_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: material_bills; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.material_bills ENABLE ROW LEVEL SECURITY;

--
-- Name: mesh_trace_forward_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mesh_trace_forward_state ENABLE ROW LEVEL SECURITY;

--
-- Name: message_reads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: mutation_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mutation_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_exports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_exports ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: project_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: project_billing_milestones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_billing_milestones ENABLE ROW LEVEL SECURITY;

--
-- Name: project_briefs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_briefs ENABLE ROW LEVEL SECURITY;

--
-- Name: project_lost_reasons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_lost_reasons ENABLE ROW LEVEL SECURITY;

--
-- Name: project_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: project_pricing_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_pricing_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: qbo_custom_field_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qbo_custom_field_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: qbo_sync_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.qbo_sync_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_billing_run_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_billing_run_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_billing_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_billing_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_rate_tiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_rate_tiers ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_share_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_share_links ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_vendors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_vendors ENABLE ROW LEVEL SECURITY;

--
-- Name: rentals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rentals ENABLE ROW LEVEL SECURITY;

--
-- Name: scaffold_inspections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scaffold_inspections ENABLE ROW LEVEL SECURITY;

--
-- Name: scaffold_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scaffold_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: service_item_assemblies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_item_assemblies ENABLE ROW LEVEL SECURITY;

--
-- Name: service_item_assembly_components; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_item_assembly_components ENABLE ROW LEVEL SECURITY;

--
-- Name: service_item_divisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_item_divisions ENABLE ROW LEVEL SECURITY;

--
-- Name: service_item_rate_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_item_rate_history ENABLE ROW LEVEL SECURITY;

--
-- Name: service_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_items ENABLE ROW LEVEL SECURITY;

--
-- Name: shipment_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;

--
-- Name: shipment_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipment_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: shipments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;

--
-- Name: support_debug_packets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_debug_packets ENABLE ROW LEVEL SECURITY;

--
-- Name: support_packet_access_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_packet_access_log ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_events ENABLE ROW LEVEL SECURITY;

--
-- Name: takeoff_capture_artifacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.takeoff_capture_artifacts ENABLE ROW LEVEL SECURITY;

--
-- Name: takeoff_conditions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.takeoff_conditions ENABLE ROW LEVEL SECURITY;

--
-- Name: takeoff_drafts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.takeoff_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: takeoff_measurement_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.takeoff_measurement_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: takeoff_measurements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.takeoff_measurements ENABLE ROW LEVEL SECURITY;

--
-- Name: time_review_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.time_review_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_issue_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_issue_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_issues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_issues ENABLE ROW LEVEL SECURITY;

--
-- Name: workers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_event_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_event_log ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict AifUTOhIr5PzRIODeId1c2MBhK1BVTm0jwFwOkF6dfo9e3MScwlaObDimc5bU7X

