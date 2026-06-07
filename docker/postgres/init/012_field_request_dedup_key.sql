-- 012_field_request_dedup_key.sql — per-actor content-fingerprint idempotency for
-- field_request creation, so a company member cannot flood their own tenant with
-- duplicate field_requests via rapid retries / double-submits.
--
-- WHY. POST /api/work-requests already honors a CLIENT-SUPPLIED idempotency key
-- (`client_request_id` / `Idempotency-Key` header) and an optional `request_ref`,
-- but a well-meaning client that retries WITHOUT supplying one — or a malicious
-- authed tenant member that just spams the button — mints a fresh
-- context_work_items row (support packet + work item + handoff event + projectkit
-- Concern snapshot) every time. That is unbounded same-tenant spam and a
-- non-idempotent create under client retry.
--
-- WHAT. A nullable `dedup_key text` column on context_work_items plus a UNIQUE
-- partial index on (company_id, dedup_key). The field_request create path
-- (apps/api/src/routes/work-requests.ts createWorkRequest) computes a
-- server-derived dedup_key = sha256(company_id | actor_user_id | entity_type |
-- entity_id | normalized-title | normalized-summary | coarse-time-bucket) and
-- inserts with ON CONFLICT (company_id, dedup_key) DO NOTHING, so two identical
-- creates in the same coarse window collapse to ONE row and the second returns
-- the EXISTING item (idempotent), even under a concurrent race (the unique index
-- is the authority, the app-level pre-check is just the fast path).
--
-- WHY a coarse time bucket (not a forever-unique fingerprint). We want to dedupe
-- a burst of identical retries, NOT permanently forbid a contractor from filing
-- the same-worded problem on the same entity weeks apart (a legitimate recurrence).
-- The bucket bounds the dedup to a short window; distinct content / entity / actor
-- always produces a distinct key and a distinct row.
--
-- SCOPE. app_issue rows (capture-born, platform scope) NEVER set dedup_key — the
-- capture finalize writers do not pass it — so this column stays NULL for them and
-- the partial index ignores them entirely. The two non-bleeding domains are
-- unaffected.
--
-- Additive only: one nullable column + one partial unique index. No backfill, no
-- destructive change. Existing rows keep dedup_key = NULL and are excluded from
-- the unique index by the WHERE clause.

ALTER TABLE public.context_work_items
    ADD COLUMN IF NOT EXISTS dedup_key text;

-- Per-(company, dedup_key) uniqueness. Partial so historical / app_issue rows
-- with NULL dedup_key never collide and the index stays small (only field_request
-- rows that opted into server-derived dedup are indexed). This is the authority
-- that collapses concurrent duplicate creates: ON CONFLICT DO NOTHING fires here.
CREATE UNIQUE INDEX IF NOT EXISTS context_work_items_company_dedup_key_uidx
    ON public.context_work_items (company_id, dedup_key)
    WHERE dedup_key IS NOT NULL;
