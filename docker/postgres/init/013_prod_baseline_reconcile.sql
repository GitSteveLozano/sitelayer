-- 013_prod_baseline_reconcile.sql — reconcile the historically-migrated prod
-- schema with the rebaselined repo baseline (000_baseline.sql). STRICTLY
-- ADDITIVE + IDEMPOTENT.
--
-- WHY. The current prod database (DO managed Postgres `sitelayer_prod`) was
-- migrated forward through the pre-squash history and then re-marked against
-- the squashed baseline + 001..012. A read-only schema-parity audit
-- (scripts/audit-pg-schema-parity.sh, re-verified directly with to_regclass())
-- found exactly TWO safe-to-ADD objects that the rebaselined baseline declares
-- but that were never created on the historically-migrated prod:
--
--   1. The ENTIRE `feedback_invites` collaborator-portal table (and all of its
--      dependents: PK, UNIQUE(token_id), FK to companies ON DELETE CASCADE,
--      the six CHECK constraints, the three indexes, RLS ENABLE + FORCE, the
--      company-isolation policy, and the table COMMENT). to_regclass(
--      'public.feedback_invites') is NULL on prod.
--   2. The partial UNIQUE index `context_work_items_request_ref_uidx`. The
--      table `context_work_items` IS present on prod (and its sibling
--      `context_work_items_company_dedup_key_uidx` from migration 012 exists),
--      but this particular request_ref partial unique index is absent.
--
-- This is the exact baseline-vs-prod drift that migration 011 already guards
-- behind `to_regclass('public.feedback_invites') IS NOT NULL` — on prod, 011's
-- `last_accessed_at` / `access_count` ALTERs were CORRECTLY SKIPPED because the
-- table did not exist. 011 has already run on prod and will NOT re-run, so this
-- reconciliation creates `feedback_invites` WITH those two audit columns baked
-- directly into the CREATE TABLE. That leaves prod with the SAME final shape a
-- fresh-from-init database has after applying 000_baseline + 011 (baseline
-- table + 011's two audit columns). Do NOT touch 011.
--
-- WHAT (additive only):
--   * CREATE TABLE IF NOT EXISTS public.feedback_invites — every column from
--     000_baseline.sql plus last_accessed_at + access_count (migration 011),
--     plus the six inline CHECK constraints, copied verbatim from the baseline.
--   * Guarded ADD CONSTRAINT for the PK, the token_id UNIQUE, and the FK to
--     companies (same DO/EXCEPTION idiom the baseline uses, so re-running on a
--     DB that already has them is a clean no-op).
--   * CREATE INDEX IF NOT EXISTS for the three feedback_invites indexes.
--   * ALTER TABLE ... ENABLE / FORCE ROW LEVEL SECURITY (idempotent flag sets)
--     + DROP POLICY IF EXISTS / CREATE POLICY for the company-isolation policy
--     (the baseline's own idempotent idiom).
--   * COMMENT ON TABLE (idempotent).
--   * CREATE UNIQUE INDEX IF NOT EXISTS context_work_items_request_ref_uidx.
--
-- IDEMPOTENCY / NO-OP CONTRACT. On a fresh-from-init database (which already
-- has all of these from 000_baseline + 011) every statement here is a no-op:
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS skip; the guarded
-- ADD CONSTRAINT blocks swallow the duplicate-object errors; ENABLE/FORCE RLS
-- re-set the same flag; DROP POLICY IF EXISTS + CREATE POLICY re-create the
-- identical policy; COMMENT re-sets the identical comment. On prod (table
-- absent) it ADDS the missing objects. NEVER drops, renames, retypes, or
-- alters any existing data.
--
-- NOT TOUCHED HERE (operator-gated / not real drift — see the agent report):
--   * The pgcrypto extension that exists on prod but is not declared by the
--     baseline (harmless legacy of the pre-squash history).
--   * The schema_migrations ledger table (created by scripts/migrate-db.sh,
--     not by init/).
--   * The created_at column physical-ordinal difference on mutation_outbox /
--     sync_events (a benign pg_dump column-ORDER artifact; the column sets are
--     byte-identical — same name/type/default/nullability — NOT fixable, and
--     NOT fixed, by a forward migration).
--   * The 000_baseline.sql ledger checksum mismatch (a re-mark-applied /
--     reconcile concern, handled out-of-band under operator approval, NOT part
--     of this additive forward migration).

-- ---------------------------------------------------------------------------
-- feedback_invites — table. Columns copied verbatim from 000_baseline.sql,
-- with last_accessed_at + access_count (migration 011) baked in so prod, where
-- 011 already ran and skipped the table, ends up with the complete shape.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.feedback_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    token_id text NOT NULL,
    token_kid text DEFAULT 'default'::text NOT NULL,
    reviewer_ref text DEFAULT 'collaborator'::text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    target_route text,
    allowed_capture_modes text[] DEFAULT ARRAY['text'::text, 'state'::text] NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL,
    revoked_at timestamp with time zone,
    created_by_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_accessed_at timestamp with time zone,
    access_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT feedback_invites_allowed_capture_modes_nonempty CHECK ((array_length(allowed_capture_modes, 1) >= 1)),
    CONSTRAINT feedback_invites_allowed_capture_modes_valid CHECK ((allowed_capture_modes <@ ARRAY['text'::text, 'audio'::text, 'screen'::text, 'trace'::text, 'state'::text])),
    CONSTRAINT feedback_invites_reviewer_ref_nonempty CHECK ((btrim(reviewer_ref) <> ''::text)),
    CONSTRAINT feedback_invites_source_nonempty CHECK ((btrim(source) <> ''::text)),
    CONSTRAINT feedback_invites_token_id_min_length CHECK ((length(token_id) >= 16)),
    CONSTRAINT feedback_invites_token_kid_valid CHECK ((token_kid ~ '^[A-Za-z0-9_-]{1,64}$'::text))
);

-- feedback_invites — primary key.
DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.feedback_invites
      ADD CONSTRAINT feedback_invites_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;

-- feedback_invites — token_id uniqueness.
DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.feedback_invites
      ADD CONSTRAINT feedback_invites_token_id_key UNIQUE (token_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;

-- feedback_invites — FK to companies (ON DELETE CASCADE).
DO $baseline_con$ BEGIN
  ALTER TABLE ONLY public.feedback_invites
      ADD CONSTRAINT feedback_invites_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;
END $baseline_con$;

-- feedback_invites — indexes.
CREATE INDEX IF NOT EXISTS feedback_invites_active_idx ON public.feedback_invites USING btree (company_id, expires_at) WHERE (revoked_at IS NULL);
CREATE INDEX IF NOT EXISTS feedback_invites_company_idx ON public.feedback_invites USING btree (company_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_invites_token_idx ON public.feedback_invites USING btree (token_id);

-- feedback_invites — row-level security (per-company isolation). ENABLE + FORCE
-- are idempotent flag sets; DROP POLICY IF EXISTS + CREATE POLICY is the
-- baseline's own re-runnable idiom.
ALTER TABLE public.feedback_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.feedback_invites FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feedback_invites_company_isolation ON public.feedback_invites;
CREATE POLICY feedback_invites_company_isolation ON public.feedback_invites USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id()))) WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));

-- feedback_invites — table comment.
COMMENT ON TABLE public.feedback_invites IS 'Signed collaborator feedback links. token_id/token_kid identify the HMAC token; the full token is never listed back to admins after creation.';

-- ---------------------------------------------------------------------------
-- context_work_items — request_ref partial unique index (from 000_baseline.sql).
-- The table and its sibling dedup-key index (migration 012) already exist on
-- prod; only this request_ref partial unique index was missing.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS context_work_items_request_ref_uidx ON public.context_work_items USING btree (company_id, ((metadata ->> 'request_ref'::text))) WHERE ((metadata ->> 'request_ref'::text) IS NOT NULL);
