-- 009_work_item_domain_and_platform_grants.sql — the capability-permissions
-- foundation: split context_work_items into two non-bleeding domains and add the
-- opt-in platform-admin capability grants table.
--
-- WHY a `domain` column. context_work_items is the single triage ledger behind
-- two structurally different problem spaces that must never share authority:
--
--   * app_issue    — problems with the sitelayer SOFTWARE itself. PLATFORM
--                    scope, cross-tenant, internal. These rows are born from the
--                    capture dock (capture-sessions.ts / portal-capture-sessions.ts
--                    finalize), where capture_session_id IS NOT NULL.
--   * field_request — contractor operational problems/requests on a real job.
--                    COMPANY scope, per-tenant business feature. These rows are
--                    born from the WorkRequestAction / field_event flow
--                    (work-requests.ts createContextWorkItemTx).
--
-- The capability layer (packages/domain/src/capabilities.ts,
-- apps/api/src/capability.ts) gates app_issue.* ONLY on the platform boundary
-- (superadmin ∪ platform_admin_grants) and field_request.* ONLY on the company
-- boundary (role defaults ∪ custom_role_grants). The `domain` column is the row
-- the consumers will gate on. NOT NULL with a default of 'field_request' so the
-- WorkRequestAction path keeps working unchanged; the capture finalize writers
-- stamp 'app_issue' explicitly in the same change.
--
-- BACKFILL is exact: every existing capture-born row (capture_session_id IS NOT
-- NULL) is an app-issue; everything else is a field-request (the DEFAULT already
-- covers new rows, the UPDATE fixes the historical capture rows). The CHECK pins
-- the two-value union so a typo can never invent a third domain.
--
-- WHY platform_admin_grants. Superadmins implicitly hold all app_issue.* caps
-- (admin-auth.ts isSuperadmin). This table is the OPT-IN escape hatch: a
-- (clerk_user_id, capability) row grants exactly one app_issue.* capability to a
-- non-superadmin platform person without a redeploy — the same shape as the
-- existing `platform_admins` allowlist table, and platform-scope like it, so it
-- needs no RLS (it is cross-tenant by construction, keyed on the Clerk subject,
-- never company-scoped). The composite PK makes a grant idempotent.
--
-- Additive only: one NOT NULL column with a safe default + backfill, one index,
-- one new table. No destructive change.

ALTER TABLE public.context_work_items
    ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'field_request';

-- Pin the two-value union. Guarded so a re-run is a no-op (the catalog name
-- prefix matches the existing context_work_items_*_check constraints).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'context_work_items_domain_check'
    ) THEN
        ALTER TABLE public.context_work_items
            ADD CONSTRAINT context_work_items_domain_check
            CHECK (domain IN ('app_issue', 'field_request'));
    END IF;
END
$$;

-- Backfill the historical capture-born rows to app_issue. New rows take the
-- DEFAULT (field_request) and the capture finalize writers stamp app_issue
-- explicitly, so this only ever touches pre-migration rows.
UPDATE public.context_work_items
   SET domain = 'app_issue'
 WHERE capture_session_id IS NOT NULL
   AND domain <> 'app_issue';

-- The board/list reads filter by (company_id, domain) newest-first.
CREATE INDEX IF NOT EXISTS context_work_items_company_domain_created_idx
    ON public.context_work_items (company_id, domain, created_at DESC);

-- Opt-in platform-admin capability grants. Platform-scope (cross-tenant, keyed
-- on the Clerk subject), so no RLS — same trust boundary as platform_admins.
CREATE TABLE IF NOT EXISTS public.platform_admin_grants (
    clerk_user_id text NOT NULL,
    capability text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (clerk_user_id, capability)
);
