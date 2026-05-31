-- 119_tenant_provisions.sql
--
-- Tenant provision — the durable, replayable workflow row for new-tenant
-- bootstrap (company create → admin membership → seed starter data).
-- Lifts the most consequential multi-step external write in the product
-- out of the onboarding screen's hand-rolled Promise.allSettled into a
-- first-class workflow row fed through the reducer in
-- packages/workflows/src/tenant-provision.ts.
--
-- Expand/backfill/contract: PURELY ADDITIVE. New table + new outbox
-- mutation_types (create_company / invite_member / seed_tenant_defaults)
-- + new worker drains. No change to companies / company_memberships
-- schema. New code tolerates the absence of any in-flight provision (the
-- legacy mutateAsync onboarding path can run behind a flag during
-- rollout). workflow_event_log already exists.
--
-- States (see tenant-provision.ts):
--   company_pending → company_created → seeding → provisioned
--                                     → partially_seeded → provisioned
--   company_pending → failed (recoverable) → company_pending (retry)
--   company_created / partially_seeded / failed → abandoned
--
-- Events:
--   CREATE_COMPANY   (human)       company_pending|failed → company_pending
--   COMPANY_CREATED  (worker-only) company_pending → company_created
--   COMPANY_REJECTED (worker-only) company_pending → failed
--   INVITE_MEMBER    (human)       company_created → company_created
--   MEMBER_INVITED   (worker-only) company_created → company_created
--   SEED_REQUESTED   (human)       company_created|partially_seeded → seeding
--   SEED_COMPLETED   (worker-only) seeding → provisioned
--   SEED_PARTIAL     (worker-only) seeding → partially_seeded
--   SKIP_SEED        (human)       company_created → provisioned
--   FINISH           (human)       partially_seeded → provisioned
--   ABANDON          (human)       → abandoned
--
-- `company_id` is NULLABLE on purpose: the company does not exist until
-- the COMPANY_CREATED worker event lands. It is set (and FK-validated at
-- the application layer, not via a NOT NULL FK) once the company row is
-- created.

CREATE TABLE IF NOT EXISTS tenant_provisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  status text NOT NULL DEFAULT 'company_pending',
  state_version int NOT NULL DEFAULT 1,

  -- The requested company identity (set at CREATE_COMPANY; corrected on
  -- a failed→retry with a suggested slug).
  slug text,
  name text,

  -- Populated by the COMPANY_CREATED worker event. NULLable: no company
  -- exists in company_pending / failed.
  company_id uuid,

  -- The seed batch request (customer / worker / yard names) captured at
  -- SEED_REQUESTED. Drives the seed_tenant_defaults worker drain.
  seed_request jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Optional teammate invites recorded at INVITE_MEMBER.
  invited jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Seed kinds that failed on a SEED_PARTIAL transition (cleared on a
  -- retry SEED_REQUESTED / SEED_COMPLETED). Replaces the screen's
  -- hand-rolled "Seeded everything except: …" string.
  failed_seeds jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Recoverable company-create failure payload (COMPANY_REJECTED).
  error text,
  suggested_slug text,

  -- Who started the provision (Clerk user id).
  created_by text,

  workflow_engine text NOT NULL DEFAULT 'postgres',
  workflow_run_id text,

  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_provisions_status_idx
  ON tenant_provisions (status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tenant_provisions_company_idx
  ON tenant_provisions (company_id)
  WHERE company_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tenant_provisions_created_by_idx
  ON tenant_provisions (created_by, created_at DESC)
  WHERE deleted_at IS NULL;
